/**
 * When a task's blockage LIFTED, and whether anything has happened since.
 *
 * The failure it exists for, measured: a task declared a wait on a person for
 * two values; the person answered the item that asked for them; the board
 * recorded the answer and nothing treated it as an event, so the work sat
 * unblocked for 21 hours while the board still read as blocked. The queue did
 * its job at every step — the ask was filed, it was answered, the answer was
 * stored — and the one thing missing was anybody reading the answer as the
 * moment the work could start again.
 *
 * TWO SIGNALS, BOTH EXPLICIT STATE, and no third:
 *
 *  - a review item on the task was ANSWERED (`TaskReviewItem.answer`, or a
 *    comment-borne payload's `answeredAt`); and
 *  - a done-when line moved to `met` while a LATER line is still open — the
 *    builder finished a step and the ticket has steps left.
 *
 * Nothing here reads the task's prose, its status age, or a note. That is the
 * standing rule for this whole family (`keep-moving.ts`), and it is the rule
 * the false claims on this task's own ticket broke: the task that looked most
 * like this failure "read as parked at 44.6 hours by its status timestamp
 * while its own proofs showed a merged, deployed PR".
 *
 * ── The negative control this module is shaped by ────────────────────────
 *
 * On the same board, the same evening, a task carried an answered item AND an
 * open done-when line and was working perfectly: a five-helper plan posted at
 * 12:21:28Z, its first report at 13:53:30Z, and the done-when line marked met
 * at 13:54:31Z quoting that report. Sixty-one seconds from the answer to the
 * line. From the outside that task looked exactly like the 21-hour one.
 *
 * So the lift is never a finding by itself. `unresumedSince` asks TWO things
 * of it, and both are about the task's own activity clock rather than about
 * the lift's existence:
 *
 *  1. the lift is older than the board's quiet window — an answer that landed
 *     a minute ago is one the holder may be reading right now; and
 *  2. NOTHING has touched the task since the lift. The caller passes the
 *     classifier's `sinceActivityMs` — the newest of status change, board
 *     event, thread activity and Activity note — so this is the same clock
 *     every other finding runs on rather than a second one.
 *
 * The connector task fails both: its last activity is a minute after the line,
 * and the line is a minute old. It would fail (2) even with no window at all,
 * which is the property that matters — the window is the cheap guard and the
 * activity read is the load-bearing one.
 */

import type { DoneWhenLine } from '@claude-workspaces/core/done-when';

/** Which of the two explicit signals says the blockage lifted. */
export type LiftKind = 'review-item-answered' | 'done-when-met';

/** A blockage that lifted, and what lifted it — carried onto the finding so a
 *  reader can check the event rather than take the finding's word for it, the
 *  way `ungatedUi` carries the file that convicted a row. */
export interface Lift {
  kind: LiftKind;
  /** When the lift happened, by the board's own record of it: the answer's
   *  timestamp, or the met line's. */
  at: number;
  /** What is now unblocked, in the board's own words — the item's headline,
   *  or the met line's text. */
  what: string;
  /** What is still open: the first open line AFTER the met one. Present only
   *  on a `done-when-met` lift, where it is what the work restarts on. */
  next?: string;
}

/** One answered ask on the task, from whichever surface holds it. The caller
 *  reads both — a ticket-borne item's `answer.ts`, a comment-borne payload's
 *  `answeredAt` — for the same reason `noteClocks` is read by the caller: the
 *  stores live out there and this module stays pure. */
export interface AnsweredAsk {
  at: number;
  headline: string;
}

export interface LiftInput {
  /** Every ANSWERED ask on the task, in any order. */
  answered?: readonly AnsweredAsk[];
  /** The task's done-when lines, in their own order — the order is the
   *  signal, so a caller must not sort them. */
  doneWhen?: readonly DoneWhenLine[];
}

/**
 * The task's NEWEST lift, or `undefined` when neither signal is present.
 *
 * Newest rather than oldest, and that is the conservative direction: a task
 * whose item was answered on Monday and whose done-when line landed a minute
 * ago is a task that is moving, and measuring from Monday would name it. The
 * lift the finding rests on is always the most recent moment the board can
 * point to and say "it could have started here".
 *
 * A met line with no `at` is skipped rather than defaulted: the stamp is what
 * the whole reading is measured from, and a line carrying none would be
 * measured from the epoch — an instant finding on a task nobody has touched
 * the reporting of.
 */
export function liftOf(input: LiftInput): Lift | undefined {
  let best: Lift | undefined;
  const keep = (next: Lift): void => {
    if (best === undefined || next.at > best.at) best = next;
  };
  for (const ask of input.answered ?? []) {
    if (typeof ask.at !== 'number' || ask.at <= 0) continue;
    keep({ kind: 'review-item-answered', at: ask.at, what: ask.headline });
  }
  const lines = input.doneWhen ?? [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined || line.verdict !== 'met') continue;
    if (typeof line.at !== 'number' || line.at <= 0) continue;
    // LATER, not merely elsewhere. A task whose LAST open line just went met
    // is finishing, not resuming — there is no next step for anybody to
    // restart — and naming it would turn the moment a ticket completes into a
    // wake. So the remainder is read forward from the met line, and a met
    // line with nothing open after it is not a lift at all.
    //
    // The cost of reading it forward rather than over the whole list is a
    // miss: line 3 of 3 going met while lines 1 and 2 are still open is a
    // resumption this says nothing about. That is the cheap direction and the
    // one this family takes everywhere — a false positive here spends a lead's
    // turn on work that is going fine, which is what the connector timeline
    // above is a standing reminder of.
    const next = lines.slice(i + 1).find((l) => l.verdict !== 'met');
    if (next === undefined) continue;
    keep({ kind: 'done-when-met', at: line.at, what: line.text, next: next.text });
  }
  return best;
}

/**
 * How far a lift's stamp may sit BEHIND the row edit it causes and still be
 * one action rather than two.
 *
 * It exists because the lift's own write is itself activity: answering an item
 * stamps `task.updatedAt`, and so does reporting a done-when line, so without
 * any tolerance the newest activity would always be at-or-after every lift and
 * the finding could never fire.
 *
 * MEASURED rather than assumed, against a real server on 2026-09-17: both
 * writes are stamped from one clock read inside the handling request, so
 * `updatedAt - answer.ts` and `updatedAt - line.at` were **0 ms** on both
 * paths, and no thread mirror was written at all. 250 ms is that measurement
 * plus headroom for a loaded box — deliberately three orders of magnitude
 * under the default quiet window, because every millisecond of it is a
 * millisecond in which real work would be mistaken for the lift's own write.
 * It is NOT `EVENT_TICK_EPSILON_MS`'s five seconds: that number covers a note
 * carrying the POSTER's clock across the network, and both signals here are
 * stamped by the server that stores them.
 */
export const LIFT_CLOCK_EPSILON_MS = 250;

/**
 * Has this lift stood past the window with NOTHING done about it?
 *
 * `sinceActivityMs` is the classifier's reading — the newest of status change,
 * board event, thread activity and Activity note — and is the only clock here.
 * There is deliberately no second one: a status age measured on its own said a
 * task was parked for 44.6 hours while its own proofs showed a merged,
 * deployed PR.
 */
export function unresumedSince(
  lift: Lift,
  facts: { now: number; sinceActivityMs: number; quietMs: number },
): boolean {
  const liftedMs = facts.now - lift.at;
  // A lift inside the window — or stamped in the future by a skewed clock —
  // is not a finding. Sixty-one seconds was enough for the control case.
  if (liftedMs <= facts.quietMs) return false;
  // And nothing since. `liftedMs <= sinceActivityMs` says the newest activity
  // on the row is no newer than the lift itself.
  return liftedMs <= facts.sinceActivityMs + LIFT_CLOCK_EPSILON_MS;
}
