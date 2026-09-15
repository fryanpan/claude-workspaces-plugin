/**
 * The shared server's MCP endpoint: every agent's connector, hosted in this
 * process instead of in a child Claude Code spawns per session.
 *
 * TWO TABLES. A *session* is one MCP connection — an `Mcp-Session-Id`, handed
 * out on initialize. An *identity* is one agent in one working directory, and
 * owns the things that must outlive a connection: the hosted connector (its
 * watches, its dedup window, its one event subscription) and the outbox its
 * pushes wait in. Sessions come and go under an identity; a respawned Claude
 * Code session is a new session on the same identity, so it finds its
 * subscription already open and nothing broadcast in between is lost.
 *
 * WHO GETS A PUSH. The outbox writes each push to one stream: that of the
 * session initialized most recently, holding the push while that session has
 * yet to open its GET. A session stops being the target when its stream ends,
 * or when STREAM_GRACE_MS passes without it opening one — a process that
 * initialized and exited must not hold its predecessor's pushes until the
 * sweep. See outbox.ts for why neither the oldest nor the most recently
 * connected is right.
 *
 * A SESSION ID WE HAVE NEVER SEEN. After a restart every id a client holds is
 * unknown here. Claude Code reconnects its GET stream with the old id and does
 * not re-initialize on a failed GET — measured: it retries twice and gives up,
 * leaving the session connected but deaf. So a GET for an unknown id that
 * carries valid identity headers brings the session back under that id, and
 * its stream opens with `tools/list_changed` so the client refetches the list
 * it may have been told was empty. A POST for an unknown id is answered 404,
 * which the client does handle: it re-initializes.
 *
 * WHAT IS NOT HERE. The path, the gate and the share-visitor refusal are the
 * route's (routes/mcp-connector.ts). Building a connector — its REST fetch and
 * its in-process event stream — is session-factory.ts. This module is the two
 * tables and the protocol between them.
 */
import { randomUUID } from 'node:crypto';
import type { AgentAuthor } from '../../../mcp/src/author.ts';
import type { ChannelNotification } from '../../../mcp/src/channel-messages.ts';
import { CONNECTOR_INSTRUCTIONS } from '../../../mcp/src/connector-instructions.ts';
import type { ConnectorSession } from '../../../mcp/src/connector-session.ts';
import { createSseStreamWriter } from '../sse-writer.ts';
import { answerSessionMessage } from './answer.ts';
import {
  type ConnectorIdentity,
  type IdentityHeaders,
  headersOf,
  readIdentityHeaders,
  resolveIdentity,
} from './identity.ts';
import { type Outbox, createOutbox, sseFrame } from './outbox.ts';
import {
  RPC,
  type RpcId,
  SSE_HEADERS,
  isInitializeRequest,
  isRecord,
  isSessionIdShape,
  negotiateProtocolVersion,
  rpcErrorResponse,
  rpcIdOf,
  rpcResult,
} from './protocol.ts';

/** What a hosted connector is built from. */
export interface HostedSessionSpec {
  author: AgentAuthor;
  cwd: string;
  processId: string;
  notify: (n: ChannelNotification) => Promise<void>;
  pluginVersion: () => string;
  defaultWorkspaceId: () => string;
}

export interface ConnectorHostDeps {
  createSession: (spec: HostedSessionSpec) => ConnectorSession;
  /** The plugin version to report when the client's headers name none. */
  fallbackPluginVersion: () => string;
  log: (...args: unknown[]) => void;
  now?: () => number;
  epoch?: string;
  newSessionId?: () => string;
  keepaliveMs?: number;
  /** How often idle sessions and identities are swept. 0 disables the timer. */
  sweepEveryMs?: number;
}

export interface ConnectorHost {
  handle(req: Request): Promise<Response>;
  /** Subscribe every identity a previous process was serving, synchronously. */
  restore(identities: IdentityHeaders[]): number;
  /** The identities worth bringing back after a restart. */
  snapshot(): IdentityHeaders[];
  /** Retire idle sessions and identities. Runs on a timer; exposed for tests. */
  sweep(): void;
  counts(): { identities: number; sessions: number; streams: number };
  stop(): void;
}

/** A push waits this long for a stream. Covers a restart with room to spare. */
export const OUTBOX_MAX_AGE_MS = 10 * 60_000;
export const OUTBOX_MAX_FRAMES = 200;
/** What a client is told to wait before reconnecting: long enough to outlast
 *  a restart, so its two GET retries are not spent while the port is closed. */
export const STREAM_RETRY_MS = 15_000;
/** How long a new session holds pushes before its first GET arrives. */
export const STREAM_GRACE_MS = 30_000;
/** A session with no stream and no request for this long is gone. */
export const SESSION_IDLE_MS = 30 * 60_000;
/** An identity with no session for this long stops its subscription. */
export const IDENTITY_IDLE_MS = 60 * 60_000;
/** Larger than any tool argument the REST routes would accept. */
export const BODY_MAX_BYTES = 16 * 1024 * 1024;
const KEEPALIVE_MS = 15_000;
const SWEEP_EVERY_MS = 60_000;

interface HostedIdentity {
  identity: ConnectorIdentity;
  /** The newest headers any of its sessions presented. */
  headers: IdentityHeaders;
  connector: ConnectorSession;
  outbox: Outbox;
  sessions: Set<string>;
  lastSeen: number;
}

interface HostedSession {
  id: string;
  key: string;
  /** When it was initialized, as a counter. Larger is newer. */
  order: number;
  lastSeen: number;
  /** When it was opened, by the clock. */
  openedAt: number;
  /** Whether a GET stream is attached, and whether one ever was. */
  streaming: boolean;
  everStreamed: boolean;
  /** Ends the live GET stream, if there is one. */
  closeStream: (() => void) | null;
}

export function createConnectorHost(deps: ConnectorHostDeps): ConnectorHost {
  const now = deps.now ?? Date.now;
  const epoch = deps.epoch ?? randomUUID().slice(0, 8);
  const newSessionId = deps.newSessionId ?? randomUUID;
  const identities = new Map<string, HostedIdentity>();
  const sessions = new Map<string, HostedSession>();
  let initCounter = 0;

  const gapNotice = () => ({
    jsonrpc: '2.0',
    method: 'notifications/claude/channel',
    params: {
      source: 'claude-workspaces',
      sent_at: new Date(now()).toISOString(),
      content:
        '[replay.gap] events may have been missed while this session was disconnected — refetch state (get_doc / list_threads / next_tasks) rather than assuming the stream was complete',
      meta: { event: 'replay.gap' },
    },
  });

  function identityFor(identity: ConnectorIdentity): HostedIdentity {
    const existing = identities.get(identity.key);
    if (existing) {
      existing.headers = identity.headers;
      existing.lastSeen = now();
      return existing;
    }
    const outbox = createOutbox({
      epoch,
      maxAgeMs: OUTBOX_MAX_AGE_MS,
      maxFrames: OUTBOX_MAX_FRAMES,
      retryMs: STREAM_RETRY_MS,
      now,
      targetOrder: () => targetOrderOf(entry),
      gapNotice,
    });
    const entry = {
      identity,
      headers: identity.headers,
      outbox,
      sessions: new Set<string>(),
      lastSeen: now(),
    } as HostedIdentity;
    entry.connector = deps.createSession({
      author: identity.author,
      cwd: identity.headers.cwd,
      processId: randomUUID(),
      notify: async (n) => {
        outbox.push({ jsonrpc: '2.0', method: n.method, params: n.params });
      },
      pluginVersion: () => entry.headers.pluginVersion ?? deps.fallbackPluginVersion(),
      defaultWorkspaceId: () => entry.headers.workspace ?? '',
    });
    identities.set(identity.key, entry);
    return entry;
  }

  /** The newest session that has a stream or may still open its first. */
  function targetOrderOf(entry: HostedIdentity): number | null {
    let best: number | null = null;
    const t = now();
    for (const sid of entry.sessions) {
      const s = sessions.get(sid);
      if (!s) continue;
      const candidate = s.streaming || (!s.everStreamed && t - s.openedAt < STREAM_GRACE_MS);
      if (candidate && (best === null || s.order > best)) best = s.order;
    }
    return best;
  }

  /** Register a session under the identity its headers name. */
  function openSession(
    headers: IdentityHeaders,
    sid: string,
  ): { ok: true; session: HostedSession; entry: HostedIdentity } | { ok: false; message: string } {
    const resolved = resolveIdentity(headers, sid);
    if (!resolved.ok) return resolved;
    const entry = identityFor(resolved.identity);
    initCounter += 1;
    const session: HostedSession = {
      id: sid,
      key: resolved.identity.key,
      order: initCounter,
      lastSeen: now(),
      openedAt: now(),
      streaming: false,
      everStreamed: false,
      closeStream: null,
    };
    sessions.set(sid, session);
    entry.sessions.add(sid);
    return { ok: true, session, entry };
  }

  function dropSession(session: HostedSession): void {
    session.closeStream?.();
    sessions.delete(session.id);
    const entry = identities.get(session.key);
    if (entry) {
      entry.sessions.delete(session.id);
      entry.lastSeen = now();
      entry.outbox.flush();
    }
  }

  function openStream(
    session: HostedSession,
    entry: HostedIdentity,
    lastEventId: string | null,
    rehydrated: boolean,
  ): Response {
    // One stream per session: a reconnect replaces the one before it, which
    // may not have noticed yet that its reader is gone.
    session.closeStream?.();
    let cleanup: (() => void) | null = null;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const out = createSseStreamWriter(controller);
        if (rehydrated) {
          out.write(
            sseFrame(null, {
              jsonrpc: '2.0',
              method: 'notifications/tools/list_changed',
            }),
          );
        }
        session.streaming = true;
        session.everStreamed = true;
        const detach = entry.outbox.attach(
          { order: session.order, write: (t) => out.write(t) },
          lastEventId,
        );
        const keepalive = setInterval(() => {
          try {
            out.write(':ka\n\n');
            // A target that lapsed (its grace ran out, its stream ended) hands
            // what it was holding to whoever is next.
            entry.outbox.flush();
          } catch {
            cleanup?.();
          }
        }, deps.keepaliveMs ?? KEEPALIVE_MS);
        let done = false;
        cleanup = () => {
          if (done) return;
          done = true;
          detach();
          session.streaming = false;
          clearInterval(keepalive);
          if (session.closeStream === close) session.closeStream = null;
          session.lastSeen = now();
        };
        const close = () => {
          cleanup?.();
          out.close();
        };
        session.closeStream = close;
      },
      cancel() {
        cleanup?.();
      },
    });
    if (rehydrated) void entry.connector.ensureWatchesRestored();
    return new Response(body, { headers: SSE_HEADERS });
  }

  async function handleGet(req: Request): Promise<Response> {
    const sid = req.headers.get('mcp-session-id');
    if (!sid)
      return rpcErrorResponse(
        400,
        RPC.badRequest,
        'Bad Request: Mcp-Session-Id header is required',
      );
    if (!isSessionIdShape(sid))
      return rpcErrorResponse(400, RPC.badRequest, 'Bad Request: malformed Mcp-Session-Id');
    const known = sessions.get(sid);
    if (known) {
      const entry = identities.get(known.key);
      if (entry) {
        known.lastSeen = now();
        return openStream(known, entry, req.headers.get('last-event-id'), false);
      }
    }
    // Unknown: a session the previous process held. Bring it back under the
    // same id, if its headers still say who it is.
    const read = readIdentityHeaders(req.headers);
    if (!read.ok) return rpcErrorResponse(400, RPC.badRequest, read.message);
    const opened = openSession(read.headers, sid);
    if (!opened.ok) return rpcErrorResponse(400, RPC.badRequest, opened.message);
    return openStream(opened.session, opened.entry, req.headers.get('last-event-id'), true);
  }

  const pluginVersionOf = (entry: HostedIdentity) =>
    entry.headers.pluginVersion ?? deps.fallbackPluginVersion();

  function initialize(req: Request, msg: Record<string, unknown>, id: RpcId): Response {
    if (!isInitializeRequest(msg))
      return rpcErrorResponse(400, RPC.invalidRequest, 'Invalid initialize request', id);
    const read = readIdentityHeaders(req.headers);
    if (!read.ok) return rpcErrorResponse(400, RPC.invalidRequest, read.message, id);
    const sid = newSessionId();
    const opened = openSession(read.headers, sid);
    if (!opened.ok) return rpcErrorResponse(400, RPC.invalidRequest, opened.message, id);
    const params = isRecord(msg.params) ? msg.params : {};
    const result = {
      protocolVersion: negotiateProtocolVersion(params.protocolVersion),
      capabilities: {
        tools: { listChanged: true },
        experimental: { 'claude/channel': {} },
      },
      serverInfo: {
        name: 'claude-workspaces',
        version: pluginVersionOf(opened.entry),
      },
      instructions: CONNECTOR_INSTRUCTIONS,
    };
    return Response.json(rpcResult(id, result), {
      headers: { 'mcp-session-id': sid },
    });
  }

  async function handlePost(req: Request): Promise<Response> {
    const declared = Number(req.headers.get('content-length') ?? '0');
    if (declared > BODY_MAX_BYTES)
      return rpcErrorResponse(413, RPC.invalidRequest, 'Request body too large');
    const text = await req.text();
    if (text.length > BODY_MAX_BYTES)
      return rpcErrorResponse(413, RPC.invalidRequest, 'Request body too large');
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return rpcErrorResponse(400, RPC.parseError, 'Parse error');
    }
    const messages = Array.isArray(parsed) ? parsed : [parsed];
    if (messages.length === 0) return rpcErrorResponse(400, RPC.invalidRequest, 'Invalid Request');

    const init = messages.find((m) => isRecord(m) && m.method === 'initialize');
    if (init !== undefined) {
      const id = rpcIdOf(init);
      if (messages.length !== 1 || id === undefined) {
        return rpcErrorResponse(
          400,
          RPC.invalidRequest,
          'initialize must be sent alone, as a request',
        );
      }
      return initialize(req, init as Record<string, unknown>, id);
    }

    const sid = req.headers.get('mcp-session-id');
    if (!sid)
      return rpcErrorResponse(
        400,
        RPC.badRequest,
        'Bad Request: Mcp-Session-Id header is required',
      );
    const session = sessions.get(sid);
    const entry = session ? identities.get(session.key) : undefined;
    if (!session || !entry) return rpcErrorResponse(404, RPC.sessionNotFound, 'Session not found');
    session.lastSeen = now();
    entry.lastSeen = now();

    const answers: Record<string, unknown>[] = [];
    for (const m of messages) {
      const a = await answerSessionMessage(m, entry.connector, deps.log);
      if (a) answers.push(a);
    }
    if (answers.length === 0) return new Response(null, { status: 202 });
    return Response.json(Array.isArray(parsed) ? answers : answers[0]);
  }

  function handleDelete(req: Request): Response {
    const sid = req.headers.get('mcp-session-id');
    const session = sid ? sessions.get(sid) : undefined;
    if (!session) return rpcErrorResponse(404, RPC.sessionNotFound, 'Session not found');
    dropSession(session);
    return new Response(null, { status: 200 });
  }

  function sweep(): void {
    const t = now();
    for (const session of [...sessions.values()]) {
      if (session.closeStream === null && t - session.lastSeen > SESSION_IDLE_MS)
        dropSession(session);
    }
    for (const [key, entry] of [...identities]) {
      if (entry.sessions.size === 0 && t - entry.lastSeen > IDENTITY_IDLE_MS) {
        entry.connector.stop();
        identities.delete(key);
      }
    }
  }

  const sweepEvery = deps.sweepEveryMs ?? SWEEP_EVERY_MS;
  const sweepTimer = sweepEvery > 0 ? setInterval(sweep, sweepEvery) : null;
  // Never what keeps a process alive.
  (sweepTimer as { unref?: () => void } | null)?.unref?.();

  return {
    async handle(req) {
      switch (req.method) {
        case 'POST':
          return handlePost(req);
        case 'GET':
          return handleGet(req);
        case 'DELETE':
          return handleDelete(req);
        default:
          return new Response('method not allowed', {
            status: 405,
            headers: { allow: 'GET, POST, DELETE' },
          });
      }
    },

    restore(list) {
      let opened = 0;
      for (const saved of list) {
        // Re-read through the header validation, so a hand-edited snapshot
        // gets exactly the checks a request would.
        const read = readIdentityHeaders(headersOf(saved));
        if (!read.ok) continue;
        const resolved = resolveIdentity(read.headers, 'restore');
        if (!resolved.ok || resolved.identity.shared || identities.has(resolved.identity.key))
          continue;
        const entry = identityFor(resolved.identity);
        // Synchronous up to the event bus registration: see session-factory.ts.
        void entry.connector.openEvents();
        opened += 1;
      }
      return opened;
    },

    snapshot() {
      return [...identities.values()].filter((e) => !e.identity.shared).map((e) => e.headers);
    },

    sweep,

    counts() {
      let streams = 0;
      for (const s of sessions.values()) if (s.closeStream) streams += 1;
      return { identities: identities.size, sessions: sessions.size, streams };
    },

    stop() {
      if (sweepTimer) clearInterval(sweepTimer);
      for (const session of sessions.values()) session.closeStream?.();
      for (const entry of identities.values()) entry.connector.stop();
      sessions.clear();
      identities.clear();
    },
  };
}
