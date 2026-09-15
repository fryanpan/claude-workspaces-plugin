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
 */
import { createConnectorSession } from '../../../mcp/src/connector-session.ts';
import type { ConnectorSession } from '../../../mcp/src/connector-session.ts';
import type { HostedSessionSpec } from './host.ts';

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** Opens one agent's multiplexed event stream in this process. */
export type OpenAgentEvents = (agentId: string, lastEventId: string | null) => Response;

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
  log: (...args: unknown[]) => void;
  /** The REST fetch. Defaults to the global one. */
  fetch?: Fetch;
}

export function hostedSessionFactory(
  deps: SessionFactoryDeps,
): (spec: HostedSessionSpec) => ConnectorSession {
  const eventsFetch = inProcessEventsFetch(deps.openAgentEvents);
  const restFetch: Fetch = deps.fetch ?? ((url, init) => fetch(url, init));
  return (spec) =>
    createConnectorSession({
      author: spec.author,
      cwd: spec.cwd,
      defaultWorkspaceId: spec.defaultWorkspaceId,
      pluginVersion: spec.pluginVersion,
      processId: spec.processId,
      notify: spec.notify,
      resolveBaseUrl: deps.baseUrl,
      fetch: restFetch,
      eventsFetch,
      eventsNeedToken: false,
      log: deps.log,
    });
}
