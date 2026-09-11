/**
 * Agent notes — the pure half of the plugin's Stop and PermissionDenied
 * hooks. Each hook posts one note to
 * `POST /workspaces/{id}/agents/{name}/notes` so a task's
 * Activity tab can say what an agent did lately: the closing message of
 * every turn — the WHOLE message, reduced, not its first line (the owner
 * reads and replies to these on the task, so the short form was a report
 * with its body missing) — and the shape of every tool call auto mode
 * denied.
 *
 * Everything that decides what to post lives here as functions of their
 * inputs (payload, env, clock, fetch); `../stop-note.ts` and
 * `../permission-denied-note.ts` are thin mains around `runHook`. That is
 * what makes the hooks unit-testable without spawning a process — and the
 * hooks run from the INSTALLED plugin (`packages/plugin` alone), so this
 * module imports nothing from the monorepo.
 *
 * Two rules the whole file serves:
 *  - Never block the turn. A hook that throws, hangs, or exits non-zero
 *    stalls the agent that fired it; every path here ends in exit 0, and the
 *    POST is capped at `POST_TIMEOUT_MS`.
 *  - Reduce, never forward. What that means word by word — and every regex
 *    that decides it — is `./note-redact.ts`, which this file reaches
 *    through `fullNote` and `commandShape`. The server stores text verbatim
 *    (its test says so), so that module is the only place the reduction
 *    happens.
 */
import { commandShape, fullNote } from './note-redact.ts';

export type EnvLike = Record<string, string | undefined>;

export type NoteKind = 'turn' | 'denial';

/** The wire body the notes route accepts. `cwd` is accepted there
 *  and dropped (a host path is not workspace content); it rides along so a
 *  future reader can decide. */
export interface NotePayload {
  agent: string;
  kind: NoteKind;
  text: string;
  cwd?: string;
  sessionId?: string;
  /** Millisecond timestamp — the server refuses an ISO string. */
  at: number;
}

export type Decision = { post: NotePayload } | { skip: string };

export const DEFAULT_BASE_URL = 'http://localhost:8787';
export const POST_TIMEOUT_MS = 1500;
const SHORT_STRING_MAX = 200;

// ---------------------------------------------------------------------------
// Env

function present(v: string | undefined): v is string {
  return v !== undefined && v.trim() !== '';
}

/** Current spelling first, then the pre-rename one — the same fallback the
 *  MCP child applies (`readRenamedEnv`), spelled here because the installed
 *  plugin cannot import it. */
function readRenamed(env: EnvLike, current: string, legacy: string): string | undefined {
  if (present(env[current])) return env[current];
  if (present(env[legacy])) return env[legacy];
  return undefined;
}

export function readAgentName(env: EnvLike): string | undefined {
  return readRenamed(env, 'CW_AGENT_NAME', 'FEEDBACK_AGENT_NAME')?.trim();
}

/**
 * The board this session's notes land on. Every note route lives under
 * `/workspaces/{id}` (the owner moved the last top-level one, 2026-09-06),
 * and a hook has no board in hand — so it is a launch setting, read once
 * like the agent name, and a session launched without it posts nothing
 * until it is restarted with it set. That silence is the cost the owner
 * accepted when choosing the move over leaving the route where it was.
 */
export function readWorkspaceId(env: EnvLike): string | undefined {
  return readRenamed(env, 'CW_WORKSPACE_ID', 'FEEDBACK_WORKSPACE_ID')?.trim();
}

/**
 * CW_BASE_URL, then FEEDBACK_BASE_URL, then the server's discovery file
 * (the port it published at boot — what the MCP child itself resolves
 * through), then the documented default. A throwing discovery reader is
 * treated as absent: nothing in a hook may throw.
 */
export function resolveBaseUrl(
  env: EnvLike,
  discoveryPort?: () => number | undefined,
): string | undefined {
  const fromEnv = readRenamed(env, 'CW_BASE_URL', 'FEEDBACK_BASE_URL');
  if (fromEnv) return fromEnv.trim().replace(/\/+$/, '');
  if (discoveryPort) {
    try {
      const port = discoveryPort();
      if (typeof port === 'number' && Number.isFinite(port) && port > 0) {
        return `http://localhost:${port}`;
      }
    } catch {
      // absent
    }
  }
  return DEFAULT_BASE_URL;
}

// ---------------------------------------------------------------------------
// Decisions

export interface DecideContext {
  agent?: string;
  now: number;
}

type Payload = Record<string, unknown>;

function asPayload(payload: unknown): Payload | undefined {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  return payload as Payload;
}

function shortString(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' && v.length <= SHORT_STRING_MAX ? v : undefined;
}

function note(
  p: Payload,
  ctx: DecideContext,
  agent: string,
  kind: NoteKind,
  text: string,
): Decision {
  const cwd = shortString(p.cwd);
  const sessionId = shortString(p.session_id);
  return {
    post: {
      agent,
      kind,
      text,
      ...(cwd !== undefined ? { cwd } : {}),
      ...(sessionId !== undefined ? { sessionId } : {}),
      at: ctx.now,
    },
  };
}

/**
 * The Stop hook: the turn's closing message, whole and reduced.
 *
 * A turn already CONTINUING because of a stop hook still posts. It used to be
 * skipped, on the reading that a second stop was a duplicate of the first —
 * which was true while nothing here ever blocked. The unfiled-ask nudge does
 * block, so the continuation is now a real and different message (usually the
 * one saying the item was filed), and dropping it would take the turn's actual
 * conclusion off the Activity tab. The NUDGE is still suppressed there — see
 * `runHook` — so a blocked turn is nudged at most once.
 */
export function decideTurnNote(payload: unknown, ctx: DecideContext): Decision {
  const p = asPayload(payload);
  if (!p) return { skip: 'malformed payload' };
  if (!ctx.agent) return { skip: 'no agent name' };
  const text = fullNote(p.last_assistant_message);
  if (text === '') return { skip: 'empty message' };
  return note(p, ctx, ctx.agent, 'turn', text);
}

/** The PermissionDenied hook: the denied call's shape, never its content. */
export function decideDenialNote(payload: unknown, ctx: DecideContext): Decision {
  const p = asPayload(payload);
  if (!p) return { skip: 'malformed payload' };
  if (!ctx.agent) return { skip: 'no agent name' };
  const tool = shortString(p.tool_name);
  if (!tool) return { skip: 'no tool name' };
  let text = tool;
  if (tool === 'Bash') {
    const input = asPayload(p.tool_input);
    const shape = commandShape(input?.command);
    if (shape !== '') text = shape;
  }
  return note(p, ctx, ctx.agent, 'denial', text);
}

/** Top-level key NAMES of a hook payload, sorted — what gets logged the
 *  first time so the live shape is learned without a value ever leaving. */
export function payloadKeys(payload: unknown): string[] {
  const p = asPayload(payload);
  return p ? Object.keys(p).sort() : [];
}

// ---------------------------------------------------------------------------
// Transport

/**
 * POST the note and read what came back.
 *
 * The answer used to be thrown away — the hook fired with the turn already
 * over, so there was nobody to tell. There is now: the server judges a turn
 * note as it arrives and may answer with `unfiledAsk`, a line saying the
 * closing message asks the owner something that exists nowhere they read.
 * That line is the ONLY thing read off the response; everything else about a
 * failed POST stays what it was, which is silence.
 *
 * Never rejects. A refusal, a timeout, a thrown fetch or a body that is not
 * JSON all come back as `{ ok: false }`.
 */
export async function postNote(
  baseUrl: string,
  workspaceId: string,
  body: NotePayload,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = POST_TIMEOUT_MS,
): Promise<{ ok: boolean; unfiledAsk?: string }> {
  try {
    const path = `/workspaces/${encodeURIComponent(workspaceId)}/agents/${encodeURIComponent(body.agent)}/notes`;
    const res = await fetchImpl(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { ok: false };
    let unfiledAsk: string | undefined;
    try {
      const answer = (await res.json()) as { unfiledAsk?: unknown };
      if (typeof answer?.unfiledAsk === 'string' && answer.unfiledAsk.trim() !== '') {
        unfiledAsk = answer.unfiledAsk.trim();
      }
    } catch {
      // A 2xx with no JSON body is still a delivered note.
    }
    return unfiledAsk !== undefined ? { ok: true, unfiledAsk } : { ok: true };
  } catch {
    return { ok: false };
  }
}

// ---------------------------------------------------------------------------
// The main, minus the process

export interface HookDeps {
  env: EnvLike;
  fetch?: typeof fetch;
  now?: () => number;
  /** Overrides `resolveBaseUrl(env, discoveryPort)` when given. */
  baseUrl?: () => string | undefined;
  discoveryPort?: () => number | undefined;
  /** Where the one-time shape line goes (stderr in the script). */
  log?: (line: string) => void;
  /** True when this hook's shape was already logged; marks it seen. */
  shapeSeen?: (kind: NoteKind) => boolean;
}

/**
 * Read stdin → decide → post → relay.
 *
 * The return value is the one thing a Stop hook can do that a note cannot:
 * `undefined` ends the turn as before, and a string is a line to hand back to
 * the agent BEFORE the turn ends. `hookMain` turns the string into the Stop
 * hook's `decision: "block"`, which is what makes the ask visible in the turn
 * that made it rather than in a daily report nobody reads.
 *
 * It cannot loop: a blocked stop sets `stop_hook_active` on the next one, and
 * `decideTurnNote` refuses to nudge a turn already carrying it. So the most
 * any turn can be told is once.
 *
 * Never throws. Every failure path answers `undefined`, which is the old
 * behaviour exactly — a hook that cannot reach the server must not hold up
 * the agent that fired it.
 */
export async function runHook(
  kind: NoteKind,
  stdin: string,
  deps: HookDeps,
): Promise<string | undefined> {
  try {
    let payload: unknown;
    try {
      payload = JSON.parse(stdin);
    } catch {
      return undefined;
    }
    if (deps.log && deps.shapeSeen && !deps.shapeSeen(kind)) {
      deps.log(`[claude-workspaces] ${kind} hook payload keys: ${payloadKeys(payload).join(', ')}`);
    }
    const ctx: DecideContext = {
      agent: readAgentName(deps.env),
      now: deps.now ? deps.now() : Date.now(),
    };
    const decision =
      kind === 'turn' ? decideTurnNote(payload, ctx) : decideDenialNote(payload, ctx);
    if ('skip' in decision) return undefined;
    const workspaceId = readWorkspaceId(deps.env);
    if (!workspaceId) return undefined;
    const baseUrl = deps.baseUrl ? deps.baseUrl() : resolveBaseUrl(deps.env, deps.discoveryPort);
    if (!baseUrl) return undefined;
    const sent = await postNote(baseUrl, workspaceId, decision.post, deps.fetch ?? fetch);
    // Only a turn can be nudged. A denial note is a record of something the
    // agent already saw refused, and blocking on it would nag about the
    // permission system rather than about an unfiled ask.
    if (kind === 'turn' && !nudgeSuppressed(payload)) return sent.unfiledAsk;
  } catch {
    // fail open
  }
  return undefined;
}

/**
 * The one line a Stop hook can say to its own agent, or nothing.
 *
 * `decision: "block"` with a `reason` is the whole protocol: the reason lands
 * in the model's context and the turn stays open, which is what "told within
 * the turn" means. Anything else printed on stdout is noise on every stop, so
 * an absent or blank nudge prints nothing at all.
 */
export function blockDecision(nudge: string | undefined): string | undefined {
  if (typeof nudge !== 'string' || nudge.trim() === '') return undefined;
  return JSON.stringify({ decision: 'block', reason: nudge });
}

/** A turn already continuing because of a stop hook is never nudged again —
 *  see `runHook`. Read off the payload rather than off the decision, because
 *  the note itself still posts (the continuation is a real message, and the
 *  Activity tab should carry it). */
function nudgeSuppressed(payload: unknown): boolean {
  return asPayload(payload)?.stop_hook_active === true;
}
