/**
 * The session mirror — the pure half of the plugin's MessageDisplay and
 * PostToolBatch hooks. The board's lead chat shows what the lead's terminal
 * shows (the owner, 2026-10-31); these two hooks hand it the text the
 * session writes mid-turn and the tool calls it makes, at
 * `POST /workspaces/{id}/agents/{name}/mirror`.
 *
 * Every session runs these hooks, and only the board's lead is mirrored, so
 * they post nothing until the server has said this session is the lead: the
 * prompts route answers `mirrored: true` for the lead's prompts, and the
 * UserPromptSubmit hook keeps a marker file for the session while it does
 * (`markLead`). No marker, no network.
 *
 * Every string is reduced the way a turn note is (`note-redact.ts`) and
 * capped, before it leaves the machine.
 *
 * A message arrives as flushes of whole lines. Reducing each flush alone
 * would lose a code fence opened in an earlier one, so each flush is kept as
 * a part file and the post carries the whole message so far, reduced, with
 * the flush's index; the parts go when the message's final flush is posted.
 * Async hooks can run out of order, and the server drops a flush older than
 * the one it shows.
 *
 * Never blocks and never prints: both hooks are registered `async`.
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SecretReader } from './access-headers.ts';
import {
  type EnvLike,
  POST_TIMEOUT_MS,
  boardOf,
  readAgentName,
  resolveTransport,
} from './agent-notes.ts';
import { fullNote } from './note-redact.ts';

/** The most of a message posted; the route refuses past 8,000. */
export const MIRROR_TEXT_CAP = 6_000;
/** The most of a tool call's input and output posted (the route's bounds). */
export const TOOL_INPUT_CAP = 2_000;
export const TOOL_OUTPUT_CAP = 4_000;
const SAFE_ID = /^[A-Za-z0-9_-]{1,100}$/;
const CALLS_MAX = 50;

/** A part file left this long lost its final flush; a marker this long
 *  belongs to a session that stopped prompting. */
export const PARTS_STALE_MS = 60 * 60_000;
export const MARKER_STALE_MS = 24 * 60 * 60_000;

/**
 * Where markers and part files live: the plugin's own data directory, which
 * Claude Code hands every hook, or this user's ~/.claude when it does not.
 * Never the shared tmpdir root — part files hold text not yet reduced.
 */
export function mirrorDir(env: EnvLike = process.env): string {
  const data = env.CLAUDE_PLUGIN_DATA;
  return typeof data === 'string' && data !== ''
    ? join(data, 'lead-mirror')
    : join(homedir(), '.claude', 'claude-workspaces', 'lead-mirror');
}

/** Remove part files and markers gone stale; at most once per prompt. */
export function sweepStale(dir: string, now = Date.now()): void {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    try {
      const age = now - statSync(path).mtimeMs;
      if (age > (name.endsWith('.parts') ? PARTS_STALE_MS : MARKER_STALE_MS)) {
        rmSync(path, { recursive: true, force: true });
      }
    } catch {
      // Gone already, or another hook's: the next sweep tries again.
    }
  }
}

/**
 * Make `dir` and refuse it unless this user owns it and nobody else may
 * open it: mkdir's mode does not touch a directory that already exists.
 */
export function ownDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = statSync(dir);
  const uid = process.getuid?.();
  if ((uid !== undefined && st.uid !== uid) || (st.mode & 0o077) !== 0) {
    throw new Error(`${dir} is not this user's alone`);
  }
}

/** A session id safe to use as a file name, or undefined. */
export function safeId(v: unknown): string | undefined {
  return typeof v === 'string' && SAFE_ID.test(v) ? v : undefined;
}

/** Keep or drop this session's marker after the prompts route answered. */
export function markLead(sessionId: unknown, lead: boolean, dir = mirrorDir()): void {
  const id = safeId(sessionId);
  if (!id) return;
  try {
    if (lead) {
      ownDir(dir);
      sweepStale(dir);
      writeFileSync(join(dir, id), '', { mode: 0o600 });
    } else {
      rmSync(join(dir, id), { force: true });
      rmSync(join(dir, `${id}.parts`), { recursive: true, force: true });
    }
  } catch {
    // A marker that cannot be written only means nothing is mirrored.
  }
}

export function isMarkedLead(sessionId: unknown, dir = mirrorDir()): boolean {
  const id = safeId(sessionId);
  if (!id) return false;
  try {
    ownDir(dir);
    readFileSync(join(dir, id));
    return true;
  } catch {
    return false;
  }
}

export interface TextBody {
  kind: 'text';
  messageId: string;
  index: number;
  final: boolean;
  text: string;
}

export interface ToolCallBody {
  name: string;
  input: string;
  output?: string;
  failed?: true;
}

export interface ToolsBody {
  kind: 'tools';
  calls: ToolCallBody[];
}

/**
 * One MessageDisplay flush: kept as a part, and the message so far reduced.
 * Undefined when the payload is not one or nothing is left to show.
 */
export function textBody(p: Record<string, unknown>, dir = mirrorDir()): TextBody | undefined {
  const session = safeId(p.session_id);
  const messageId = safeId(p.message_id);
  const { index, final, delta } = p;
  if (!session || !messageId) return undefined;
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) return undefined;
  if (typeof final !== 'boolean' || typeof delta !== 'string') return undefined;
  const parts = join(dir, `${session}.parts`, messageId);
  let whole = delta;
  try {
    ownDir(dir);
    mkdirSync(parts, { recursive: true, mode: 0o700 });
    writeFileSync(join(parts, String(index)), delta, { mode: 0o600 });
    whole = readdirSync(parts)
      .map(Number)
      .filter((n) => Number.isInteger(n) && n <= index)
      .sort((a, b) => a - b)
      .map((n) => readFileSync(join(parts, String(n)), 'utf8'))
      .join('');
    if (final) rmSync(parts, { recursive: true, force: true });
  } catch {
    // Unkept parts still post this flush on its own.
  }
  const text = fullNote(whole, MIRROR_TEXT_CAP);
  if (text === '') return undefined;
  return { kind: 'text', messageId, index, final, text };
}

/** A tool's input as a terminal shows it: a command, a path, else its JSON. */
export function toolInput(name: string, input: unknown): string {
  if (input && typeof input === 'object') {
    const o = input as Record<string, unknown>;
    if (name === 'Bash' && typeof o.command === 'string') return o.command;
    if (typeof o.file_path === 'string' && Object.keys(o).length === 1) return o.file_path;
  }
  if (typeof input === 'string') return input;
  try {
    return JSON.stringify(input) ?? '';
  } catch {
    return '';
  }
}

/** A tool's result as text: a Bash call's stdout and stderr, else its JSON. */
export function toolOutput(response: unknown): string {
  if (response === undefined || response === null) return '';
  if (typeof response === 'string') return response;
  const o = response as Record<string, unknown>;
  if (typeof o.stdout === 'string' || typeof o.stderr === 'string') {
    return [o.stdout, o.stderr].filter((s) => typeof s === 'string' && s !== '').join('\n');
  }
  try {
    return JSON.stringify(response) ?? '';
  } catch {
    return '';
  }
}

/** One PostToolBatch: each call reduced and capped. */
export function toolsBody(p: Record<string, unknown>): ToolsBody | undefined {
  if (!Array.isArray(p.tool_calls)) return undefined;
  const calls: ToolCallBody[] = [];
  for (const c of p.tool_calls.slice(0, CALLS_MAX)) {
    if (!c || typeof c !== 'object') continue;
    const call = c as Record<string, unknown>;
    if (typeof call.tool_name !== 'string' || call.tool_name === '') continue;
    const name = call.tool_name.slice(0, 200);
    const output = fullNote(toolOutput(call.tool_response), TOOL_OUTPUT_CAP);
    const failed =
      !!call.tool_response &&
      typeof call.tool_response === 'object' &&
      (call.tool_response as Record<string, unknown>).is_error === true;
    calls.push({
      name,
      input: fullNote(toolInput(name, call.tool_input), TOOL_INPUT_CAP),
      ...(output ? { output } : {}),
      ...(failed ? { failed: true as const } : {}),
    });
  }
  return calls.length > 0 ? { kind: 'tools', calls } : undefined;
}

/** What one hook payload posts, or why it posts nothing. */
export function decideMirror(
  payload: unknown,
  dir = mirrorDir(),
): { post: TextBody | ToolsBody } | { skip: string } {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return { skip: 'malformed payload' };
  }
  const p = payload as Record<string, unknown>;
  if (!isMarkedLead(p.session_id, dir)) return { skip: 'not the lead' };
  // A subagent's hooks carry its agent_id under the lead's session id: its
  // work is not what the lead's terminal shows.
  if (typeof p.agent_id === 'string' && p.agent_id !== '') return { skip: 'a subagent' };
  const body =
    p.hook_event_name === 'MessageDisplay'
      ? textBody(p, dir)
      : p.hook_event_name === 'PostToolBatch'
        ? toolsBody(p)
        : undefined;
  return body ? { post: body } : { skip: 'nothing to show' };
}

export interface MirrorHookDeps {
  env: EnvLike;
  fetch?: typeof fetch;
  discoveryPort?: () => number | undefined;
  joinedBoard?: boolean;
  readSecret?: SecretReader;
  mirrorDir?: string;
}

/** Read stdin, decide, post. Answers whether the server mirrored it; never
 *  throws. A server that says the session is no longer the lead drops the
 *  marker, so the next call posts nothing. */
export async function runMirrorHook(stdin: string, deps: MirrorHookDeps): Promise<boolean> {
  try {
    const payload = JSON.parse(stdin) as Record<string, unknown>;
    const dir = deps.mirrorDir ?? mirrorDir(deps.env);
    const decision = decideMirror(payload, dir);
    if ('skip' in decision) return false;
    const agent = readAgentName(deps.env);
    if (!agent) return false;
    const transport = resolveTransport(
      deps.env,
      deps.discoveryPort,
      deps.fetch ?? fetch,
      deps.readSecret,
    );
    if (!transport) return false;
    const workspaceId = await boardOf(deps.env, transport, agent, deps.joinedBoard);
    if (!workspaceId) return false;
    const path = `/workspaces/${encodeURIComponent(workspaceId)}/agents/${encodeURIComponent(agent)}/mirror`;
    const res = await transport.fetch(`${transport.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(decision.post),
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    });
    if (!res.ok) return false;
    const answer = (await res.json().catch(() => null)) as { mirrored?: unknown } | null;
    if (answer?.mirrored !== true) markLead(payload.session_id, false, dir);
    return answer?.mirrored === true;
  } catch {
    return false;
  }
}
