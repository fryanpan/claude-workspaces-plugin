/**
 * The node relay: a session's MCP child that holds no connector of its own.
 *
 * Claude Code accepts a push — the `notifications/claude/channel` frame that
 * wakes an idle agent — only from a child its session started, so every
 * session keeps one. That child used to be the whole connector (mcp.ts, about
 * 85 MB idle). The server already hosts the same connector at `/mcp`
 * (connector/host.ts, built from the same connector-session.ts), so the child
 * only has to carry bytes: each JSON-RPC line from stdin is POSTed to `/mcp`,
 * the answer is written back, and every message on the session's GET stream
 * is written to stdout as it arrives. What the connector does with a frame —
 * dropping self-authored ones, rendering the channel line, acking addressed
 * rows — happens server-side, in the same code the stdio child ran.
 *
 * The compiled relay (packages/plugin/relay/relay.swift) is this file's twin
 * and follows the same rules; `relay-stdio.test.ts` drives both through one
 * suite. The launcher (bin/claude-workspaces-mcp.sh) picks between them.
 *
 * The rules, each of which is a failure it avoids:
 *
 * - **Identity rides headers.** The values the stdio child read from its
 *   environment go on every request as the `x-cw-*` headers identity.ts reads,
 *   and the agent id is resolved there — never here — so both transports name
 *   an agent the same way.
 * - **Token before initialize.** `/mcp` refuses a named agent without its
 *   token. The relay mints it at `GET /api/agent-token` with the same
 *   headers, so the server resolves the id both calls are about.
 * - **A session that never loses its tools.** If the server cannot be reached
 *   or refuses within `initWaitMs`, initialize is answered here with an empty
 *   tool list and `listChanged`, and the relay keeps trying; when the server
 *   answers it says `notifications/tools/list_changed` and the client refetches.
 * - **Server restarts are invisible.** A POST answered 404 (the server has
 *   never seen this session id) re-initializes with the client's own
 *   initialize request and retries once; the GET stream redials with its
 *   `Last-Event-ID`, which the server answers by bringing the session back.
 * - **A walled lead holds no token.** With `boardSocket` set (main.ts reads
 *   `CW_BOARD_SOCKET`), every request goes over that board's own unix socket
 *   and none mints: the socket names the board, the server holds the session
 *   to it, and the board token the session's tools need stays in the
 *   server's process (packages/server/src/connector/board-token-lease.ts).
 * - **No push lands inside a tool call.** A frame that arrives while a
 *   `tools/call` is waiting is held until that call's answer is written, the
 *   rule deferred-emit.ts keeps for the stdio child (measured 2026-08-20: a
 *   frame written between a tool call's request and response was never seen).
 */
import { resolveBaseUrl } from '../http-client.ts';
import {
  type Rpc,
  SUPPORTED_VERSIONS,
  isRecord,
  neverSent,
  parse,
  refusalText,
  relayIdentityHeaders,
} from './relay-wire.ts';

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface RelayDeps {
  env: Record<string, string | undefined>;
  /** The session's working directory, sent as `x-cw-cwd`. */
  cwd: string;
  homedir: () => string;
  existsSync: (path: string) => boolean;
  readFileSync: (path: string, encoding: 'utf8') => string;
  fetch: Fetch;
  /** Writes one JSON-RPC message to stdout. The relay adds no newline. */
  write: (line: string) => void;
  log: (...args: unknown[]) => void;
  sleep?: (ms: number) => Promise<void>;
  /** How long initialize waits for the server before answering locally. */
  initWaitMs?: number;
  /**
   * The board socket `fetch` dials, when it dials one. The URL's host is then
   * never used, the server's address is never looked up, and no token is
   * minted.
   */
  boardSocket?: string;
}

export interface Relay {
  /** One line from stdin. Never throws; answers are written through `write`. */
  receive(line: string): void;
  /** stdin ended: drop the session on the server, stop the stream. */
  close(): Promise<void>;
}

type Posted =
  | { kind: 'answer'; status: number; body: string; sid: string | null }
  | { kind: 'unreachable'; mayHaveRun: boolean };
const DEFAULT_INIT_WAIT_MS = 10_000;
const RETRY_MAX_MS = 15_000;
/** The server writes `:ka` every 15s; a stream silent for three is dead. */
const STREAM_IDLE_MS = 45_000;

export function createRelay(deps: RelayDeps): Relay {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const identity = relayIdentityHeaders(deps.env, deps.cwd);
  const named = identity['x-cw-agent'] !== undefined || identity['x-cw-agent-legacy'] !== undefined;
  const version = identity['x-cw-plugin-root']?.slice(1) ?? '0.0.0';

  let token: string | null = null;
  let sid: string | null = null;
  let initRequest: string | null = null;
  /** The server's answer to that request, written back to the client. */
  let initAnswer = '';
  let clientInitialized = false;
  let lastReason = 'the claude-workspaces server has not answered yet';
  let lastEventId: string | null = null;
  let streamGen = 0;
  let streamAbort: AbortController | null = null;
  let opening: Promise<boolean> | null = null;
  let reconnecting = false;
  let closed = false;
  let toolCalls = 0;
  const held: string[] = [];

  const base = (): string | null => {
    if (deps.boardSocket !== undefined) return 'http://board-socket';
    try {
      return resolveBaseUrl({ ...deps, env: deps.env }).replace(/\/+$/, '');
    } catch {
      lastReason = 'no claude-workspaces server was found (no discovery file, no CW_BASE_URL)';
      return null;
    }
  };

  const headers = (withSession: boolean): Record<string, string> => ({
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...identity,
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(withSession && sid ? { 'mcp-session-id': sid } : {}),
  });

  const deliver = (line: string) => {
    if (toolCalls > 0) held.push(line);
    else deps.write(line);
  };
  const flushHeld = () => {
    while (toolCalls === 0 && held.length > 0) deps.write(held.shift() as string);
  };

  async function mint(): Promise<void> {
    if (!named || token || deps.boardSocket !== undefined) return;
    const b = base();
    if (!b) return;
    try {
      const res = await deps.fetch(`${b}/api/agent-token`, {
        headers: { accept: 'application/json', ...identity },
      });
      const text = await res.text();
      const j = parse(text);
      if (res.ok && isRecord(j) && typeof j.token === 'string' && j.token) token = j.token;
      else {
        lastReason = refusalText(res.status, text);
        deps.log(`[relay] agent token: ${lastReason}`);
      }
    } catch {
      lastReason = 'the claude-workspaces server is unreachable';
    }
  }

  async function post(body: string, withSession: boolean): Promise<Posted> {
    const b = base();
    if (!b) return { kind: 'unreachable', mayHaveRun: false };
    try {
      const res = await deps.fetch(`${b}/mcp`, {
        method: 'POST',
        headers: headers(withSession),
        body,
      });
      const text = await res.text();
      return {
        kind: 'answer',
        status: res.status,
        body: text,
        sid: res.headers.get('mcp-session-id'),
      };
    } catch (e) {
      lastReason = 'the claude-workspaces server is unreachable';
      return { kind: 'unreachable', mayHaveRun: !neverSent(e) };
    }
  }

  function stopStream(): void {
    streamGen += 1;
    streamAbort?.abort();
    streamAbort = null;
  }

  /** Forget the upstream session, e.g. on a 404; the next open makes a new one. */
  function dropSession(): void {
    sid = null;
    stopStream();
  }

  /** Initialize upstream with the client's own request. Single flight. */
  function openUpstream(): Promise<boolean> {
    opening ??= (async () => {
      if (!initRequest) return false;
      await mint();
      let r = await post(initRequest, false);
      if (r.kind === 'answer' && (r.status === 401 || r.status === 403) && named) {
        token = null;
        await mint();
        r = await post(initRequest, false);
      }
      if (r.kind !== 'answer') return false;
      if (r.status !== 200 || !r.sid) {
        lastReason = refusalText(r.status, r.body);
        return false;
      }
      sid = r.sid;
      initAnswer = r.body;
      if (clientInitialized) {
        await post(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }), true);
        startStream();
      }
      return true;
    })().finally(() => {
      opening = null;
    });
    return opening;
  }

  /** Keep trying to open upstream; say list_changed when it opens. */
  function reconnectInBackground(): void {
    if (reconnecting || closed) return;
    reconnecting = true;
    void (async () => {
      let delay = 1000;
      while (!closed && sid === null) {
        await sleep(delay);
        delay = Math.min(delay * 2, RETRY_MAX_MS);
        if (sid !== null) break;
        if (await openUpstream()) {
          deps.log('[relay] connected to the claude-workspaces server');
          if (clientInitialized) {
            deps.write(
              JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }),
            );
          }
        }
      }
      reconnecting = false;
    })();
  }

  function startStream(): void {
    stopStream();
    const gen = streamGen;
    void (async () => {
      let delay = 1000;
      while (!closed && gen === streamGen && sid !== null) {
        const b = base();
        const ac = new AbortController();
        streamAbort = ac;
        let idle: ReturnType<typeof setTimeout> | null = null;
        const touch = () => {
          if (idle) clearTimeout(idle);
          idle = setTimeout(() => ac.abort(), STREAM_IDLE_MS);
        };
        try {
          if (!b) throw new Error('no server');
          touch();
          const res = await deps.fetch(`${b}/mcp`, {
            method: 'GET',
            headers: {
              ...headers(true),
              accept: 'text/event-stream',
              ...(lastEventId ? { 'last-event-id': lastEventId } : {}),
            },
            signal: ac.signal,
          });
          if (res.status === 200 && res.body) {
            delay = 1000;
            await readEvents(res.body, gen, touch);
          } else {
            await res.text().catch(() => '');
            if ([400, 401, 403, 404].includes(res.status) && gen === streamGen) {
              // The server no longer knows this session, or no longer takes
              // this token: open a new one rather than redialling a refusal.
              if (res.status !== 404) token = null;
              dropSession();
              if (!(await openUpstream())) reconnectInBackground();
              return;
            }
          }
        } catch {
          // Aborted, reset, or refused: redial below unless this stream was replaced.
        } finally {
          if (idle) clearTimeout(idle);
        }
        if (closed || gen !== streamGen) return;
        await sleep(delay);
        delay = Math.min(delay * 2, RETRY_MAX_MS);
      }
    })();
  }

  async function readEvents(
    body: ReadableStream<Uint8Array>,
    gen: number,
    touch: () => void,
  ): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let data: string[] = [];
    let id: string | null = null;
    while (gen === streamGen) {
      const { done, value } = await reader.read();
      if (done) return;
      touch();
      buf += decoder.decode(value, { stream: true });
      let nl = buf.indexOf('\n');
      while (nl >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        nl = buf.indexOf('\n');
        if (line === '') {
          if (id !== null) lastEventId = id;
          if (data.length > 0 && gen === streamGen) deliver(data.join('\n'));
          data = [];
          id = null;
        } else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
        else if (line.startsWith('id:')) id = line.slice(3).trim();
      }
    }
    await reader.cancel().catch(() => {});
  }

  /** What a request is answered with when the server cannot answer it. */
  function unavailable(msg: Rpc, reason: string): string {
    const id = msg.id ?? null;
    const result = (r: unknown) => JSON.stringify({ jsonrpc: '2.0', id, result: r });
    if (msg.method === 'tools/list') return result({ tools: [] });
    if (msg.method === 'ping') return result({});
    if (msg.method === 'tools/call') {
      return result({
        content: [
          {
            type: 'text',
            text: `claude-workspaces relay: ${reason}. It keeps retrying; call the tool again shortly.`,
          },
        ],
        isError: true,
      });
    }
    return JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32603, message: reason } });
  }

  function localInitialize(msg: Rpc): string {
    const params = isRecord(msg.params) ? msg.params : {};
    const asked = params.protocolVersion;
    return JSON.stringify({
      jsonrpc: '2.0',
      id: msg.id ?? null,
      result: {
        protocolVersion:
          typeof asked === 'string' && SUPPORTED_VERSIONS.includes(asked)
            ? asked
            : SUPPORTED_VERSIONS[0],
        capabilities: { tools: { listChanged: true }, experimental: { 'claude/channel': {} } },
        serverInfo: { name: 'claude-workspaces', version },
        instructions: `The claude-workspaces server did not answer when this session started (${lastReason}). Its tools appear here once it does.`,
      },
    });
  }

  async function onInitialize(msg: Rpc, line: string): Promise<void> {
    initRequest = line;
    const deadline = Date.now() + (deps.initWaitMs ?? DEFAULT_INIT_WAIT_MS);
    let delay = 250;
    for (;;) {
      if (await openUpstream()) {
        deps.write(initAnswer.trim());
        return;
      }
      if (Date.now() + delay > deadline) break;
      await sleep(delay);
      delay = Math.min(delay * 2, 2000);
    }
    deps.log(`[relay] answering initialize locally: ${lastReason}`);
    deps.write(localInitialize(msg));
    reconnectInBackground();
  }

  /** POST a message on the session; null when it needs no answer. */
  async function forward(msg: Rpc, line: string): Promise<string | null> {
    const wantsAnswer = typeof msg.method === 'string' && msg.id !== undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (sid === null && !(await openUpstream())) break;
      const r = await post(line, true);
      if (r.kind === 'unreachable') {
        if (r.mayHaveRun) {
          const reason =
            'the connection to the claude-workspaces server dropped mid-request, so the call may or may not have run';
          return wantsAnswer ? unavailable(msg, reason) : null;
        }
        await sleep(500 * (attempt + 1));
        continue;
      }
      if (r.status === 404 || ((r.status === 401 || r.status === 403) && named)) {
        if (r.status !== 404) token = null;
        dropSession();
        continue;
      }
      if (r.status === 202 || r.body.trim() === '') return null;
      const j = parse(r.body);
      if (isRecord(j) && j.jsonrpc === '2.0') return JSON.stringify(j);
      if (Array.isArray(j)) return JSON.stringify(j);
      return wantsAnswer ? unavailable(msg, refusalText(r.status, r.body)) : null;
    }
    if (sid === null) reconnectInBackground();
    return wantsAnswer ? unavailable(msg, lastReason) : null;
  }

  async function handle(line: string): Promise<void> {
    const msg = parse(line);
    if (!isRecord(msg)) {
      if (Array.isArray(msg)) {
        const answer = await forward({}, line);
        if (answer) deps.write(answer);
      } else {
        deps.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id: null,
            error: { code: -32700, message: 'Parse error' },
          }),
        );
      }
      return;
    }
    if (msg.method === 'initialize') return onInitialize(msg, line);
    if (msg.method === 'notifications/initialized') {
      clientInitialized = true;
      if (sid !== null) {
        await post(line, true);
        startStream();
      }
      return;
    }
    const isCall = msg.method === 'tools/call';
    if (isCall) toolCalls += 1;
    try {
      const answer = await forward(msg, line);
      if (answer !== null) deps.write(answer);
    } finally {
      if (isCall) {
        toolCalls -= 1;
        flushHeld();
      }
    }
  }

  return {
    receive(line) {
      if (line.trim() === '') return;
      handle(line).catch((e) => deps.log('[relay] message failed:', e));
    },
    async close() {
      closed = true;
      stopStream();
      const b = base();
      if (sid === null || !b) return;
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 1000);
      try {
        await deps.fetch(`${b}/mcp`, {
          method: 'DELETE',
          headers: headers(true),
          signal: ac.signal,
        });
      } catch {
        // Best effort: the server's sweep retires a session nobody ends.
      } finally {
        clearTimeout(t);
      }
    },
  };
}
