/**
 * Notes that say the opposite of what was said, found without a model.
 *
 * WHY THIS EXISTS. A nine-minute dictation on 2026-09-22 ended with a quality
 * record reading "no flags" over notes that had turned a stated problem into
 * a benefit, written "repave" as "re-assess", and turned a question about
 * access into a claim. Every check the record ran asked whether an idea
 * reached a note; none asked whether the note kept its meaning. Coverage
 * cannot see an inversion at all: an inverted note shares nearly every word
 * with its source, which is exactly what reads as "covered".
 *
 * HOW A NOTE IS JUDGED. Each note is matched to the spoken sentence it shares
 * the most content words with — its SOURCE, quoted in the finding so a reader
 * can compare the two lines without opening the transcript. Then three
 * decidable questions, each a change of meaning a paraphrase does not make:
 *
 * - **Problem written as benefit, or the reverse.** The source carries a
 *   problem word ("problem", "complaint", "risk") and no benefit word, and the
 *   note carries a benefit word ("benefit", "helps", "improves") and no
 *   problem word.
 * - **One action swapped for another.** The source names an action from one
 *   class ("repave") and the note names one from a different class
 *   ("reassess") and none from the source's. The classes group synonyms, so
 *   "fix" for "repair" is a paraphrase and "review" for "repave" is not.
 * - **A question written as a claim.** The source is a question and the note
 *   states something, with no question mark and no word marking it open.
 *
 * NO SUPPORT ANYWHERE, before anything is reported. A note is only an
 * inversion when NO sentence it matches supports it: a problem the room later
 * called a benefit, or a question somebody answered, is a note about the
 * later sentence, not an inversion of the earlier one. That rule is what keeps
 * a faithful set of notes at zero findings.
 *
 * THE LIMITS ARE REAL. It is lexical, so an inversion in words outside these
 * lists ("cheap" for "expensive") is not seen, and a note matched to the
 * wrong sentence can be misjudged. It errs towards silence: every finding
 * needs a matched source, a word from a closed list, and no supporting
 * sentence at all.
 */

import { contentWords, sentencesOf, stem } from './notes-idea-coverage.ts';
import { allBullets, plainWords } from './notes-quality.ts';

/** One note that says something its source did not. */
export interface InvertedNote {
  kind: 'problem-as-benefit' | 'benefit-as-problem' | 'verb-swap' | 'question-as-claim';
  /** The note as written. */
  bullet: string;
  /** The spoken sentence it was matched to, quoted. */
  source: string;
  /** What changed, in a few words. */
  detail: string;
}

const stems = (words: string): Set<string> => new Set(words.split(' ').map((w) => stem(w)));

const PROBLEM = stems(
  'problem problems issue issues complaint complaints complain broken fail failure failing ' +
    'hazard danger dangerous unsafe risk risky worse worst trouble concern drawback downside ' +
    'obstacle struggle difficult damage damaged bad poor bottleneck blocker',
);

const BENEFIT = stems(
  'benefit benefits beneficial advantage advantages improve improves improvement help helps ' +
    'helpful better best easier upside gain positive strength win boost opportunity',
);

/**
 * Actions, grouped so a synonym stays in its class. A note that trades a
 * word for another in the same class is paraphrasing; one that crosses
 * classes has changed what is going to be done.
 *
 * ONLY VERBS WITH ONE READING. "Raise", "add", "build", "open", "close",
 * "cut", "review" and "lower" are left out: each has an everyday sense that
 * crosses these classes in a faithful note ("Bob will raise the pricing
 * issue" is "Bob to add pricing to the agenda").
 */
const ACTION_CLASSES: readonly (readonly string[])[] = [
  ['repave', 'resurface', 'pave', 'tarmac'],
  ['repair', 'fix', 'patch', 'mend'],
  ['rebuild', 'reconstruct', 'replace'],
  ['assess', 'reassess', 'study', 'evaluate', 'survey', 'inspect', 'audit', 'examine'],
  ['shut'],
  ['reopen'],
  ['remove', 'demolish', 'eliminate', 'scrap'],
  ['install', 'expand', 'extend', 'widen'],
  ['narrow', 'reduce', 'shrink'],
  ['fund', 'finance'],
  ['delay', 'postpone', 'defer'],
  ['approve', 'accept', 'adopt'],
  ['reject', 'decline', 'refuse', 'deny'],
  ['increase'],
  ['decrease'],
  ['buy', 'purchase'],
  ['hire', 'rent', 'lease'],
  ['sell'],
];

const ACTION_OF = new Map<string, { cls: number; word: string }>();
for (const [cls, words] of ACTION_CLASSES.entries()) {
  for (const word of words) ACTION_OF.set(stem(word), { cls, word });
}

/**
 * A note asking for something to get better: a remedy for a problem, not a
 * claim that it is a benefit ("the docs are a problem" is "docs need to be
 * better").
 */
const REMEDY = /\b(?:needs?|should|must|has to|have to|ought to)\b/i;

/**
 * A question that only asks for agreement ("We launch Friday, right?"): the
 * speaker stated the thing, so a note stating it is faithful.
 */
const TAG_QUESTION = /,\s*(?:right|yeah|yes|ok|okay|correct|no)\s*\?\s*$/i;

/** Words that mark a note as still open rather than a statement. */
const OPEN_MARK =
  /\?|\b(?:question|ask|asks|asked|asking|whether|unclear|unknown|open|unsure|tbd|who|how|what|when|where|why|which)\b/i;

/** The note's words with its packaging off: speaker tags, links, labels. */
function noteText(bullet: string): string {
  return plainWords(bullet)
    .join(' ')
    .replace(/^\s*(?:decision|question|action|next step)\s*:\s*/i, '');
}

const hasAny = (words: readonly string[], set: ReadonlySet<string>): boolean =>
  words.some((w) => set.has(w));

function actionsOf(words: readonly string[]): Map<number, string> {
  const out = new Map<number, string>();
  for (const w of words) {
    const hit = ACTION_OF.get(w);
    if (hit && !out.has(hit.cls)) out.set(hit.cls, hit.word);
  }
  return out;
}

interface Spoken {
  text: string;
  words: string[];
  question: boolean;
}

/** The fewest content words a note must share with a sentence to be about it. */
export const MIN_SHARED_WORDS = 2;
/** The share of a note's content words a sentence must carry. */
export const MIN_SHARED_SHARE = 0.5;

/** The sentences a note is about, best match first. */
function matchesOf(words: readonly string[], spoken: readonly Spoken[]): Spoken[] {
  if (words.length === 0) return [];
  const scored: Array<{ s: Spoken; shared: number }> = [];
  for (const s of spoken) {
    const have = new Set(s.words);
    const shared = words.filter((w) => have.has(w)).length;
    if (shared >= MIN_SHARED_WORDS && shared / words.length >= MIN_SHARED_SHARE) {
      scored.push({ s, shared });
    }
  }
  return scored.sort((a, b) => b.shared - a.shared).map((x) => x.s);
}

/** Judge one note against the sentences it matches. */
function judgeNote(bullet: string, matches: readonly Spoken[]): InvertedNote | null {
  const source = matches[0];
  if (!source) return null;
  const text = noteText(bullet);
  const words = contentWords(text);
  const base = { bullet: bullet.trim(), source: source.text };

  const noteBenefit = hasAny(words, BENEFIT) && !REMEDY.test(text);
  const noteProblem = hasAny(words, PROBLEM);
  if (noteBenefit && !noteProblem && hasAny(source.words, PROBLEM)) {
    if (!matches.some((m) => hasAny(m.words, BENEFIT))) {
      return { ...base, kind: 'problem-as-benefit', detail: 'a stated problem reads as a benefit' };
    }
  }
  if (noteProblem && !noteBenefit && hasAny(source.words, BENEFIT)) {
    if (!matches.some((m) => hasAny(m.words, PROBLEM))) {
      return { ...base, kind: 'benefit-as-problem', detail: 'a stated benefit reads as a problem' };
    }
  }

  const noteActions = actionsOf(words);
  const sourceActions = actionsOf(source.words);
  const added = [...noteActions].filter(([cls]) => !sourceActions.has(cls));
  const lost = [...sourceActions].filter(([cls]) => !noteActions.has(cls));
  if (added.length > 0 && lost.length > 0) {
    const supported = matches.some((m) => {
      const own = actionsOf(m.words);
      return added.every(([cls]) => own.has(cls));
    });
    if (!supported) {
      return {
        ...base,
        kind: 'verb-swap',
        detail: `"${lost[0]![1]}" became "${added[0]![1]}"`,
      };
    }
  }

  if (source.question && !OPEN_MARK.test(bullet)) {
    if (!matches.some((m) => !m.question)) {
      return { ...base, kind: 'question-as-claim', detail: 'a question reads as a statement' };
    }
  }
  return null;
}

/**
 * The notes that invert what was said, each with the sentence it came from.
 *
 * `transcript` is the meeting's settled turns; `notes` its notes as markdown.
 */
export function invertedNotes(
  notes: string,
  transcript: readonly { text: string }[],
): InvertedNote[] {
  const spoken: Spoken[] = transcript.flatMap((turn) =>
    sentencesOf(turn.text).map((text) => ({
      text,
      words: contentWords(text),
      question: /\?\s*$/.test(text) && !TAG_QUESTION.test(text),
    })),
  );
  if (spoken.length === 0) return [];
  const out: InvertedNote[] = [];
  for (const bullet of allBullets(notes)) {
    const found = judgeNote(bullet, matchesOf(contentWords(noteText(bullet)), spoken));
    if (found) out.push(found);
  }
  return out;
}
