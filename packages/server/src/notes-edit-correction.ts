/**
 * Whether a note the note-taker writes is the speaker CORRECTING one it wrote
 * before — so the reader is left the correction, not the withdrawn note beside
 * it.
 *
 * Two edits can carry a correction, and `notes-edit-guard.ts` asks this module
 * about both:
 *
 * - **A replace** of the note. RULE 2 there turns a replace that drops the
 *   note's words into an insert, so both stand; a correction shares the
 *   subject and little else, so without `correctsIt` it would be kept twice.
 * - **An insert** beside the note (`correctedNote`). Measured on 2026-09-14,
 *   replaying a fictional correction meeting: once a replace was judged
 *   correctly, every remaining run that left the withdrawn note had never sent
 *   a replace at all. The model wrote "track incoming requests instead of hour
 *   estimates" as a NEW bullet under the note that gave the estimates, and the
 *   guard never saw an edit to judge.
 *
 * SPEECH IS THE ARBITER, as it is for the replace: the notes cannot tell a
 * correction from a new idea about the same subject; the speaker's own
 * "instead" can. The insert path is held to more than the replace path,
 * because an insert is the model saying "two notes" and a replace is the
 * model saying "one": exactly one note may answer, it must have nothing
 * nested under it, and nobody may have commented on it.
 */

import type { prose } from '@claude-workspaces/core';
import { contentWords, sentencesOf } from './notes-idea-coverage.ts';

/**
 * What a speaker says when they take back what they said before. Lexical and
 * short, like the decision cues: a phrase missing here leaves two notes, the
 * visible direction, and a loose one lets a new idea overwrite an old one.
 */
const TAKES_BACK =
  /\b(instead|rather than|no longer|any ?more|scratch that|on second thought|stop|stopp(?:ed|ing)|drop|forget)\b/i;

/** How a note says a thing was withdrawn: the speaker's cues, and the verbs
 *  the note-taker writes for them ("stop showing" is written "remove"). */
const WITHDRAWS = new RegExp(
  `${TAKES_BACK.source}|\\b(remov(?:e|ed|ing)|hid(?:e|ing)|scrap(?:ped)?|replac(?:e|ed|ing))\\b`,
  'i',
);

/**
 * The cue words as `contentWords` stems them, for telling a cue from a subject
 * among words already stemmed: "removing" arrives as "remov", which the
 * pattern above no longer reads.
 */
const CUE_STEMS = new Set(
  contentWords(
    'instead anymore stop stopped stopping drop forget remove removed removing hide hiding ' +
      'scrap scrapped replace replaced replacing',
  ),
);

/** A markdown line that is one bullet and its words. */
const ONE_BULLET = /^\s*(?:[-*+]|\d+[.)])\s+\S/;

/** The content words of `was` that no other block of the section carries. */
export function ownWords(
  was: prose.OutlineEntry,
  outline: readonly prose.OutlineEntry[],
  section: ReadonlySet<string> | undefined,
): string[] {
  const shared = new Set(
    outline
      .filter((e) => e.id !== was.id && section?.has(e.id) === true)
      .flatMap((e) => contentWords(e.text)),
  );
  return contentWords(was.text).filter((w) => !shared.has(w));
}

/**
 * Whether `now` is the speaker correcting the note whose own words are `own`,
 * which the tick heard them do. Three things, all lexical:
 *
 * 1. `now` names a word only that note had — its subject;
 * 2. one clause of `now` withdraws that subject: a withdrawing word and a
 *    subject word in the same clause, so "hour estimates stay; the run stops"
 *    withdraws the run, not the estimates;
 * 3. one sentence of the speech takes something back and shares two words with
 *    `now` beyond the cue, so the correction is one the tick heard — and names
 *    the note's subject twice between them: two of its own words in `now`, or
 *    two in the take-back itself.
 *
 * The speech is matched against `now`, not the note, because the note-taker
 * paraphrases both ways: the speaker withdrew "hour guesses", the old note
 * said "time estimates", and the correction said "stop showing time
 * estimates, count requests instead". Speech and note share no word there;
 * speech and correction share "showing", "count" and "requests".
 *
 * WHY A CORRECTION IS APPLIED AS A REPLACE (2026-09-14). A correction shares
 * the subject and little else — "the hour guesses are far off" becomes "stop
 * showing hour guesses, count requests instead" — so the word share reads it
 * as a different note and keeps both, and the reader is left the note the
 * speaker withdrew beside the one that withdrew it.
 *
 * WHY ONE SUBJECT WORD CAN BE ENOUGH (2026-09-14). A topic's words sit in its
 * heading, so they are nobody's own: under `### Hull patch`, "Hull patch took
 * three hours; estimate was forty minutes" corrected to "track incoming
 * requests instead of the board estimate" names one own word, "estimate". The
 * speaker, "forget the estimated hours", named two. Either side naming the
 * subject twice is the evidence; one word on each is not, which is what keeps
 * "the hull crew goes home early instead" from withdrawing a note about the
 * hull patch.
 */
export function correctsIt(
  own: readonly string[],
  now: string,
  speech: readonly string[],
  opts: { named?: 'anywhere' | 'after-cue' } = {},
): boolean {
  const has = new Set(contentWords(now));
  const subject = new Set(own.filter((w) => has.has(w)));
  if (subject.size === 0) return false;
  const withdrawn = now
    .split(/[;:.,!?]|\s[-–—]\s/)
    .some((clause) => withdrawsSubject(clause, subject, opts.named ?? 'anywhere'));
  if (!withdrawn) return false;
  const reported = [...has].filter((w) => !CUE_STEMS.has(w));
  return speech
    .flatMap((s) => sentencesOf(s))
    .some((sentence) => {
      if (!TAKES_BACK.test(sentence)) return false;
      const said = new Set(contentWords(sentence));
      if (reported.filter((w) => said.has(w)).length < 2) return false;
      return subject.size >= 2 || own.filter((w) => said.has(w)).length >= 2;
    });
}

/**
 * Whether one clause withdraws a subject word: a withdrawing word, and a
 * subject word anywhere in the clause — or, `after-cue`, a subject word AFTER
 * a withdrawing word that is not one itself.
 *
 * WHY THE INSERT PATH READS THE ORDER. "Track incoming requests instead of
 * hour estimates" withdraws what follows the cue, and that is the note's
 * subject. "Print the checklist at the yard instead of emailing it" names the
 * note's subject too — before the cue — and withdraws the emailing, which the
 * note never said; and "show urgent requests first instead of hiding them"
 * withdraws the hiding a note complained about, which is a fix, not a
 * take-back. A replace is the model already saying the two are one note, so
 * it keeps the looser reading, which a passive "hour estimates dropped" needs.
 */
function withdrawsSubject(
  clause: string,
  subject: ReadonlySet<string>,
  named: 'anywhere' | 'after-cue',
): boolean {
  const cue = new RegExp(WITHDRAWS.source, 'gi');
  const first = cue.exec(clause);
  if (first === null) return false;
  if (named === 'anywhere') return contentWords(clause).some((w) => subject.has(w));
  return contentWords(clause.slice(first.index + first[0].length)).some(
    (w) => subject.has(w) && !CUE_STEMS.has(w),
  );
}

/** What `correctedNote` needs to know about the section. */
export interface CorrectionScope {
  outline: readonly prose.OutlineEntry[];
  /** This meeting's section, as `sectionIds` walks it. */
  section: ReadonlySet<string>;
  speech: readonly string[];
  /** The heading the insert lands under: only a note under it can answer, so a
   *  correction never takes over a note in another topic. */
  headingId: string;
  /** The note-taker's author id: a note another author wrote never answers,
   *  because a replace of it becomes a suggestion, not the correction. */
  authorId: string;
  /** Blocks somebody has commented on: never the note a correction replaces. */
  commented?: ReadonlySet<string> | undefined;
}

/**
 * The one note an inserted bullet corrects, when there is exactly one.
 *
 * Only a single bullet line is judged — a batch opening a topic with several
 * notes is writing notes, not taking one back — and only the note-taker's own
 * notes under the insert's own heading answer, with nothing nested under them,
 * because the edit this becomes replaces the whole item where it stands.
 */
export function correctedNote(
  markdown: string,
  scope: CorrectionScope,
): prose.OutlineEntry | undefined {
  const lines = markdown.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length !== 1 || !ONE_BULLET.test(lines[0] ?? '')) return undefined;
  const { outline, section } = scope;
  const answers = outline.filter(
    (e, i) =>
      e.kind === 'listItem' &&
      e.author === scope.authorId &&
      section.has(e.id) &&
      e.underHeadingId === scope.headingId &&
      scope.commented?.has(e.id) !== true &&
      (outline[i + 1]?.depth ?? 0) <= (e.depth ?? 0) &&
      correctsIt(ownWords(e, outline, section), markdown, scope.speech, { named: 'after-cue' }),
  );
  return answers.length === 1 ? answers[0] : undefined;
}
