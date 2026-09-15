/**
 * What the raw transcript SHOWS a person, given the turns a meeting stored.
 *
 * WHY THIS EXISTS. A row in `<docname>-raw-transcript.md` is whatever the
 * engine called a turn, and a turn is a unit of the engine's job rather than
 * of reading. Measured over a real 41-minute meeting: 181 of its 355 rows
 * were three words or fewer and carried 4% of everything said, 130 rows were
 * exact repeats of only 15 distinct texts, and at the other end 14 rows
 * carried 41% of the words with the longest at 266. So the reader watched a
 * row arrive every few seconds, nearly all of it acknowledgement, while the
 * substance sat in a handful of walls. Both ends are the same defect, and it
 * is a defect of PRESENTATION: nothing was wrong with the turns.
 *
 * WHY IT IS A RESHAPE AND NEVER A FILTER. Every word that went in comes out —
 * folded acknowledgement rides on the row it answered, still attributed to
 * the voice that said it, still in the order it was said. That is what makes
 * the judgement calls below safe to get wrong: a fold this module should not
 * have made costs a line its own bullet, not its words. A filter would have
 * to be right every time, and no lexical rule is.
 *
 * WHY HERE AND NOT IN THE RECORD. The server's `meetings.ts` owns the
 * append-only JSONL a replay lines PCM up against, and the engine seam
 * revises a turn in place long after it first settles — a fold applied there
 * would have to renumber or drop stored turns, and would be folding text that
 * is still being rewritten. This module is pure, is handed the turns only
 * once, and changes no stored byte.
 *
 * WHY IT IS IN `core`. Two surfaces show a meeting's words as a list of rows,
 * and until this moved they each built that list themselves: the server
 * composes `<docname>-raw-transcript.md` at stop (`formatRawSegment`), and the
 * board's Transcript fold composes the same grammar in the browser off the
 * REST record (`loadDocTranscript`). Two implementations of one grammar is two
 * answers to "what was said", so both now call this. The replay script gets it
 * for free, composing through the server's side.
 *
 * WHAT IT DOES NOT REACH, and why that is right rather than an omission: the
 * live strip holds a rolling window of three turns and cannot grow, and the
 * live zone at the end of the doc is one flowing run of inline spans with no
 * per-turn block at all (owner, 2026-09-01: "engine turns have no meaning or
 * value to the viewer, I expect a stream of text"). Neither is a list of rows,
 * so neither has rows to fold.
 */

import { isPureBackchannel, sentencesOf } from './speech-lexicon.ts';
// The repo's one word counter. This module wrote its own for a while, which
// skipped a token holding no letter or digit; the difference never showed on
// engine output, and a second counter is how the "80 words" this module
// enforces drifts away from the 80 words a reader is told about elsewhere.
import { wordCount } from './word-count.ts';

/**
 * The least a turn has to be for this module to place it: its words.
 *
 * Everything else is optional because one of the two callers reads a meeting
 * record back over the wire, where a field is whatever the server that wrote
 * it chose to store. The fold needs none of them to decide anything except
 * `ts`, which it uses only when EVERY turn has one. Structural, so the
 * server's own `TranscriptTurn` and the board's `RecordTurn` both satisfy it
 * without either importing the other.
 */
export interface FoldableTurn {
  text: string;
  /** The stored turn number. Absent on a record that did not number them. */
  turn?: number;
  /** When the turn settled. Absent on a record that stored no clock. */
  ts?: number;
  /** The engine's label for the voice. */
  speaker?: string;
}

/**
 * The most words a row may hold and still be foldable.
 *
 * Three, because that is where the measurement put the acknowledgement: 181
 * rows at three words or fewer held 4% of the meeting. It is a NECESSARY
 * condition and never a sufficient one — the row also has to say nothing
 * (`isPureBackchannel`) or have been said over and over (`REPEAT_FOLD_COUNT`).
 * Length alone would swallow "three weeks".
 */
export const FOLD_MAX_WORDS = 3;

/**
 * How many times the same short text has to appear in one segment before it
 * folds on repetition alone.
 *
 * The strongest signal in the measured meeting is not length: 130 of its rows
 * were repeats of 15 texts, one of them said 54 times. A phrase somebody says
 * fifty times in forty minutes is their verbal tic whatever its content words
 * look like, and this catches the ones the stoplist does not know ("Mm hmm",
 * "Makes sense"). Five, because the frequent texts in that meeting clustered
 * well above it while a phrase that genuinely came up twice stays its own row.
 */
export const REPEAT_FOLD_COUNT = 5;

/**
 * Past how many words a row is broken at a pause.
 *
 * Bryan's number, kept. The one distribution available says the walls average
 * about 170 words, so the bar has to sit well under that; 80 words is roughly
 * half a minute of speech and two or three chunks out of a typical wall. It
 * is not a measurement and the fixture that exercises it is ours, so measuring
 * on it would only measure the fixture.
 */
export const LONG_ROW_WORDS = 80;

/** One short row riding on the row it answered. */
export interface FoldedAnswer {
  /** The engine's label for the voice, exactly as the turn carried it. */
  speaker?: string;
  text: string;
}

/** One row of the rendered transcript, after the reshape. */
export interface FoldedRow {
  /** The stored turn this row opens. Turn numbers are never rewritten. */
  turn?: number;
  /** When that turn settled — the only clock this row may claim. */
  ts?: number;
  speaker?: string;
  /** The row's first chunk of words. */
  text: string;
  /**
   * Chunks two onwards of a row that was broken at a pause. Empty on every
   * row short enough to stand as it is. They carry no clock of their own:
   * the turn settled once, and stamping a chunk would invent the moment.
   */
  continued: readonly string[];
  /** Short rows folded onto this one, in the order they were said. */
  answers: readonly FoldedAnswer[];
}

/** The form two utterances are "the same text" in. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * Text cut into chunks of at most `limit` words, always at a pause.
 *
 * Sentences first, because the engine punctuates a settled turn and a full
 * stop is therefore a real boundary rather than a guess. A single sentence
 * longer than the limit is cut again at its commas — still a pause, just a
 * smaller one. A sentence with neither is left whole: a cut at word 80 of an
 * unpunctuated wall lands mid-phrase, which is worse to read than the wall.
 */
export function breakAtPauses(text: string, limit: number): string[] {
  if (wordCount(text) <= limit) return [text];
  const units: string[] = [];
  for (const sentence of sentencesOf(text)) {
    if (wordCount(sentence) <= limit) {
      units.push(sentence);
      continue;
    }
    for (const clause of sentence.split(/(?<=[,;:])\s+/)) units.push(clause);
  }
  const chunks: string[] = [];
  let current = '';
  for (const unit of units) {
    if (current === '') {
      current = unit;
      continue;
    }
    if (wordCount(current) + wordCount(unit) > limit) {
      chunks.push(current);
      current = unit;
      continue;
    }
    current = `${current} ${unit}`;
  }
  if (current !== '') chunks.push(current);
  return chunks.length > 0 ? chunks : [text];
}

/**
 * Did the last thing said end in a question?
 *
 * Closing quotes and brackets come off first: an engine that punctuates
 * reported speech writes `Are we shipping?"`, and a rule reading the very last
 * character would call that a statement and fold the answer to it away.
 */
function isQuestion(text: string | undefined): boolean {
  if (text === undefined) return false;
  return text
    .trim()
    .replace(/[)\]}'"\u2019\u201d\u00bb]+$/u, '')
    .endsWith('?');
}

export interface FoldOptions {
  /**
   * Moments a fold may not reach across: a gap's start and its return.
   *
   * A gap bullet sits in the rendered run at the instant the words it
   * swallowed would have been, so folding a row from after the outage onto a
   * row from before it would put words on the wrong side of the hole. Rows
   * either side of a barrier stay separate rows.
   */
  barriers?: readonly number[];
  maxWords?: number;
  repeatCount?: number;
  longRowWords?: number;
}

/**
 * The rows to render, from the turns as stored.
 *
 * WHAT SURVIVES AS ITS OWN ROW, which is the whole judgement of this module:
 * anything over three words; anything with a content word that was not said
 * five times or more; and every short row in the RUN that follows a question.
 * Somebody who has just been asked something is answering it, and "No." there
 * is the answer — including the "No." after the "Yeah.", because what both of
 * them follow is still the question. The run ends at the first row that is not
 * a short one, which is where the answering stops and the conversation moves
 * on. The cost, stated plainly, is a bare "No." that answers nothing
 * punctuated as a question — it folds, which is to say it appears on the
 * previous row instead of under it.
 */
export function foldTranscriptRows(
  turns: readonly FoldableTurn[],
  options: FoldOptions = {},
): FoldedRow[] {
  const maxWords = options.maxWords ?? FOLD_MAX_WORDS;
  const repeatCount = options.repeatCount ?? REPEAT_FOLD_COUNT;
  const limit = options.longRowWords ?? LONG_ROW_WORDS;
  const barriers = options.barriers ?? [];

  const seen = new Map<string, number>();
  for (const turn of turns) {
    const key = normalize(turn.text);
    if (key !== '') seen.set(key, (seen.get(key) ?? 0) + 1);
  }

  // IN THE ORDER THEY WILL BE READ, which is not always the order they were
  // stored. A provider that settles a turn twice — rough, then punctuated —
  // leaves the turn where it was in the array and moves its timestamp to the
  // revision, and the file's composer renders every row by timestamp. Folding
  // in array order would then hang a short row on whichever turn was revised
  // last rather than on the one it follows on the page, and would hand the
  // barrier check a decreasing interval that matches no gap at all. The sort
  // is stable, so turns that settled in the same millisecond keep their order.
  //
  // A record with no clock at all keeps its stored order, which is the only
  // order it has. Sorting a mixture would move the timestamped turns around
  // the others for no reason, so it is all or nothing.
  const clocked = turns.every((t) => typeof t.ts === 'number');
  const ordered = clocked
    ? [...turns].sort((a, b) => (a.ts as number) - (b.ts as number))
    : [...turns];

  const rows: FoldedRow[] = [];
  // The last thing SAID, which is not the last row once something has folded
  // onto it — the barrier arithmetic needs the moment, not the row.
  let lastSpoken: { at: number } | null = null;
  // Whether the rows so far are still ANSWERING a question. It survives the
  // first answer: "Did it ship?" — "Yeah." — "No." is three rows, because
  // what the "No." follows is still the question. The first row that is not
  // a short one ends the run.
  let answering = false;

  for (const turn of ordered) {
    const previous = lastSpoken;
    lastSpoken = turn.ts === undefined ? null : { at: turn.ts };
    const anchor = rows[rows.length - 1];
    const key = normalize(turn.text);
    const foldable =
      wordCount(turn.text) <= maxWords &&
      // A question is never acknowledgement, however short and however much
      // of the vocabulary it borrows. "Right?" asks something; folding it
      // away would hide the question AND fold the answer to it, because the
      // run that answers a question only opens on a row that was emitted.
      !isQuestion(turn.text) &&
      (isPureBackchannel(turn.text) || (seen.get(key) ?? 0) >= repeatCount);
    const answersQuestion = answering;
    // WHERE THE BARRIER RENDERS, not merely what it is stamped. The caller
    // orders turns and gap bullets on one clock and keeps turns first on a
    // tie, so a gap stamped at the previous turn's own millisecond is drawn
    // AFTER it, and one stamped at this turn's is drawn after this turn. The
    // bounds follow that rule rather than the arithmetic: half-open the other
    // way round from the obvious reading.
    const crossesBarrier =
      previous !== null &&
      turn.ts !== undefined &&
      barriers.some((b) => b >= previous.at && b < (turn.ts as number));
    if (foldable && anchor !== undefined && !answersQuestion && !crossesBarrier) {
      anchor.answers = [
        ...anchor.answers,
        { ...(turn.speaker !== undefined ? { speaker: turn.speaker } : {}), text: turn.text },
      ];
      continue;
    }
    answering = isQuestion(turn.text) || (answering && foldable);
    const [first = turn.text, ...continued] = breakAtPauses(turn.text, limit);
    rows.push({
      ...(turn.turn !== undefined ? { turn: turn.turn } : {}),
      ...(turn.ts !== undefined ? { ts: turn.ts } : {}),
      ...(turn.speaker !== undefined ? { speaker: turn.speaker } : {}),
      text: first,
      continued,
      answers: [],
    });
  }
  return rows;
}
