import type { SecretReader } from './access-headers.ts';
/**
 * Prompt marks — the pure half of the plugin's UserPromptSubmit hook.
 *
 * The coach counts the owner's Claude Code time from the prompts he types,
 * and a turn note cannot say whether a person or a channel woke the turn. So
 * every prompt posts one mark to `POST /workspaces/{id}/agents/{name}/prompts`
 * saying whether it was typed, with the session id and working directory the
 * turn notes already carry. A typed prompt also carries its text, reduced the
 * way a turn note is (`note-redact.ts`) and capped at `PROMPT_TEXT_CAP`, so
 * the coach's digest can say what he asked (the owner, 2026-10-16). An
 * injected prompt carries no text, except a board channel event, which
 * carries `channel`: who caused it, one reduced line of it, and the queue
 * row it delivered. The board's lead chat shows those rows so a person sees
 * what the lead received (the owner, 2026-10-31); the coach never reads
 * them (`routes/prompt-marks.ts`). The route's answer says whether this
 * session is the board's lead, and the hook keeps a marker for the session
 * while it is, so the session-mirror hooks know to post (`session-mirror.ts`).
 *
 * Headless runs are not typed. `claude -p` and the Agent SDK set
 * `CLAUDE_CODE_ENTRYPOINT` to `sdk-cli`, `sdk-ts` or `sdk-py` (read off the
 * Claude Code 2.1.302 binary: the CLI rewrites `cli` to `sdk-cli` when it
 * runs non-interactively), so a prompt there marks the run as injected
 * and nothing in it reaches the digest. A Remote Control session is
 * excepted: its process can run the same non-interactive way while a person
 * types on the phone, and Claude Code names its bridge in
 * `CLAUDE_CODE_BRIDGE_SESSION_ID`. Every mark from such a session says
 * `remote: true`, so the coach's coverage report counts the phone's prompts
 * apart from a terminal's.
 *
 * The name comes from the launch env. The board does too, or, for a session
 * launched without one, it is the board the session joined with
 * `attach_agent` (`joined-board.ts`). A walled lead posts over its board's
 * socket (`resolveTransport` in `agent-notes.ts`).
 *
 * A prompt is typed unless it starts with a wrapper the harness puts around
 * what it injects. The payload names no origin — past the common fields it
 * carries only `prompt` and `session_title` (Claude Code 2.1.302) — so the
 * opening is the only signal. The wrappers are the ones that binary queues
 * as a prompt: channel events, a subagent's hand-back (`<agent-message`),
 * teammate and cross-session messages, task notifications, system reminders,
 * the banners it puts above a task notification and a scheduled firing, and
 * the plain lead-ins it writes for a peer message, an observer report and a
 * resumed session, plus the fleet's self-wake. A wrapper missing from
 * this list reads as typed, which overstates his time; it never hides it.
 *
 * Never blocks the prompt and never prints: a UserPromptSubmit hook's stdout
 * is added to the model's context, so every path here is silent and exits 0.
 */
import {
  type EnvLike,
  POST_TIMEOUT_MS,
  boardOf,
  readAgentName,
  resolveTransport,
} from './agent-notes.ts';
import { fullNote } from './note-redact.ts';
import { markLead, mirrorDir } from './session-mirror.ts';

/** How an injected prompt begins, after leading whitespace. */
export const INJECTED_PREFIXES: readonly string[] = [
  '<channel',
  '<agent-message',
  '<teammate-message',
  '<task-notification',
  '<system-reminder',
  '<cross-session-message',
  'Another Claude session sent a message',
  'A peer session sent a message',
  'Activity was observed in the bound conversation',
  'Your background observer (',
  '[SYSTEM NOTIFICATION - NOT USER INPUT]',
  '[SCHEDULED TASK - AUTOMATED FIRING OF A CONFIGURED PROMPT]',
  'This session is being continued from a previous conversation',
  'Self-wake',
];

const SHORT_STRING_MAX = 200;
/** The most of a typed prompt sent; the route refuses past 4,000. */
export const PROMPT_TEXT_CAP = 2_000;
/** What `CLAUDE_CODE_ENTRYPOINT` reads in a run nobody is typing into. */
export const HEADLESS_ENTRYPOINTS: readonly string[] = ['sdk-cli', 'sdk-ts', 'sdk-py'];

/** The most of a channel event's words sent; the route refuses past 1,000. */
export const CHANNEL_TEXT_CAP = 600;

/** A board event a session took as a prompt, as the lead chat shows it. */
export interface ChannelLine {
  text: string;
  author?: string;
  queueId?: string;
}

/** The wire body the prompts route accepts. Text only on a typed prompt. */
export interface PromptMark {
  agent: string;
  typed: boolean;
  cwd?: string;
  sessionId?: string;
  text?: string;
  /** On an injected prompt that is a channel event only. */
  channel?: ChannelLine;
  /** The session runs under Remote Control. */
  remote?: true;
  at: number;
}

/** A session Claude Code bridges to Remote Control. */
export function isRemoteControl(env: EnvLike): boolean {
  return (env.CLAUDE_CODE_BRIDGE_SESSION_ID?.trim() ?? '') !== '';
}

/** A `claude -p` or SDK run with nobody at it. */
export function isHeadless(env: EnvLike): boolean {
  const entry = env.CLAUDE_CODE_ENTRYPOINT?.trim() ?? '';
  if (!HEADLESS_ENTRYPOINTS.includes(entry)) return false;
  return !isRemoteControl(env);
}

/** True when a person typed it, false when the harness injected it, and
 *  undefined when the payload carries no prompt at all. */
export function isTypedPrompt(prompt: unknown): boolean | undefined {
  if (typeof prompt !== 'string') return undefined;
  const head = prompt.trimStart();
  if (head === '') return undefined;
  return !INJECTED_PREFIXES.some((p) => head.startsWith(p));
}

const CHANNEL_RE = /^<channel\b([^>]*)>([\s\S]*?)(?:<\/channel>|$)/;
const QUEUE_ID_RE = /queueId="([A-Za-z0-9_~.-]{1,200})"/;

function attr(attrs: string, name: string): string | undefined {
  const m = attrs.match(new RegExp(`\\b${name}="([^"]{1,200})"`));
  return m?.[1];
}

/**
 * A channel event's line: its words reduced the way a turn note is, who
 * caused it (the event's `author`, else its `source`), and the voice queue
 * row it delivered when it was a `voice.request`. Undefined for any other
 * prompt, or one with no words left after reduction.
 */
export function channelLine(prompt: unknown): ChannelLine | undefined {
  if (typeof prompt !== 'string') return undefined;
  const m = prompt.trimStart().match(CHANNEL_RE);
  if (!m) return undefined;
  const attrs = m[1] ?? '';
  const text = fullNote((m[2] ?? '').trim(), CHANNEL_TEXT_CAP);
  if (text === '') return undefined;
  const raw = attr(attrs, 'author') ?? attr(attrs, 'source');
  const author = raw ? fullNote(raw, 100) : '';
  const queueId = (m[2] ?? '').match(QUEUE_ID_RE)?.[1];
  return {
    text,
    ...(author ? { author } : {}),
    ...(queueId ? { queueId } : {}),
  };
}

const shortString = (v: unknown): string | undefined =>
  typeof v === 'string' && v !== '' && v.length <= SHORT_STRING_MAX ? v : undefined;

export function decidePromptMark(
  payload: unknown,
  ctx: { agent?: string; now: number; headless?: boolean; remote?: boolean },
): { post: PromptMark } | { skip: string } {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return { skip: 'malformed payload' };
  }
  if (!ctx.agent) return { skip: 'no agent name' };
  const p = payload as Record<string, unknown>;
  const classified = isTypedPrompt(p.prompt);
  if (classified === undefined) return { skip: 'no prompt' };
  const typed = classified && !ctx.headless;
  const cwd = shortString(p.cwd);
  const sessionId = shortString(p.session_id);
  const text = typed ? fullNote(p.prompt, PROMPT_TEXT_CAP) : '';
  const channel = typed ? undefined : channelLine(p.prompt);
  return {
    post: {
      agent: ctx.agent,
      typed,
      ...(cwd !== undefined ? { cwd } : {}),
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(text !== '' ? { text } : {}),
      ...(channel ? { channel } : {}),
      ...(ctx.remote ? { remote: true as const } : {}),
      at: ctx.now,
    },
  };
}

export interface PromptHookDeps {
  env: EnvLike;
  fetch?: typeof fetch;
  now?: () => number;
  discoveryPort?: () => number | undefined;
  /** With no board in the env, ask the server which board the session
   *  joined (`joined-board.ts`). */
  joinedBoard?: boolean;
  /** The Access secret's reader; Keychain when omitted. */
  readSecret?: SecretReader;
  /** Where the lead marker is kept; `mirrorDir(env)` when omitted. */
  mirrorDir?: string;
}

/** Read stdin, decide, post. Answers whether a mark was delivered; never throws. */
export async function runPromptHook(stdin: string, deps: PromptHookDeps): Promise<boolean> {
  try {
    const decision = decidePromptMark(JSON.parse(stdin), {
      agent: readAgentName(deps.env),
      now: deps.now ? deps.now() : Date.now(),
      headless: isHeadless(deps.env),
      remote: isRemoteControl(deps.env),
    });
    if ('skip' in decision) return false;
    const transport = resolveTransport(
      deps.env,
      deps.discoveryPort,
      deps.fetch ?? fetch,
      deps.readSecret,
    );
    if (!transport) return false;
    const workspaceId = await boardOf(deps.env, transport, decision.post.agent, deps.joinedBoard);
    if (!workspaceId) return false;
    const path = `/workspaces/${encodeURIComponent(workspaceId)}/agents/${encodeURIComponent(decision.post.agent)}/prompts`;
    const res = await transport.fetch(`${transport.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(decision.post),
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    });
    if (res.ok) {
      const answer = (await res.json().catch(() => null)) as { lead?: unknown } | null;
      markLead(
        decision.post.sessionId,
        answer?.lead === true,
        deps.mirrorDir ?? mirrorDir(deps.env),
      );
    }
    return res.ok;
  } catch {
    return false;
  }
}
