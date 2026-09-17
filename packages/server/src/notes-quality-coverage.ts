/**
 * Did what was said reach a note — and, first, could the notes be read at all.
 *
 * WHY IT IS ITS OWN MODULE. The lexical half of this used to sit in
 * `notes-quality-report.ts` beside every other check. It is the only check
 * whose answer depends on something OUTSIDE the notes — the transcript — and
 * so the only one whose number stays well-formed when the notes reading
 * fails. Every other check over an empty reading reports zero of something,
 * which is obviously nothing; this one reports 100% of everything, which
 * reads exactly like a real verdict. Splitting it out is what let the third
 * state be written down once, in the type, rather than remembered at each
 * call site.
 *
 * THE FAILURE THIS MODULE'S SHAPE EXISTS TO END. On 2026-09-15 one meeting's
 * notes-quality item was filed seven times on the same doc with the same
 * headline, the denominator climbing 15, 33, 75, 160, 199, 262, each one
 * saying that 100% of what was said had reached no note. 172 notes had been
 * written. The arithmetic was right every time and the divisor was broken:
 * `bullets` was pinned at 0, so every idea was uncovered by construction, so
 * the flag could never clear, so every re-check re-filed. A verdict that
 * cannot come out any other way is not a verdict.
 *
 * THE CHECK IS LEXICAL AND ITS LIMITS ARE REAL. "Was this idea written down"
 * is answered by content-word overlap between one settled sentence and the
 * whole notes text. Three things it cannot do, and a reader of its number has
 * to know all three:
 *
 *   - **A paraphrase with no shared nouns reads as a miss.** "We'll ship it
 *     Tuesday" noted as "release lands early next week" shares nothing this
 *     can see. So the number is an UPPER bound on what was lost.
 *   - **An unrelated bullet about the same subject reads as coverage.** The
 *     overlap is against the whole notes text rather than against one bullet,
 *     so a topic mentioned anywhere absolves every sentence about it.
 *   - **It has no idea what mattered.** A settled sentence is an idea if it
 *     carries enough content words, which counts a long aside and skips a
 *     short decision.
 *
 * The model-judged version of the same question lives in the eval harness,
 * over a corpus, and is the number to trust about the RATE. This one is the
 * number to trust about THIS meeting having gone wrong, and its errors are
 * deliberately asymmetric: it over-reports misses, so a meeting it calls
 * clean is very likely clean.
 */

// ONE VOCABULARY, and `notes-idea-coverage.ts` is the server's door to it.
// This module shipped with its own `STOPWORDS`, `stem` and `contentWords`,
// one directory from the maintained versions and several fixes behind them —
// core's stemmer had already been taught that "estimates" and "estimated"
// are one word, and this copy had not. Two lexicons mean the board and this
// check can disagree about what a meeting said.
import { contentWords, sentencesOf } from './notes-idea-coverage.ts';
import { MIN_IDEAS_FOR_COVERAGE } from './notes-quality-thresholds.ts';

export { contentWords };

/** One settled turn, as much of it as this module reads. Structural on
 *  purpose: `TranscriptTurn` from `meetings.ts` satisfies it, and so does a
 *  literal in a test, without this module importing anything that reads a
 *  file. */
export interface SpokenTurn {
  text: string;
  /** The engine's label for the voice. */
  speaker?: string;
  /** When the turn settled. Only the lateness reading uses it. */
  ts?: number;
}

/**
 * Where the coverage numbers came from.
 *
 * `unreadable` is NOT "the notes covered nothing". It is "this reading cannot
 * say", and the two used to produce the same number. Nothing downstream may
 * turn an `unreadable` coverage into a share, a percentage or a flag about
 * the meeting's notes — see {@link coverageOf}.
 */
export type CoverageSource = 'notes' | 'unreadable';

/** Ideas heard, and how many of them a reading can account for. */
export interface NotesCoverage {
  source: CoverageSource;
  /** Ideas heard. Read off the transcript, so it is known either way. */
  ideas: number;
  /** Ideas no note accounts for. `null` when the notes could not be read —
   *  the count is unknown then, and 0 and `ideas` are both lies. */
  uncoveredIdeas: number | null;
  /** `null` when the notes could not be read, and `null` when the meeting
   *  held too few ideas for a share to mean anything. `source` says which. */
  uncoveredShare: number | null;
  /** What could not be read, in words, when `source` is `unreadable`. */
  missing?: string;
}

/**
 * The share of an idea's content words that has to appear in the notes before
 * it counts as written down. Two fifths, for the reason
 * `MAX_UNCOVERED_IDEA_SHARE` gives: notes paraphrase, so an exact-words test
 * would report every good note as a miss.
 */
export const IDEA_OVERLAP_SHARE = 0.4;

/**
 * The fewest DISTINCT content words a settled sentence needs before this
 * check treats it as an idea the notes owed. "Right." and "Yeah, exactly"
 * are not ideas.
 *
 * NOT `MIN_IDEA_CONTENT_WORDS` from `notes-idea-coverage.ts`, which is 2 and
 * is deliberately a different number: that check feeds the note-taker's own
 * decisions and wants every idea it can find, while this one feeds a review
 * item that wakes a person, and a four-word floor keeps a short aside from
 * counting against a meeting. The two checks otherwise ask the same question
 * of the same lexicon, and collapsing them into one is worth doing — as its
 * own change, with the operating point re-measured, not as a side effect of
 * this one. The name differs from the other so a reader cannot import the
 * wrong bar believing they are the same constant.
 */
export const MIN_QUALITY_IDEA_WORDS = 4;

/** The sentences of a meeting that carried enough to be worth a note. */
export function spokenIdeas(transcript: readonly SpokenTurn[]): string[][] {
  const out: string[][] = [];
  for (const turn of transcript) {
    for (const sentence of sentencesOf(turn.text)) {
      const words = contentWords(sentence);
      if (words.length >= MIN_QUALITY_IDEA_WORDS) out.push(words);
    }
  }
  return out;
}

/** The ideas whose words the notes do not carry. */
export function uncoveredIdeaCount(
  notes: string,
  transcript: readonly SpokenTurn[],
): {
  ideas: number;
  uncovered: number;
} {
  const ideas = spokenIdeas(transcript);
  const noted = new Set(contentWords(notes));
  let uncovered = 0;
  for (const idea of ideas) {
    const hit = idea.filter((w) => noted.has(w)).length;
    if (hit / idea.length < IDEA_OVERLAP_SHARE) uncovered++;
  }
  return { ideas: ideas.length, uncovered };
}

/**
 * The coverage reading for one meeting.
 *
 * `read` is whether the notes text handed in is a reading of this meeting's
 * notes at all. It is false for a document that could not be reached and for
 * one whose blocks this reading claimed none of, and the difference it makes
 * is the whole point of the module: a reading that failed produces no count,
 * no share and — in `notes-quality-report.ts` — no coverage flag. The ideas
 * are still counted, because the transcript was read either way and "we heard
 * 262 things and cannot say what became of them" is a more useful sentence
 * than a missing number.
 */
export function coverageOf(
  notes: string,
  transcript: readonly SpokenTurn[],
  reading: { read: boolean; missing?: string },
): NotesCoverage {
  if (!reading.read) {
    return {
      source: 'unreadable',
      ideas: spokenIdeas(transcript).length,
      uncoveredIdeas: null,
      uncoveredShare: null,
      ...(reading.missing !== undefined ? { missing: reading.missing } : {}),
    };
  }
  const { ideas, uncovered } = uncoveredIdeaCount(notes, transcript);
  return {
    source: 'notes',
    ideas,
    uncoveredIdeas: uncovered,
    uncoveredShare: ideas >= MIN_IDEAS_FOR_COVERAGE ? uncovered / ideas : null,
  };
}
