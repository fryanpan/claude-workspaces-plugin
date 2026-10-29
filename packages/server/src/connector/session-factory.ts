/**
 * How the shared server builds one hosted connector.
 *
 * The connector is the same code the stdio child runs (packages/mcp's
 * connector-session.ts) with two seams set differently:
 *
 *  - **REST goes over loopback, as a real fetch.** Every tool handler speaks
 *    REST to the server, and the server's gates for those routes read the
 *    peer address: an in-process call has none, so the loopback-only routes
 *    (the agent token mint among them) would refuse their own server. A
 *    loopback socket is what the child used, and it keeps every gate exactly
 *    as it was.
 *  - **The event stream is opened in-process.** A hosted connector's one
 *    subscription is the same `/events/agent/<id>` stream the child dialled,
 *    built by the same function, but handed back as a Response without a
 *    socket. Two properties follow. It needs no bearer — the caller is this
 *    process, already behind `/mcp`'s gate — so there is no token mint in
 *    front of it. And it is synchronous up to the event bus: the connector's
 *    `openEvents` reaches `fetch` before its first await, and the stream
 *    registers its sinks inside the Response constructor. That is what lets
 *    the server subscribe a restored agent before it answers its first
 *    request, rather than racing it.
 *
 * A session opened on a board's socket (`spec.boardId`) is built with two
 * changes, both so that it reaches that board and no other. Every REST call
 * carries a board agent token for that agent and board, which the server
 * mints and keeps here, in its own process (`board-token-lease.ts`), and
 * which the admission door holds to the board like any other `at2`. A call
 * to any origin but the server's own is refused, so the token never leaves
 * it. And the event stream carries only the watch keys on that board.
 */
import { createConnectorSession } from '../../../mcp/src/connector-session.ts';
import type { ConnectorSession } from '../../../mcp/src/connector-session.ts';
import { loopbackFetch } from '../outbound-fetch.ts';
import type { HostedSessionSpec } from './host.ts';

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Opens one agent's multiplexed event stream in this process: every key it
 * watches, or with `boardId` only the keys on that board.
 */
export type OpenAgentEvents = (
  agentId: string,
  lastEventId: string | null,
  boardId?: string,
) => Response;

/** A board agent token held for one hosted session (`board-token-lease.ts`). */
export interface BoardTokenLease {
  /** The current value, minted or renewed as needed. Null when none can be had. */
  token(): string | null;
  /** Revoke it; the session is gone. */
  release(): void;
}

const AGENT_EVENTS_PATH = /\/events\/agent\/([^/?#]+)$/;

/**
 * A fetch that answers the agent event route in-process and nothing else.
 *
 * The body is wrapped so an abort reaches the stream: a socket fetch ends its
 * body when the signal fires, and the connector's reconnect loop relies on
 * that to stop. Cancelling the inner reader runs the stream's own cancel,
 * which removes its sinks from the bus.
 */
export function inProcessEventsFetch(open: OpenAgentEvents): Fetch {
  return async (url, init) => {
    const match = new URL(url).pathname.match(AGENT_EVENTS_PATH);
    if (!match) return new Response('not found', { status: 404 });
    const signal = init?.signal ?? null;
    if (signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
    const lastEventId = new Headers(init?.headers).get('last-event-id');
    const res = open(decodeURIComponent(match[1] ?? ''), lastEventId);
    if (!res.body) return res;
    const reader = res.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) controller.close();
          else controller.enqueue(value);
        } catch (err) {
          controller.error(err);
        }
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    });
    signal?.addEventListener('abort', () => void reader.cancel().catch(() => {}), { once: true });
    return new Response(body, { status: res.status, headers: res.headers });
  };
}

export interface SessionFactoryDeps {
  /** The server's own loopback origin. Read per request: the port is bound
   *  after the factory is built. */
  baseUrl: () => string;
  openAgentEvents: OpenAgentEvents;
  /** Mints an agent's token in-process. A hosted session's REST calls come
   *  from the server's own process, and the loopback mint refuses that
   *  caller, so the token is handed over here instead. */
  mintAgentToken?: (agentId: string) => string;
  log: (...args: unknown[]) => void;
  /** The REST fetch. Defaults to the global one. */
  fetch?: Fetch;
  /** A board token for a session opened on a board's socket. Without it such
   *  a session's REST calls are refused, never sent without one. */
  boardToken?: (agentId: string, boardId: string) => BoardTokenLease;
}

/**
 * The REST fetch of a session held to one board: the board token on every
 * call, replacing whatever authorization the connector set, and a 403 for any
 * origin but the server's own.
 */
export function boardScopedFetch(
  inner: Fetch,
  baseUrl: () => string,
  lease: BoardTokenLease | null,
): Fetch {
  const refuse = (error: string) =>
    new Response(JSON.stringify({ error }), {
      status: 403,
      headers: { 'content-type': 'application/json' },
    });
  return async (url, init) => {
    if (new URL(url).origin !== new URL(baseUrl()).origin) return refuse('board_session_origin');
    const token = lease?.token() ?? null;
    if (token === null) return refuse('board_session_no_token');
    const headers = new Headers(init?.headers);
    headers.set('authorization', `Bearer ${token}`);
    return inner(url, { ...init, headers });
  };
}

export function hostedSessionFactory(
  deps: SessionFactoryDeps,
): (spec: HostedSessionSpec) => ConnectorSession {
  const eventsFetch = inProcessEventsFetch(deps.openAgentEvents);
  const restFetch: Fetch = deps.fetch ?? loopbackFetch('own-server');
  return (spec) => {
    const boardId = spec.boardId;
    if (boardId === undefined) {
      return createConnectorSession({
        ...common(spec),
        fetch: restFetch,
        eventsFetch,
        ...(deps.mintAgentToken
          ? { mintAgentToken: async () => deps.mintAgentToken?.(spec.author.id) ?? null }
          : {}),
      });
    }
    const lease = deps.boardToken?.(spec.author.id, boardId) ?? null;
    const session = createConnectorSession({
      ...common(spec),
      fetch: boardScopedFetch(restFetch, deps.baseUrl, lease),
      eventsFetch: inProcessEventsFetch((agentId, lastEventId) =>
        deps.openAgentEvents(agentId, lastEventId, boardId),
      ),
      // The agent's own token is never minted for it: the board token is
      // what every call carries.
      mintAgentToken: async () => null,
    });
    return {
      ...session,
      stop() {
        session.stop();
        lease?.release();
      },
    };
  };

  function common(spec: HostedSessionSpec) {
    return {
      author: spec.author,
      cwd: spec.cwd,
      defaultWorkspaceId: spec.defaultWorkspaceId,
      pluginVersion: spec.pluginVersion,
      processId: spec.processId,
      notify: spec.notify,
      resolveBaseUrl: deps.baseUrl,
      eventsNeedToken: false,
      log: deps.log,
    };
  }
}
