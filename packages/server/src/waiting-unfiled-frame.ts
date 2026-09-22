/**
 * The ONE fleet frame Team Lead is woken with, built and nothing else.
 *
 * A wake is a session's whole turn (`stall-nudge.ts`'s wake economics), and
 * the fact being reported is the same fact however many boards it spans — so
 * the frame carries every due task and is addressed once, even though the
 * review ITEM the same finding lands on is filed per board
 * (`waiting-unfiled-escalation.ts`).
 *
 * ── Every row says which board it is on ─────────────────────────────────
 *
 * The fan-in is deliberate; what was not is that the frame's SHAPE could not
 * express it. `unfiled` used to be mapped without `workspaceId`, so every row
 * it carried was read under the frame's single top-level tag — `due[0]`'s
 * board. Measured 2026-09-17: one frame tagged with one board named three
 * rows belonging to three different boards, one of which does not appear in
 * the tagged board's events file at all. The receiving lead could only tell
 * which row was its own by recognising the id, and its "read my own board,
 * route anything else to its lead" rule had nothing in the event to stand on.
 *
 * It also explained the frame's oddest symptom: the same row quoted in two
 * frames with the IDENTICAL quiet time. Not two computations that agreed —
 * `waitingUnfiledRows` copies each board's already-rendered row, so the
 * board's own wake and this one carry the same number.
 *
 * So each row keeps its board here, and the frame's own `workspaceId` stays
 * the ANCHOR's board, which is what `taskId` and `title` name.
 *
 * Its own module so that what Team Lead reads can be driven directly, without
 * a reach to send it through — the same seam `waiting-unfiled-review.ts` is
 * on for the item's words.
 */
import { STALL_EVENT, type StallNudgeFrame } from './stall-nudge.ts';
import type { AgingWait } from './waiting-unfiled-review.ts';

/** The frame for one tick's due rows, addressed on `onBoard`. */
export function buildFleetFrame(input: {
  due: readonly AgingWait[];
  /** The board Team Lead holds a stream on — the frame's tag only when no
   *  row is carrying one, which is a frame with no rows. */
  onBoard: string;
  now: number;
}): StallNudgeFrame {
  const { due, onBoard, now } = input;
  const top = due[0];
  return {
    event: STALL_EVENT,
    workspaceId: top?.workspaceId ?? onBoard,
    ...(top ? { taskId: top.taskId, title: top.title } : {}),
    stalledCount: 0,
    consideredCount: due.length,
    // Each task's OWN bucket: the frame is what Team Lead reads to decide
    // whose ask this is, and a bucket word is how a reader tells one kind of
    // evidence from another.
    unfiled: due.map((row) => ({
      id: row.taskId,
      title: row.title,
      bucket: row.bucket,
      quietMs: row.quietMs,
      workspaceId: row.workspaceId,
    })),
    ts: now,
  };
}
