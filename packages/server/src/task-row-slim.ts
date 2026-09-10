/**
 * What a CLOSED task row carries into the board's ydoc, and what it leaves
 * behind for a reader who actually opens it.
 *
 * The board's sync-step-2 hands a fresh tab the WHOLE doc state in one frame,
 * so the cost of opening a board is the size of every row that has ever
 * existed on it — not the size of the list on screen. Measured on the live
 * board on 2026-09-09: 769 rows, 5,431,267 bytes of state deflating to
 * 1,606,258 on the wire, of which 3.22 MB of the 3.58 MB of live content
 * belonged to the 638 archived-or-done rows the default view does not render.
 * The bulk of every one of those rows was detail-panel data — bodies, notes,
 * review items, the original words, the note on each transition — that no
 * list reader ever reads. On 2026-08-29 the same doc was 1,264,566 bytes;
 * nothing about the design changed, the board simply kept working.
 *
 * So a closed row goes out as a LIST row. It keeps everything the board
 * computes over every task — the transition trail the done-window filter and
 * the effort calibration read, the estimate, the reading time, the archive
 * metadata, the dependency edges — and drops the five fields only the open
 * panel renders. `detailTrimmed` says so on the row itself, which is what
 * lets the panel fetch the rest instead of guessing.
 *
 * Two deliberate narrownesses:
 *
 *   - **A recently touched row is never trimmed.** Home's "Recent activity"
 *     renders the notes and transitions of any row that moved in the last
 *     day, closed rows included, straight off this projection. Trimming those
 *     would empty that list. Rows updated inside `DETAIL_FRESH_MS` ride out
 *     whole; on this board that was 24 rows and 106 KB, about 3% of the doc.
 *     The window ages a row out on the next refresh after it closes, and a
 *     refresh runs on every board write.
 *   - **`options` and `infoRequests` stay.** They are a few kilobytes in
 *     total and the decision strip reads them off rows the board does not
 *     otherwise render. Nothing here is worth a decision card that renders
 *     its blurb with no buttons under it.
 *
 * Nothing is destroyed: this is the PROJECTION only. The store keeps every
 * field, the sidecar keeps every field, and `GET …/tasks/:id/detail` hands
 * the whole row back to the one surface that wants it.
 */

/** A projected row, as `projectTask` returns it. */
export type ProjectedTaskRow = Record<string, unknown>;

/**
 * How recently a closed row must have moved to ride out whole.
 *
 * One day, chosen to cover the board client's own activity window
 * (`ACTIVITY_WINDOW_MS` in `activity-model.ts`) rather than to be round: the
 * rows Home draws from are exactly the rows this must not trim.
 */
export const DETAIL_FRESH_MS = 24 * 60 * 60 * 1000;

/**
 * The fields a trimmed row drops, named once so the test, the client's
 * refetch and this module cannot disagree about the list.
 *
 * Every one of them has exactly one reader and that reader is the open detail
 * panel: `body`/`bodyTruncated` (the pre-mount fallback under the live body
 * doc, which mounts over it either way), `notes` (the Activity tab),
 * `reviews` (the Held line and the ticket-borne rows in Comments), `quote`
 * (the "Original words" block).
 */
export const TRIMMED_ROW_FIELDS = ['body', 'bodyTruncated', 'notes', 'reviews', 'quote'] as const;

/** Is this projected row closed — archived, or moved to done? */
export function isClosedRow(row: ProjectedTaskRow): boolean {
  return row.archivedAt !== undefined || row.status === 'done';
}

/**
 * The trail, without the prose.
 *
 * `doneAt`, the effort model's closed-at / first-seen / wall-clock readings
 * and the recurrence run records all read `ts`/`from`/`to`/`by` and nothing
 * else. The `note` on each transition is 345 KB of the live board's 492 KB of
 * trail and is rendered only in the panel's Activity tab, which refetches.
 */
function trimTransitions(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((t) => {
    const row = t as Record<string, unknown>;
    return { ts: row.ts, from: row.from, to: row.to, by: row.by };
  });
}

/**
 * The row as the board's ydoc should carry it.
 *
 * Returns the SAME object when nothing is trimmed, so `refresh`'s
 * `sameJson` compare keeps seeing an unchanged row as unchanged.
 */
export function slimClosedRow(row: ProjectedTaskRow, now: number): ProjectedTaskRow {
  if (!isClosedRow(row)) return row;
  const updatedAt = typeof row.updatedAt === 'number' ? row.updatedAt : 0;
  if (now - updatedAt < DETAIL_FRESH_MS) return row;
  const slim: ProjectedTaskRow = {};
  for (const [key, value] of Object.entries(row)) {
    if ((TRIMMED_ROW_FIELDS as readonly string[]).includes(key)) continue;
    slim[key] = key === 'transitions' ? trimTransitions(value) : value;
  }
  // The row says what it is missing. The panel reads this and asks for the
  // rest; without it the only way to tell a trimmed row from a task nobody
  // described is to fetch every row on open.
  slim.detailTrimmed = true;
  return slim;
}
