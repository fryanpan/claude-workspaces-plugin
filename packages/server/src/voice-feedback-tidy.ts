/**
 * Spoken words in, written comments out — each one tidied, and each one
 * pointed at the element it is about.
 *
 * One model call per tick decides three things together, because each answer
 * constrains the others: whether the new words continue the comment already
 * open or start a new topic, what the tidied comment says, and which element
 * in the page's catalog it is about. Asking them separately would let the
 * topic split disagree with the element pick ("same comment" but a different
 * element), and would triple the latency the person waits for their words to
 * land.
 *
 * The model is a parameter (`TidyComplete`), for the reason every billed call
 * in this server is: a test must not be able to spend. `createHaikuTidy` is
 * the real one, and it reads the same credential every non-prod server reads
 * — the eval key anywhere but prod (`claude-key-source.ts`).
 */
import { type TokenUsage, type VoiceTarget, dollars } from '@claude-workspaces/core';
import { readKeychainPassword } from './share/keychain.ts';
import { authHeader, resolveCredentialFrom } from './summarize.ts';

export const TIDY_MODEL = 'claude-haiku-4-5-20251001';
const API_URL = 'https://api.anthropic.com/v1/messages';
const MAX_TOKENS = 700;
const TIMEOUT_MS = 20_000;

export interface TidyOpen {
  /** Its note as it stands — what `apportionTick` checks a rewrite against. */
  text: string;
  /** Everything said for it so far, which the note is written again from. */
  raw: string;
  target: number | null;
  /** The person placed it (tap or Move): the model may not re-point it. */
  fixed: boolean;
  /** The person tapped this earlier note to add to it. */
  chosen?: boolean;
}

export interface TidyInput {
  targets: readonly VoiceTarget[];
  open: TidyOpen | null;
  /** A tapped element the NEXT new comment belongs to; absent when none. */
  pinned?: number | null;
  /** The words heard since the last tick. */
  words: string;
}

export interface TidyComment {
  /** Only the first may continue — it is the open comment, grown. */
  continues: boolean;
  text: string;
  target: number | null;
}

export interface TidyReply {
  text: string;
  usage?: TokenUsage;
}

export type TidyComplete = (req: { system: string; user: string }) => Promise<TidyReply>;

export const TIDY_SYSTEM = `You turn a person's spoken feedback about a web page into short written review comments, each attached to the page element it is about.

You get the page's element catalog, the comment currently open (if any) with every word said for it so far, and the NEW words just heard, after a pause. The words are a live transcript: no punctuation guarantees, filler, false starts, mis-heard words.

Decide:
1. Topic. Do the new words continue the open comment's topic, start a new topic, or continue it and then change topic? A new topic is a different element or a different problem. More detail, a reason, or a suggested fix for the same problem continues it.
2. Words. For each comment write the speaker's point in clear, concise sentences. Drop filler, repetition and false starts. Keep their meaning, specifics and tone. Never add ideas they did not say. No preamble such as "The user says". For a continued comment write the WHOLE comment again, as one finished note, from everything said for it: its earlier words and the new ones.
3. Element. Pick the one catalog element each comment is about, by id. Prefer the most specific element matching what they named — a chip, a button, a heading, a bar — and use the enclosing element's text and the "in" links to tell similar elements apart ("the done chip on the pantry task"). Pick a container when they talk about the whole group. Use null when the words are about the page in general or nothing fits.

If the open comment says fixed, keep its element. If it says chosen, the person picked it to add to: the new words continue it unless they plainly move to another element or problem. If a pinned element is given, the first NEW comment is about it.
If the new words carry no feedback (filler, thinking aloud), return {"comments":[]}.

Reply with JSON only, no prose:
{"comments":[{"continues":true,"text":"...","element":"e12"}]}
Only the first comment may have "continues": true, and only when a comment is open.`;

function describe(t: VoiceTarget): string {
  let line = `e${t.i} <${t.tag}>`;
  if (t.text) line += ` "${t.text}"`;
  if (t.label) line += ` label="${t.label}"`;
  if (t.hint) line += ` ${t.hint}`;
  if (t.parent !== undefined) line += ` in e${t.parent}`;
  return line;
}

export function buildTidyPrompt(input: TidyInput): { system: string; user: string } {
  const parts = ['<catalog>', ...input.targets.map(describe), '</catalog>'];
  if (input.open) {
    const where = input.open.target === null ? 'page' : `e${input.open.target}`;
    const flags = `${input.open.fixed ? ' fixed' : ''}${input.open.chosen ? ' chosen' : ''}`;
    parts.push(`<open element="${where}"${flags}><said>${input.open.raw}</said></open>`);
  } else {
    parts.push('<open>none</open>');
  }
  if (input.pinned !== undefined) {
    parts.push(`<pinned>${input.pinned === null ? 'page' : `e${input.pinned}`}</pinned>`);
  }
  parts.push(`<new_words>${input.words}</new_words>`);
  return { system: TIDY_SYSTEM, user: parts.join('\n') };
}

/**
 * The model's reply, checked against what was asked, or null when it is not
 * a reply at all. An element id outside the catalog reads as the page — a
 * comment on the whole mock is still a comment, where a dropped reply is lost
 * words.
 */
export function parseTidyReply(text: string, input: TidyInput): TidyComment[] | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  const list = (parsed as { comments?: unknown }).comments;
  if (!Array.isArray(list)) return null;
  const known = new Set(input.targets.map((t) => t.i));
  const out: TidyComment[] = [];
  for (const c of list) {
    if (!c || typeof c !== 'object') continue;
    const m = c as Record<string, unknown>;
    if (typeof m.text !== 'string' || !m.text.trim()) continue;
    const id = typeof m.element === 'string' ? /^e(\d+)$/.exec(m.element)?.[1] : undefined;
    const target = id !== undefined && known.has(Number(id)) ? Number(id) : null;
    out.push({
      continues: out.length === 0 && m.continues === true && input.open !== null,
      text: m.text.trim(),
      target,
    });
  }
  return out;
}

/** Dollars a reply cost, for the session's running total. */
export function tidyDollars(usage: TokenUsage | undefined): number {
  return usage ? dollars(usage, TIDY_MODEL) : 0;
}

/**
 * The real completer, or null when this machine holds no credential — in
 * which case voice feedback reports itself unavailable rather than
 * transcribing words it can never turn into comments.
 */
export function createHaikuTidy(opts?: {
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
  read?: (service: string) => string | null;
}): TidyComplete | null {
  const cred = resolveCredentialFrom(
    undefined,
    opts?.read ?? readKeychainPassword,
    opts?.env ?? process.env,
  );
  if (!cred) return null;
  const fetchImpl = opts?.fetchImpl ?? globalThis.fetch;
  return async ({ system, user }) => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const res = await fetchImpl(API_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'anthropic-version': '2023-06-01',
          ...authHeader(cred),
        },
        body: JSON.stringify({
          model: TIDY_MODEL,
          max_tokens: MAX_TOKENS,
          system,
          messages: [{ role: 'user', content: user }],
        }),
        signal: ctl.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as {
        content?: Array<{ text?: string }>;
        usage?: {
          input_tokens?: number;
          output_tokens?: number;
          cache_read_input_tokens?: number;
          cache_creation_input_tokens?: number;
        };
      };
      const u = body.usage;
      return {
        text: body.content?.map((b) => b.text ?? '').join('') ?? '',
        ...(u
          ? {
              usage: {
                inputTokens: u.input_tokens ?? 0,
                outputTokens: u.output_tokens ?? 0,
                cacheReadTokens: u.cache_read_input_tokens ?? 0,
                cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
              },
            }
          : {}),
      };
    } finally {
      clearTimeout(timer);
    }
  };
}

const FILLER = new Set(
  "the and but are was for not you its it's this that with also just like yeah actually really so".split(
    ' ',
  ),
);

/** The words that can tie spoken words to a tidied comment: no filler, stems cut to five letters. */
function keys(text: string): string[] {
  return text
    .split(/\s+/)
    .map(normWord)
    .map((w) => (w.length < 3 || FILLER.has(w) ? '' : w.slice(0, 5)));
}

const keySet = (text: string): Set<string> => new Set(keys(text).filter(Boolean));

/** Words that change no meaning — a far shorter list than `FILLER`, which drops "not". */
const HOLLOW = new Set('a an the and but also just so yeah actually really um uh'.split(' '));

const NEGATION =
  /n't$|^(not|no|never|none|nothing|cannot|dont|cant|wont|isnt|arent|doesnt|didnt|shouldnt|wasnt)$/;

/**
 * Every word that could change what a sentence means, quotes off, stemmed as
 * `keys` stems — except that every negation reads as "not", before a stem
 * could cut "shouldn't" down to "shoul".
 */
const meaningSet = (text: string): Set<string> =>
  new Set(
    text
      .split(/\s+/)
      .map((w) => normWord(w).replace(/^'+|'+$/g, ''))
      .filter((w) => w && !HOLLOW.has(w))
      .map((w) => (NEGATION.test(w) ? 'not' : w.slice(0, 5))),
  );

export interface TickPart {
  words: string;
  startMs: number;
  endMs: number;
}

/**
 * The stretch of one tick's words, and of its audio, that each comment is
 * made of: in order, touching, never shared. Handing every comment the whole
 * tick gave two topics said in one breath the same clip, and the first
 * comment's raw words the second one's sentence.
 *
 * Each cut goes where the words before it best match the comment before and
 * the words after it best match the comments after — a tidied comment keeps
 * the speaker's nouns ("sync", "blocked"). Among equal cuts the earliest wins,
 * so a joining "and also" opens the next comment. Asking the model to quote
 * where each comment starts was tried and made it merge topics it had split
 * (topic 10/12 against 12/12 without it). No match at all cuts by each
 * comment's share of the tidied text. Times are spread over the tick by word
 * position: the words carry no times of their own here.
 */
export function splitTick(
  words: string,
  comments: readonly TidyComment[],
  startMs: number,
  endMs: number,
): TickPart[] {
  const list = words.split(/\s+/).filter(Boolean);
  const spoken = keys(list.join(' '));
  const sets = comments.map((c) => new Set(keys(c.text).filter(Boolean)));
  const hits = (set: Set<string>, a: number, b: number) =>
    spoken.slice(a, b).filter((w) => w && set.has(w)).length;
  const total = comments.reduce((n, c) => n + c.text.length, 0) || 1;
  const starts = [0];
  let share = 0;
  for (let k = 1; k < comments.length; k++) {
    const prev = starts[k - 1] ?? 0;
    share += comments[k - 1]?.text.length ?? 0;
    const min = Math.min(prev + 1, list.length);
    const before = sets[k - 1] ?? new Set<string>();
    const after = new Set(sets.slice(k).flatMap((x) => [...x]));
    let best = min;
    let bestScore = -1;
    for (let i = min; i <= list.length; i++) {
      const score = hits(before, prev, i) + hits(after, i, list.length);
      if (score > bestScore) [best, bestScore] = [i, score];
    }
    const guess = Math.min(Math.max(min, Math.round((list.length * share) / total)), list.length);
    starts.push(bestScore > 0 ? best : guess);
  }
  const at = (i: number) =>
    list.length === 0 ? endMs : startMs + ((endMs - startMs) * i) / list.length;
  return comments.map((_, k) => {
    const a = starts[k] ?? 0;
    const b = starts[k + 1] ?? list.length;
    return { words: list.slice(a, b).join(' '), startMs: at(a), endMs: at(b) };
  });
}

/**
 * A tick's comments with no sentence said twice, and the stretch of the tick
 * each is made of (`splitTick`).
 *
 * The model sometimes grows a comment with the next topic's sentence AND
 * makes that topic its own comment — in a quarter of replayed staging
 * recordings (`scripts/voice-replay-eval.ts`). Telling it not to was tried,
 * and once returned no comment at all; a repeated sentence is cheaper than
 * lost words, so the repeat is taken out here, where nothing can be lost:
 *
 * - a sentence goes only when every word of it, "not" included, is said by a
 *   later comment or names the element that comment is on ("Should say save
 *   changes." on the Save button still says "button");
 * - never a sentence the open comment already held, and never every sentence
 *   of a comment;
 * - and only when the tick's split then hands more of its words to the later
 *   comments than to its own — the words the person said decide, not the
 *   tidied text alone.
 *
 * The other way the model loses a topic is the opposite: it "continues" the
 * open comment with a rewrite that keeps only the new sentence, which would
 * overwrite what the comment said (one replayed recording in eight). A
 * continuation that keeps under a third of the open comment's words is taken
 * as the new comment it reads as, so the open one settles as it was.
 */
export function apportionTick(
  input: TidyInput,
  replied: readonly TidyComment[],
  startMs: number,
  endMs: number,
): { comments: TidyComment[]; parts: TickPart[] } {
  const said = (c: TidyComment): string => {
    const t = c.target === null ? undefined : input.targets.find((x) => x.i === c.target);
    return [c.text, t?.tag, t?.text, t?.label].filter(Boolean).join(' ');
  };
  const old = keySet(input.open?.text ?? '');
  const first = replied[0];
  const forgot =
    first?.continues === true &&
    [...keySet(first.text)].filter((w) => old.has(w)).length * 3 < old.size;
  const comments =
    forgot && first ? [{ ...first, continues: false }, ...replied.slice(1)] : replied;
  const drops = comments.map((c, k) => {
    const later = meaningSet(
      comments
        .slice(k + 1)
        .map(said)
        .join(' '),
    );
    const sentences = c.text.split(/(?<=[.!?]['"”’)]*)\s+/);
    const repeat = sentences.map((s) => {
      const ks = [...keySet(s)];
      const held = c.continues && ks.filter((w) => old.has(w)).length * 2 >= ks.length;
      const means = meaningSet(s);
      // A later "not" the sentence lacks makes it a different point, not a repeat.
      const turned = later.has('not') && !means.has('not');
      return ks.length > 0 && !held && !turned && [...means].every((w) => later.has(w));
    });
    return { sentences, repeat: repeat.every(Boolean) ? repeat.map(() => false) : repeat };
  });
  const build = () =>
    comments.map((c, k) => {
      const d = drops[k];
      if (!d?.repeat.some(Boolean)) return c;
      return { ...c, text: d.sentences.filter((_, j) => !d.repeat[j]).join(' ') };
    });
  let kept = build();
  let parts = splitTick(input.words, kept, startMs, endMs);
  let vetoed = false;
  drops.forEach((d, k) => {
    const own = keys(parts[k]?.words ?? '');
    const after = keys(
      parts
        .slice(k + 1)
        .map((p) => p.words)
        .join(' '),
    );
    d.sentences.forEach((s, j) => {
      if (!d.repeat[j]) return;
      const ks = keySet(s);
      const count = (list: string[]) => list.filter((w) => ks.has(w)).length;
      if (count(after) > count(own)) return;
      d.repeat[j] = false;
      vetoed = true;
    });
  });
  if (vetoed) {
    kept = build();
    parts = splitTick(input.words, kept, startMs, endMs);
  }
  return { comments: kept, parts };
}

/** A word as the used-words bookkeeping compares it. */
export const normWord = (w: string): string => w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');

/**
 * The words of `now` not yet used, given the words `used` already were. An
 * engine may re-format a turn when it settles ("sixty six" becomes "66"), so
 * the used words are matched by their normalised form. Where the two no
 * longer line up, the last used word is looked for at or before where the
 * count puts it, and the words after it are new; when it is gone, everything
 * from the mismatch is. A repeated word is cheaper than a lost one: cutting
 * by count alone dropped "dollars" when "sixty six" settled as "66 dollars".
 */
export function unusedWords(now: string[], used: string[]): string[] {
  let i = 0;
  let j = 0;
  while (i < now.length && j < used.length && normWord(now[i] ?? '') === used[j]) {
    i++;
    j++;
  }
  if (j === used.length) return now.slice(i);
  const last = used[used.length - 1];
  for (let k = Math.min(used.length, now.length) - 1; k >= i; k--) {
    if (normWord(now[k] ?? '') === last) return now.slice(k + 1);
  }
  return now.slice(i);
}
