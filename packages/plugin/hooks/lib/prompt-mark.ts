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
 * injected prompt carries no text.
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
 * `attach_agent` (`joined-board.ts`).
 *
 * A prompt is typed unless it starts with a wrapper the harness puts around
 * what it injects. The wrappers are the ones a lead session's transcript
 * holds on user turns: channel events, teammate messages, background task
 * notifications, system reminders, cross-session messages, and the plain
 * lead-ins the harness writes for a cross-session message, a resumed session
 * and a self-wake. A wrapper missing from this list reads as typed, which
 * overstates his time; it never hides it.
 *
 * Never blocks the prompt and never prints: a UserPromptSubmit hook's stdout
 * is added to the model's context, so every path here is silent and exits 0.
 */
import {
  type EnvLike,
  POST_TIMEOUT_MS,
  readAgentName,
  readWorkspaceId,
  resolveBaseUrl,
} from './agent-notes.ts';
import { findJoinedBoard } from './joined-board.ts';
import { fullNote } from './note-redact.ts';

/** How an injected prompt begins, after leading whitespace. */
export const INJECTED_PREFIXES: readonly string[] = [
  '<channel',
  '<teammate-message',
  '<task-notification',
  '<system-reminder',
  '<cross-session-message',
  'Another Claude session sent a message',
  'This session is being continued from a previous conversation',
  'Self-wake',
];

const SHORT_STRING_MAX = 200;
/** The most of a typed prompt sent; the route refuses past 4,000. */
export const PROMPT_TEXT_CAP = 2_000;
/** What `CLAUDE_CODE_ENTRYPOINT` reads in a run nobody is typing into. */
export const HEADLESS_ENTRYPOINTS: readonly string[] = ['sdk-cli', 'sdk-ts', 'sdk-py'];

/** The wire body the prompts route accepts. Text only on a typed prompt. */
export interface PromptMark {
  agent: string;
  typed: boolean;
  cwd?: string;
  sessionId?: string;
  text?: string;
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
  return {
    post: {
      agent: ctx.agent,
      typed,
      ...(cwd !== undefined ? { cwd } : {}),
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(text !== '' ? { text } : {}),
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
    const baseUrl = resolveBaseUrl(deps.env, deps.discoveryPort);
    if (!baseUrl) return false;
    const fetchImpl = deps.fetch ?? fetch;
    const workspaceId =
      readWorkspaceId(deps.env) ??
      (deps.joinedBoard
        ? await findJoinedBoard(baseUrl, decision.post.agent, fetchImpl)
        : undefined);
    if (!workspaceId) return false;
    const path = `/workspaces/${encodeURIComponent(workspaceId)}/agents/${encodeURIComponent(decision.post.agent)}/prompts`;
    const res = await fetchImpl(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(decision.post),
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}
