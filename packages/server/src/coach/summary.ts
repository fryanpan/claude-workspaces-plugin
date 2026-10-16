/**
 * What he asked a session and what it answered, in a few words each, for the
 * coach's digest.
 *
 * A digest used to say only how many minutes a session took. The owner wants
 * it to say what he did (2026-10-16), so each typed prompt and each turn end
 * in a run carries its text this far, and one small Haiku call per digest
 * turns every one of them into a line of twelve words or fewer. The text
 * never goes into the digest itself: only the line does.
 *
 * One call per digest, not per prompt: a digest is already one session turn,
 * and a call per prompt would put a model call on every keystroke's worth of
 * work. About 4k tokens in and 600 out at the most marks one call takes.
 *
 * **The key is the dedicated summary key**, through `resolveKeySlotFrom`,
 * like every other Haiku call here. The digest goes to the coach session,
 * which sends it to the same API, so the text is the same class of content.
 *
 * Every failure is non-fatal. No key, a 429, a reply that will not parse:
 * each mark falls back to its own first words (`fallbackSummary`), so a
 * digest is never held for a summary.
 *
 * `createServer` never builds the real one; `server-deps.ts` does.
 */
import { readRenamedEnv } from '@claude-workspaces/core/env-names';
import { readKeychainPassword } from '../share/keychain.ts';
import { HAIKU_MODEL, HAIKU_NO_THINKING, resolveKeySlotFrom } from '../summarize.ts';

export interface SummaryMark {
  kind: 'prompt' | 'turn';
  text: string;
}

/**
 * The seam: marks in, one line per mark out (null where the model gave none
 * usable), or null for "no usable reply". A thrown error counts as null.
 */
export type CoachSummarizer = (marks: readonly SummaryMark[]) => Promise<(string | null)[] | null>;

const API_URL = 'https://api.anthropic.com/v1/messages';
/** The most marks one call summarises; the rest fall back to their words. */
export const SUMMARY_MAX_MARKS = 40;
/** The most of one mark sent. What he asked is in its first lines. */
export const SUMMARY_MARK_CHARS = 800;
/** A line the digest keeps, at most. */
export const SUMMARY_LINE_CHARS = 120;
const MAX_TOKENS = 1_500;
const TIMEOUT_MS = 20_000;

export const COACH_SUMMARY_SYSTEM =
  'You summarise Claude Code activity for a coach. You are given numbered items. ' +
  'A "prompt" is what a person typed to a coding agent; a "turn" is the agent’s ' +
  'closing message. For each item write one plain line of twelve words or fewer ' +
  'saying what was asked or done. No names of people, no secrets, no quotes. ' +
  'Reply with only a JSON array of strings, one per item, in order.';

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

/** A mark's own first words, when no model line is there. */
export function fallbackSummary(text: string): string {
  const t = squash(text);
  return t.length <= SUMMARY_LINE_CHARS ? t : `${t.slice(0, SUMMARY_LINE_CHARS - 1).trimEnd()}…`;
}

export function buildCoachSummaryPrompt(marks: readonly SummaryMark[]): {
  system: string;
  user: string;
} {
  const items = marks
    .map((m, i) => `${i + 1}. [${m.kind}] ${squash(m.text).slice(0, SUMMARY_MARK_CHARS)}`)
    .join('\n');
  return { system: COACH_SUMMARY_SYSTEM, user: `<items>\n${items}\n</items>` };
}

/** One line per mark, or null when the reply is not an array of `n` lines. */
export function parseCoachSummaries(reply: string, n: number): (string | null)[] | null {
  const start = reply.indexOf('[');
  const end = reply.lastIndexOf(']');
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(reply.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== n) return null;
  return parsed.map((v) => {
    if (typeof v !== 'string') return null;
    const line = squash(v);
    return line === '' ? null : fallbackSummary(line);
  });
}

/** Each mark's line: the model's where it gave one, its own words otherwise.
 *  Never rejects. */
export async function summariseMarks(
  marks: readonly SummaryMark[],
  summarizer: CoachSummarizer | null | undefined,
): Promise<string[]> {
  const fallback = marks.map((m) => fallbackSummary(m.text));
  if (!summarizer || marks.length === 0) return fallback;
  const asked = marks.slice(0, SUMMARY_MAX_MARKS);
  let lines: (string | null)[] | null = null;
  try {
    lines = await summarizer(asked);
  } catch {
    lines = null;
  }
  return fallback.map((f, i) => lines?.[i] ?? f);
}

/** `CW_COACH_SUMMARIES=0` is the kill switch. */
export function coachSummariesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return readRenamedEnv(env, 'CW_COACH_SUMMARIES') !== '0';
}

export interface HaikuCoachSummarizerOpts {
  fetchImpl?: typeof fetch;
  /** A key directly instead of the Keychain (tests). `null` is "no key". */
  apiKey?: string | null;
  timeoutMs?: number;
}

/** The real summariser, or null when there is no key or it is switched off. */
export function haikuCoachSummarizer(opts: HaikuCoachSummarizerOpts = {}): CoachSummarizer | null {
  if (!coachSummariesEnabled()) return null;
  const resolved = resolveKeySlotFrom('coach-digest', opts.apiKey, readKeychainPassword);
  if (!resolved) return null;
  const key = resolved.key;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  return async (marks) => {
    const { system, user } = buildCoachSummaryPrompt(marks);
    try {
      const res = await fetchImpl(API_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: HAIKU_MODEL,
          max_tokens: MAX_TOKENS,
          thinking: HAIKU_NO_THINKING,
          system,
          messages: [{ role: 'user', content: user }],
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        console.warn(`[coach] summary HTTP ${res.status}; the digest uses each line's own words`);
        return null;
      }
      const body = (await res.json()) as { content?: Array<{ type?: string; text?: string }> };
      const text = (body.content ?? [])
        .filter((b) => b.type === undefined || b.type === 'text')
        .map((b) => b.text ?? '')
        .join('');
      return parseCoachSummaries(text, marks.length);
    } catch (err) {
      console.warn(`[coach] summary call failed (${err instanceof Error ? err.name : 'error'})`);
      return null;
    }
  };
}
