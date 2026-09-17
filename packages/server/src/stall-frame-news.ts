/**
 * Three readings the stall wake takes of a frame it is about to send, after
 * `stall-nudge.ts`'s stamp has already said the frame carries news.
 *
 * Measured over a week of the fleet's transcripts, repeat or empty reminders
 * were 11% of all model spend, and a wake is the reader's whole turn. The
 * stamp decides news per finding; these decide it per TASK, from the reader's
 * side of the frame:
 *
 *  - the token helpers — the two findings `StallNudger.newsIds` does not
 *    already tokenise, so the per-session sent set can be compared over
 *    everything a frame names (`wake-sent-sets.ts`).
 *  - `everyNamedTaskMoved` — a frame whose every named task moved inside the
 *    window is not sent yet. The quiet window makes a row a finding; this
 *    makes a FRAME worth a turn, and a frame about work that moved within the
 *    hour is about work somebody is on.
 *  - `withoutPersonBlocked` — a task the board says a PERSON owns, with
 *    nothing on their queue, is not the agent's to unblock. It goes to the
 *    owner's standing item (`waiting-unfiled-escalation.ts`) and wakes nobody.
 */
import { OWNER_UNFILED_BUCKET, type StalledRow } from './stall-gate.ts';
import type { StallNudgeFrame, StallSnapshot } from './stall-nudge.ts';

/**
 * How recently every named task may have moved for a frame to wait.
 *
 * One hour — twice the default quiet window, so a row quiet since its window
 * opened is named once it has stayed quiet for a second one. The wiring
 * derives it from `CW_STALL_NUDGE_MINUTES` the same way, so a server run on a
 * shorter window keeps the same ratio.
 */
export const STALL_MOVED_WITHIN_DEFAULT_MS = 60 * 60_000;

/**
 * A row under the BUCKET it was named in, which the stamp deliberately does
 * not carry (`StallNudger.newsIds` says why: a row moving from
 * `ready-unpicked` to `in-progress` is most often the lead's own dispatch
 * landing, and must not arm a wake).
 *
 * The sent set is a different question — what was this reader handed? — and a
 * row handed over as "quiet" and later as "an unfiled ask" is two different
 * asks of them. It can only ever let through a wake the stamp already armed,
 * so it cannot resurrect the dispatch case: that one never reaches here.
 */
export function rowBucketTokens(rows: ReadonlyArray<{ id: string; bucket: string }>): string[] {
  return rows.map((row) => `bucket:${row.id}:${row.bucket}`);
}

/** A check-in the board is carrying, due or not. */
export function checkInTokens(rows: ReadonlyArray<{ id: string }>): string[] {
  return rows.map((row) => `checkin:${row.id}`);
}

/** A row this pass could not read. Its REASON is part of the token: the same
 *  row becoming unreadable for a different reason is a different finding. */
export function undeterminedTokens(rows: ReadonlyArray<{ id: string; reason: string }>): string[] {
  return rows.map((row) => `undet:${row.id}:${row.reason}`);
}

/**
 * True when every entry the frame names is a task that moved inside
 * `withinMs`. Only lists that carry a silence reading can say a task moved;
 * a frame naming anything else — a held item, a question asked back, an
 * unanswered thread, a row built past the UI gate, an unreadable row — is
 * never held back by this, because nothing on it says the work is moving.
 *
 * A DUE CHECK-IN is on that second list rather than the first, though it
 * carries a `quietMs` like a stall does. A check-in asks its holder for a
 * word; it is not a report that work stopped, and its whole window lives
 * inside this one — 30 minutes to fall due, 60 before the same row is a
 * silent builder. Reading it as movement would not delay the check-in, it
 * would delete it, because by the time the frame could go the row has become
 * the louder finding. So the deferral covers stalls and leaves the ask alone.
 */
export function everyNamedTaskMoved(frame: StallNudgeFrame, withinMs: number): boolean {
  if (withinMs <= 0) return false;
  if (
    (frame.heldItems?.length ?? 0) > 0 ||
    (frame.askedBack?.length ?? 0) > 0 ||
    (frame.unanswered?.length ?? 0) > 0 ||
    (frame.ungatedUi?.length ?? 0) > 0 ||
    (frame.checkIn?.length ?? 0) > 0 ||
    frame.undetermined !== undefined
  )
    return false;
  const quiet: Array<{ quietMs: number }> = [
    ...(frame.rows ?? []),
    ...(frame.unfiled ?? []),
    ...(frame.unresumed ?? []),
  ];
  return quiet.length > 0 && quiet.every((row) => row.quietMs < withinMs);
}

/** A row the board says a person owns with nothing on their queue. */
export function isPersonBlocked(row: StalledRow): boolean {
  return row.bucket === OWNER_UNFILED_BUCKET;
}

/** The board as the lead's wake and the dead-board escalation read it: the
 *  person-blocked rows taken off `unfiled`. The fleet pass still reads the
 *  whole snapshot, which is how those rows reach the owner's queue. */
export function withoutPersonBlocked(board: StallSnapshot): StallSnapshot {
  if (!board.unfiled.some(isPersonBlocked)) return board;
  return { ...board, unfiled: board.unfiled.filter((row) => !isPersonBlocked(row)) };
}
