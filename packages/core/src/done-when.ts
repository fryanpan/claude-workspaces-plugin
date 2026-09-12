/**
 * Done-when lines — what has to be true before a ticket is finished, said as
 * outcomes and answered one at a time.
 *
 * A FIELD ON THE TASK, not prose in its body. A "Done when" heading somebody
 * typed into a description is words: nothing can count them, nothing can hold
 * a proof against one, and nothing can refuse a move to Done because one is
 * still open. These lines can do all three, which is the whole reason they are
 * data.
 *
 * The shapes live in core rather than beside the store because three sides
 * read them and all three have to agree: the server persists and gates on
 * them, the browser draws one chip per line, and the MCP bundle takes a
 * builder's report over the wire. The pure readers below are here for the same
 * reason — "how many are met" must be one arithmetic, or the row pill and the
 * gate can disagree about whether a ticket is finished.
 *
 * Nothing here touches a clock, a store or a request.
 */

/**
 * What is known about ONE line, and who can say it.
 *
 * Four values, and the split is the point:
 *
 *  - `met` — built AND proved. Needs at least one proof; the report route
 *    refuses the line otherwise, because a line asserted met with nothing
 *    attached is indistinguishable from one nobody looked at.
 *  - `not-met` — measured, and it did not hold. The proof says what happened.
 *  - `unchecked` — built, proof attached, nobody has measured it yet. Absence
 *    of evidence, deliberately distinct from `not-met`, which is evidence of
 *    absence.
 *  - `owner` — only a person can judge this one. It renders as the owner's
 *    check with the proof attached for them to open, and their `Looks right`
 *    is what makes it `met`.
 *
 * A line with NO verdict is one nobody has reported on. That is not a fifth
 * value: absence means the builder has not spoken, and the panel draws no chip
 * at all rather than a chip claiming ignorance.
 */
export type DoneWhenVerdict = 'met' | 'not-met' | 'unchecked' | 'owner';

/** Every verdict a caller may send, for the error message a bad one earns. */
export const DONE_WHEN_VERDICTS: readonly DoneWhenVerdict[] = [
  'met',
  'not-met',
  'unchecked',
  'owner',
];

/**
 * One artifact behind a verdict: what was run or looked at, and where the
 * reader can see it.
 *
 * `text` is what it was ("bun test share-link.test.ts", "Signed-out view at
 * 1180 and 430"). `url` opens it — a report, a shot, a PR. A proof with no
 * `url` is still a proof: a builder that ran something and read the result is
 * saying more than one that ran nothing, and forcing an address would push
 * builders into inventing one.
 */
export interface DoneWhenProof {
  text: string;
  url?: string;
}

/** One line of the list. `id` is server-minted (`d-…`) and stable across
 *  edits, because a report and an owner's check both address a line by it. */
export interface DoneWhenLine {
  id: string;
  text: string;
  /** Absent until a builder reports. See `DoneWhenVerdict`. */
  verdict?: DoneWhenVerdict;
  /** What the builder attached, in the order it attached them. */
  proof?: DoneWhenProof[];
  /** Display name of whoever last spoke for this line — the reporting agent,
   *  or the person who answered an `owner` line. Never an actor id: these
   *  lines are projected to every board viewer (§3.3). */
  by?: string;
  /** When they did. */
  at?: number;
}

/** How many lines carry a verdict of `met`. */
export function doneWhenMetCount(lines: readonly DoneWhenLine[] | undefined): number {
  return (lines ?? []).filter((l) => l.verdict === 'met').length;
}

/**
 * The first line that is not `met`, or `undefined` when every line is.
 *
 * The ONE reader of "is this ticket finished", used by the gate that refuses a
 * manual Done, by the auto-done that fires when the last line lands, and by
 * the refusal message that has to name a line rather than say "something".
 * A ticket with no lines answers `undefined` — nothing is open, so nothing is
 * refused, which is what keeps every task filed before this feature working
 * exactly as it did.
 */
export function firstOpenDoneWhen(
  lines: readonly DoneWhenLine[] | undefined,
): DoneWhenLine | undefined {
  return (lines ?? []).find((l) => l.verdict !== 'met');
}

/** Does this ticket have lines, and are they all met? False for a ticket with
 *  no lines — "every line is met" must not read as true of a ticket that has
 *  never had one, or the auto-done would fire on the first report of nothing. */
export function doneWhenComplete(lines: readonly DoneWhenLine[] | undefined): boolean {
  return (lines ?? []).length > 0 && firstOpenDoneWhen(lines) === undefined;
}

/** The chip a line wears, in the words the panel shows. Spelled here so the
 *  server's refusal message and the browser's chip cannot name the same state
 *  two ways. */
export function doneWhenChipLabel(verdict: DoneWhenVerdict): string {
  if (verdict === 'met') return 'Verified';
  if (verdict === 'not-met') return 'Not verified';
  if (verdict === 'owner') return 'Your check';
  return 'Unverified';
}

/** How long a line's words may be. Generous — a criterion is a sentence, and
 *  a cap that bit would push the real one back into the body prose this field
 *  exists to get it out of. */
/**
 * Why a move to Done is refused, or `undefined` when it is not.
 *
 * The sentence lives beside the reader that decides there is one, so the
 * server's gate and anything else that has to explain the refusal cannot
 * drift into two wordings. It NAMES the line: "it has open criteria" sends a
 * reader back to count them, and this sends them to the one that is not met.
 */
export function doneWhenRefusal(
  title: string,
  lines: readonly DoneWhenLine[] | undefined,
): string | undefined {
  const open = firstOpenDoneWhen(lines);
  if (!open) return undefined;
  return `"${title}" still has a done-when line that is not met: "${open.text}". Report it met with proof, or remove the line if it is no longer what done means.`;
}

export const DONE_WHEN_TEXT_MAX = 500;

/** How many lines one ticket may carry. A ceiling against a runaway caller,
 *  not a design opinion: Bryan's rule is that the count does not matter, so
 *  nothing renders this number and nothing counts down to it. */
export const DONE_WHEN_LINES_MAX = 50;
