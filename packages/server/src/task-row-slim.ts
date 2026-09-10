/**
 * What a task row carries into the board's ydoc, and what it leaves behind
 * for a reader who actually opens it.
 *
 * The board's sync-step-2 hands a fresh tab the WHOLE doc state in one frame,
 * so the cost of opening a board is the size of every row that has ever
 * existed on it — not the size of the list on screen. Measured on the live
 * board on 2026-09-10: 777 rows projecting to 1,001,594 bytes of state,
 * 245,920 on the wire after permessage-deflate, and a phase profile put the
 * wait for those bytes at 59.8% of the load on a 50 Mbps link and 86.2% at
 * 10 Mbps. So the payload is the lever.
 *
 * The first version of this module trimmed CLOSED rows only, on the theory
 * that the default view does not draw them. That theory named the wrong
 * subject. What makes a field cheap to drop is not the row's status — it is
 * **whether any list surface reads the field at all**, and four of the five
 * are read by nothing but the open detail panel whatever the row's status.
 * So the gate is now per FIELD, and each one below names the reader that
 * decides it:
 *
 *   - **`reviews` and `quote` go from every row.** Their only readers are
 *     `heldReviewItems`, `discussionStream` and the panel's "Original words"
 *     block — three surfaces that exist only while a ticket is open on
 *     screen. 14.9% of the wire, carried by 22 rows.
 *   - **`body` and `bodyTruncated` go from every row but an unanswered,
 *     not-done decision** — archived or not, because archiving is not a
 *     status and the decision queue does not filter on it.
 *     The panel mounts the live body doc over `bodySlot`, so the projected
 *     copy is a pre-mount fallback there; the ONE list surface that renders
 *     it is the walkthrough's decision card (`WalkTaskBody`, off
 *     `decisionQueue`'s rows), which never refetches. 21.7% of the wire.
 *   - **`notes` go from rows that have not moved in `DETAIL_FRESH_MS`.**
 *     Home's Recent activity renders the notes of anything that moved inside
 *     `ACTIVITY_WINDOW_MS`, straight off this projection, so that window is
 *     the gate and the two constants are deliberately equal.
 *   - **A transition keeps its four list keys and loses its prose**, on every
 *     row. `doneAt`, the effort model's closed-at / first-seen / wall-clock
 *     readings and the recurrence run records read `ts`/`from`/`to`/`by`;
 *     `note` and `usage` are rendered only in the panel's Activity tab.
 *
 * `detailTrimmed` says on the row itself that something is missing, which is
 * what lets the panel fetch the rest instead of guessing.
 *
 * Two things stay, and they are the near misses:
 *
 *   - **`options` and `infoRequests`.** A few kilobytes in total, and the
 *     walkthrough reads them off the same decision rows whose body it draws.
 *     Nothing here is worth a decision card that renders its blurb with no
 *     buttons under it.
 *   - **The whole transition ARRAY.** Dropping stops, rather than their
 *     prose, would change what the board shows — the done-window filter and
 *     the effort calibration both walk it.
 *
 * Nothing is destroyed: this is the PROJECTION only. The store keeps every
 * field, the sidecar keeps every field, and `GET …/tasks/:id/detail` hands
 * the whole row back to the one surface that wants it.
 */

import { TRIMMED_ROW_FIELDS } from '@claude-workspaces/core/task-wire';

/** A projected row, as `projectTask` returns it. */
export type ProjectedTaskRow = Record<string, unknown>;

/**
 * How recently a row must have moved to keep its notes.
 *
 * One day, chosen to equal the board client's own activity window
 * (`ACTIVITY_WINDOW_MS` in `activity-model.ts`) rather than to be round: the
 * rows Home draws notes from are exactly the rows this must not trim.
 */
export const DETAIL_FRESH_MS = 24 * 60 * 60 * 1000;

/** Read by nothing outside the open panel, on any row, ever. */
export const ALWAYS_TRIMMED_FIELDS = ['reviews', 'quote'] as const;

/** The description, kept on the one row shape a list surface renders it on. */
export const BODY_FIELDS = ['body', 'bodyTruncated'] as const;

/** Kept while Home's Recent activity may still be drawing them. */
export const ACTIVITY_FIELDS = ['notes'] as const;

/**
 * Every field this module may drop, named once in `@claude-workspaces/core`
 * so the trim and the browser's refetch cannot disagree about the list — the
 * groups above are this module's own rules, and the test pins their union
 * against it. Each field is dropped under its own rule: the union is not a
 * set any single row loses.
 */
export { TRIMMED_ROW_FIELDS };

/**
 * Does a list surface still render this row's description?
 *
 * The walkthrough's decision card does, for an open unanswered decision, and
 * it reads the projection with no refetch behind it. So this is `decisionRows`
 * with one clause dropped and none added.
 *
 * The dropped one is `decisionState !== 'waiting'`: that mark is derived and
 * flips back to `revised` without the body changing, so a carve-out matching
 * it exactly would blank the card at the moment it returns to the queue.
 *
 * **`archivedAt` is deliberately not a clause**, and adding it was a bug this
 * had on the way in. Archiving "is deliberately NOT a status" — `archive_task`
 * writes three fields and leaves `status` alone — so an archived, unanswered
 * decision still satisfies every clause `decisionRows` tests, still enters the
 * review queue, and still draws a walkthrough card. Trimming its body drew
 * that card with no question on it.
 */
function rendersBodyInAList(row: ProjectedTaskRow): boolean {
  return row.status !== 'done' && row.needs === 'decision' && row.answer === undefined;
}

/**
 * The trail, without the prose.
 *
 * Returns the same array when there was no prose on it, so a row whose stops
 * are already bare is not rewritten into an equal-but-different object on
 * every refresh.
 */
function trimTransitions(value: unknown): { value: unknown; trimmed: boolean } {
  if (!Array.isArray(value)) return { value, trimmed: false };
  let trimmed = false;
  const stops = value.map((t) => {
    const row = t as Record<string, unknown>;
    if (row.note !== undefined || row.usage !== undefined) trimmed = true;
    return { ts: row.ts, from: row.from, to: row.to, by: row.by };
  });
  return trimmed ? { value: stops, trimmed } : { value, trimmed };
}

/**
 * The row as the board's ydoc should carry it.
 *
 * Returns the SAME object when nothing is trimmed, so `refresh`'s `sameJson`
 * compare keeps seeing an unchanged row as unchanged — and a fresh object
 * with the source row's key order otherwise, which that same compare reads
 * stably.
 */
export function slimTaskRow(row: ProjectedTaskRow, now: number): ProjectedTaskRow {
  const updatedAt = typeof row.updatedAt === 'number' ? row.updatedAt : 0;
  const keepNotes = now - updatedAt < DETAIL_FRESH_MS;
  const keepBody = rendersBodyInAList(row);
  const slim: ProjectedTaskRow = {};
  let trimmed = false;
  for (const [key, value] of Object.entries(row)) {
    if ((ALWAYS_TRIMMED_FIELDS as readonly string[]).includes(key)) {
      trimmed = true;
      continue;
    }
    if (!keepBody && (BODY_FIELDS as readonly string[]).includes(key)) {
      trimmed = true;
      continue;
    }
    if (!keepNotes && (ACTIVITY_FIELDS as readonly string[]).includes(key)) {
      trimmed = true;
      continue;
    }
    if (key === 'transitions') {
      const trail = trimTransitions(value);
      trimmed = trimmed || trail.trimmed;
      slim[key] = trail.value;
      continue;
    }
    slim[key] = value;
  }
  if (!trimmed) return row;
  // The row says what it is missing. The panel reads this and asks for the
  // rest; without it the only way to tell a trimmed row from a task nobody
  // described is to fetch every row on open.
  slim.detailTrimmed = true;
  return slim;
}
