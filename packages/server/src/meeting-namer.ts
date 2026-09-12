/**
 * A meeting's topic, as a title: one small Haiku call over the notes.
 *
 * A new meeting is called "Meeting" (`defaultMeetingTitle`), which is a
 * placeholder rather than a name. Once the notes say what the meeting is
 * about, this asks for eight words or fewer that say it too. Where it runs
 * and when it may write is `meeting-titler.ts`; this file is the prompt, the
 * parser and the network call, the same split `effort-estimator.ts` makes.
 *
 * **Why a separate call and not a field on the notes tick.** The tick's reply
 * is one bare JSON array of edits, and a reply the parser cannot read fails
 * the tick — a topic field would put notes at risk to save about $0.004 a
 * meeting. This call is ~1.5k tokens in and ~20 out, about $0.0016, and runs
 * twice a meeting at most.
 *
 * **The key is the dedicated summary key**, through `resolveKeyFrom`: prod's
 * under the launchd service, the eval key anywhere else. The notes already
 * leave the machine for the note-taker under that consent; their own text
 * going to the same endpoint for a title is the same class of content.
 *
 * `createServer` never builds one. Nothing that merely spins a server up can
 * reach the network; `server-deps.ts` constructs the real one.
 */

import { readRenamedEnv } from '@claude-workspaces/core/env-names';
import { readKeychainPassword } from './share/keychain.ts';
import { resolveKeyFrom } from './summarize.ts';

/**
 * The seam: notes in, a title out, or `null` for "no usable title" — a down
 * endpoint, a reply that will not parse. A thrown error is treated the same.
 */
export type MeetingNamer = (input: { notes: string }) => Promise<string | null>;

const MODEL = 'claude-haiku-4-5-20251001';
const API_URL = 'https://api.anthropic.com/v1/messages';
const MAX_TOKENS = 40;
export const MEETING_NAMER_TIMEOUT_MS = 15_000;
/** The most of a doc sent. A title needs the gist, and the head of a
 *  meeting's notes carries it; a two-hour doc must not cost two hours. */
export const MEETING_NAMER_MAX_CHARS = 6000;
/** Asked for eight; a nine-word reply is still a title, a paragraph is not. */
export const MEETING_TITLE_MAX_WORDS = 10;
export const MEETING_TITLE_MAX_CHARS = 90;

export const MEETING_NAMER_SYSTEM =
  "You name meetings. You are given a meeting doc's notes. Reply with a title " +
  'of eight words or fewer that names what the meeting is about, in sentence ' +
  'case. No date, no time, no quotation marks, no trailing punctuation, and ' +
  'nothing but the title.';

export function buildMeetingNamerPrompt(notes: string): { system: string; user: string } {
  const clipped =
    notes.length > MEETING_NAMER_MAX_CHARS ? notes.slice(0, MEETING_NAMER_MAX_CHARS) : notes;
  return { system: MEETING_NAMER_SYSTEM, user: `<notes>\n${clipped}\n</notes>` };
}

/**
 * The title in a reply, or `null`.
 *
 * Forgiving about decoration a model adds anyway — a `Title:` label, quotes,
 * markdown emphasis, a full stop — and strict about shape: one line, a
 * title's length, and no date, because a date is the thing this replaces.
 */
export function parseMeetingTitle(reply: string): string | null {
  const line = reply
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return null;
  const title = line
    .replace(/^#+\s*/, '')
    .replace(/^title\s*:\s*/i, '')
    .replace(/^[*_"'`“‘]+|[*_"'`”’]+$/g, '')
    .replace(/[.。!?;:,]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (title.length === 0 || title.length > MEETING_TITLE_MAX_CHARS) return null;
  if (title.split(' ').length > MEETING_TITLE_MAX_WORDS) return null;
  if (/\d{4}-\d{2}-\d{2}|\b\d{1,2}:\d{2}\b/.test(title)) return null;
  return title;
}

/** How many list items the doc holds — the "about three bullets" at which
 *  a meeting has said enough to be named. */
export function countNoteBullets(markdown: string): number {
  let n = 0;
  for (const line of markdown.split('\n')) if (/^\s*(?:[-*+]|\d+\.)\s+\S/.test(line)) n++;
  return n;
}

/**
 * Is there anything to name the meeting FROM? A bullet, or a sentence's worth
 * of prose that is not a heading. A doc holding only its seed (`# Goal`, or a
 * `## Meeting notes` heading with nothing under it) is not.
 */
export function hasNotes(markdown: string): boolean {
  if (countNoteBullets(markdown) > 0) return true;
  const words = markdown
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join(' ')
    .split(/\s+/)
    .filter((w) => w.length > 0);
  return words.length >= 8;
}

/** Is naming switched on at all? `CW_MEETING_TITLES=0` is the kill switch. */
export function meetingNamerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return readRenamedEnv(env, 'CW_MEETING_TITLES') !== '0';
}

export interface HaikuMeetingNamerOpts {
  fetchImpl?: typeof fetch;
  /** A key directly instead of the Keychain (tests). `null` is "no key". */
  apiKey?: string | null;
  timeoutMs?: number;
}

const warned = new Set<string>();
function warnOnce(cause: string, line: string): void {
  if (warned.has(cause)) return;
  warned.add(cause);
  console.error(line);
}

/** The real namer, or `null` when there is no key or naming is off. */
export function haikuMeetingNamer(opts: HaikuMeetingNamerOpts = {}): MeetingNamer | null {
  if (!meetingNamerEnabled()) return null;
  const key = resolveKeyFrom(opts.apiKey, readKeychainPassword);
  if (!key) return null;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? MEETING_NAMER_TIMEOUT_MS;
  return async ({ notes }) => {
    const { system, user } = buildMeetingNamerPrompt(notes);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(API_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: MAX_TOKENS,
          system,
          messages: [{ role: 'user', content: user }],
        }),
        signal: ctl.signal,
      });
      if (!res.ok) {
        warnOnce(
          `http-${res.status}`,
          `[meeting-title] HTTP ${res.status}; titles left as they are`,
        );
        return null;
      }
      const body = (await res.json()) as { content?: Array<{ text?: string }> };
      const title = parseMeetingTitle(body.content?.map((b) => b.text ?? '').join('') ?? '');
      if (!title) warnOnce('unparseable', '[meeting-title] reply was not a usable title');
      return title;
    } catch (err) {
      warnOnce(
        'call-failed',
        `[meeting-title] call failed (${err instanceof Error ? err.message : String(err)})`,
      );
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
}
