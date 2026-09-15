/**
 * One connector session: everything a single agent's MCP connection holds,
 * built from what it is handed rather than from the process it runs in.
 *
 * This used to be the body of `mcp.ts`, where every piece of it was a
 * module-level constant: the identity came from `process.env`, the working
 * directory from `process.cwd()`, and the notification sink was the one stdio
 * `Server` the file connected at the bottom. That was right while one process
 * served one session. The shared server's `/mcp` endpoint hosts many sessions
 * in one process, so each needs its own copy of every map, window and queue
 * below — a dedup window shared between two agents would hide one agent's
 * comment because the other had already seen it.
 *
 * So the wiring moved here unchanged and the process-wide reads became
 * parameters. `mcp.ts` builds exactly one of these from its environment; the
 * server builds one per agent and working directory.
 *
 * The declaration order matters in one place: `http` is used by nearly
 * everything, so it is built first, and the tool context is still built per
 * call — see `toolContext` below.
 */
import type { CallToolRequest, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createAgentTokenStore } from './agent-token.ts';
import { createAttachmentKeepalive } from './attachment-keepalive.ts';
import { createAttachments } from './attachments.ts';
import type { AgentAuthor } from './author.ts';
import { type ToolContext, createCallToolHandler } from './call-tool.ts';
import { type ChannelNotification, createChannelMessages } from './channel-messages.ts';
import { createDeferredEmitter } from './deferred-emit.ts';
import { createFrameDedup } from './frame-dedup.ts';
import { createFrameHandler } from './frame-handler.ts';
import { createHttp, err, ok } from './http-client.ts';
import { createMuxLoop } from './mux-loop.ts';
import { type Watcher, createSseLoops } from './sse-loop.ts';
import { TOOL_LIST } from './tool-schemas.ts';
import { handleDocsTool } from './tools/docs.ts';
import { handleTaskTool } from './tools/tasks.ts';
import { handleWorkspaceTool } from './tools/workspace.ts';
import { SHARED_IDENTITY_REASON, createWatchRegistry, isSharedIdentity } from './watch-registry.ts';
import { createWatchRestore } from './watch-restore.ts';

/** What `post_status` accepts — the server's `NOTE_TEXT_MAX`
 *  (packages/server/src/agent-notes.ts), which refuses anything longer.
 *  Spelled here because the bundle imports nothing from the server. */
const STATUS_TEXT_MAX = 4000;

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface ConnectorSessionDeps {
  /** Who this session is. Resolved by the host — from env in the stdio child,
   *  from request headers in the shared server. */
  author: AgentAuthor;
  /** The session's working directory, sent as `owner` on every bind. */
  cwd: string;
  /** The board a bare `post_status` lands on; empty when none was given. */
  defaultWorkspaceId: () => string;
  /** Reported on every attach so the board can say which sessions are behind.
   *  Read per use: a hosted session's client can be replaced by one running a
   *  newer plugin without the session being rebuilt. */
  pluginVersion: () => string;
  /** One nonce per session host. See AgentAttachment.processId on the server. */
  processId: string;
  /** Where a channel line goes. */
  notify: (n: ChannelNotification) => Promise<void>;
  /** The feedback server's base URL, resolved per request. */
  resolveBaseUrl: () => string;
  /** The REST fetch. */
  fetch: Fetch;
  /**
   * The fetch the one event stream dials. Defaults to `fetch`. The shared
   * server passes an in-process opener, so its hosted sessions read the event
   * bus without a socket back to themselves.
   */
  eventsFetch?: Fetch;
  /**
   * Whether the event stream presents this agent's bearer. True for a child
   * dialling the server over a socket. The shared server passes false: its
   * opener is in-process and already behind the endpoint's gate, and a mint
   * would put a network round trip in front of the subscription.
   */
  eventsNeedToken?: boolean;
  log: (...args: unknown[]) => void;
}

export interface ConnectorSession {
  readonly author: AgentAuthor;
  /** What `tools/list` answers. The same object for every session. */
  listTools(): typeof TOOL_LIST;
  callTool(req: CallToolRequest): Promise<CallToolResult>;
  /** Ask the server for this identity's watch set and re-wire it. Never
   *  throws; single flight. */
  ensureWatchesRestored(): Promise<void>;
  /**
   * Open the one event stream now, rather than at the first watch. The shared
   * server calls this at boot for every session it is bringing back, before
   * it answers a request, so nothing broadcast after boot is missed.
   */
  openEvents(): Promise<boolean>;
  /** Close the event stream and every per-key loop. */
  stop(): void;
}

export function createConnectorSession(deps: ConnectorSessionDeps): ConnectorSession {
  const AUTHOR = deps.author;
  const IDENTITY_IS_SHARED = isSharedIdentity(AUTHOR.id);
  const log = deps.log;

  /** The {id,name,color} subset of AUTHOR a `suggest: true` route call needs —
   *  suggestions are attributed per-agent from the same identity every other
   *  MCP call uses, not a shared "agent" identity. */
  const suggestionAuthor = () => ({ id: AUTHOR.id, name: AUTHOR.name, color: AUTHOR.color });

  /**
   * This session's proof that it is AUTHOR and not some other agent whose
   * name happens to be readable on the board. See agent-token.ts — fetched
   * once, held for the session, and never fatal.
   */
  const agentTokens = createAgentTokenStore({
    agentId: AUTHOR.id,
    resolveBaseUrl: deps.resolveBaseUrl,
    fetch: deps.fetch,
    log,
    identityIsShared: IDENTITY_IS_SHARED,
  });

  /** The REST call every tool goes through; throws on a non-2xx. */
  const http = createHttp(deps.resolveBaseUrl, deps.fetch, (path) => agentTokens.headersFor(path));

  /**
   * Channel frames produced from inside a tool call, held until it has
   * answered. See deferred-emit.ts for the 2026-08-20 measurement.
   */
  const deferredEmits = createDeferredEmitter();

  /** See attachments.ts — the heartbeat rides real tool calls because that is
   *  the only honest evidence this agent is alive AND working. */
  const { markAttached, sendDueHeartbeats, claimNoticeFor } = createAttachments({
    http,
    author: AUTHOR,
    keepalive: createAttachmentKeepalive(),
  });

  /** Shared across every stream in this session — see frame-dedup.ts. */
  const shouldForwardFrame = createFrameDedup();

  /** The channel renderers — see channel-messages.ts. */
  const channel = createChannelMessages({ notify: deps.notify, http, authorId: AUTHOR.id });

  /** See frame-handler.ts for the ordering it keeps. */
  const handleFrame = createFrameHandler({
    notify: deps.notify,
    emitChannelMessage: (event, payload) => channel.emitChannelMessage(event, payload),
    http,
    shouldForward: (event, payload) => shouldForwardFrame.shouldForward(event, payload),
    // Every channel write waits for the in-flight tool call to answer first —
    // see `defer` in frame-handler.ts for the measured loss this closes.
    defer: (fn) => deferredEmits.emitOutsideToolCall(fn),
  });

  const watchers = new Map<string, Watcher>();
  const timers = {
    set: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clear: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>),
  };
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  /** The per-key loops, for the two cases the one stream cannot serve. */
  const { startSseLoop } = createSseLoops({
    watchers,
    resolveBaseUrl: deps.resolveBaseUrl,
    fetch: deps.fetch,
    handleFrame,
    resetDedup: () => shouldForwardFrame.reset(),
    log,
    sleep,
    timers,
  });

  /** This session's ONE event stream — see mux-loop.ts. */
  const muxLoop = createMuxLoop({
    watchers,
    agentId: AUTHOR.id,
    resolveBaseUrl: deps.resolveBaseUrl,
    fetch: deps.eventsFetch ?? deps.fetch,
    handleFrame,
    resetDedup: () => shouldForwardFrame.reset(),
    log,
    sleep,
    timers,
    ...(deps.eventsNeedToken === false
      ? {}
      : { authHeaders: () => agentTokens.headers(), forgetToken: () => agentTokens.forget() }),
  });

  /** See watch-registry.ts. */
  const registry = createWatchRegistry({
    watchers,
    http,
    author: AUTHOR,
    startSseLoop,
    mux: muxLoop,
    identityIsShared: IDENTITY_IS_SHARED,
    log,
  });

  /** See watch-restore.ts. */
  const restore = createWatchRestore({
    http,
    registry,
    watchers,
    author: AUTHOR,
    get pluginVersion() {
      return deps.pluginVersion();
    },
    processId: deps.processId,
    markAttached,
    notify: deps.notify,
    emitChannelMessage: (event, payload) => channel.emitChannelMessage(event, payload),
    shouldForward: (event, payload) => shouldForwardFrame.shouldForward(event, payload),
    deferredEmits,
    identityIsShared: IDENTITY_IS_SHARED,
  });

  /**
   * The slice of this session the domain handlers in `tools/` read. Built per
   * tool call: the restore state and the last persist error are snapshots as
   * of the start of the call, which is what `list_watched_docs` reports.
   */
  const toolContext = (): ToolContext => ({
    http,
    ok,
    err,
    AUTHOR,
    CWD: deps.cwd,
    DEFAULT_WORKSPACE_ID: deps.defaultWorkspaceId(),
    PLUGIN_VERSION: deps.pluginVersion(),
    PROCESS_ID: deps.processId,
    markAttached,
    STATUS_TEXT_MAX,
    suggestionAuthor,
    resolveBaseUrl: deps.resolveBaseUrl,
    watchers,
    watchDoc: registry.watchDoc,
    watchWorkspace: registry.watchWorkspace,
    unwatchDoc: registry.unwatchDoc,
    refreshCoverage: registry.refreshCoverage,
    watchPersistenceMode: registry.watchPersistenceMode,
    streamMode: registry.streamMode,
    claimNoticeFor,
    restoreState: restore.state(),
    lastPersistError: registry.lastPersistError(),
    IDENTITY_IS_SHARED,
    SHARED_IDENTITY_REASON,
  });

  /** See call-tool.ts for what runs around every answer. */
  const callTool = createCallToolHandler({
    deferredEmits,
    ensureWatchesRestored: () => restore.ensureWatchesRestored(),
    sendDueHeartbeats: () => sendDueHeartbeats(),
    watchDoc: (docId) => registry.watchDoc(docId),
    toolContext,
    handlers: [handleDocsTool, handleTaskTool, handleWorkspaceTool],
    err,
  });

  return {
    author: AUTHOR,
    listTools: () => TOOL_LIST,
    callTool,
    ensureWatchesRestored: () => restore.ensureWatchesRestored(),
    // A shared identity has no watch set on the server, so there is no one
    // stream to open for it; its watches ride the per-key loops.
    openEvents: () => (IDENTITY_IS_SHARED ? Promise.resolve(false) : muxLoop.ensureOpen()),
    stop: () => {
      muxLoop.stop();
      for (const w of watchers.values()) w.controller.abort();
    },
  };
}
