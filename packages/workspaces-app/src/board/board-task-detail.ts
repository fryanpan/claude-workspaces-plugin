/**
 * The fields a row does not arrive with, fetched for the one reader who
 * opened it.
 *
 * The server sends a task out as a LIST row — no review items, no original
 * words, no body unless a list surface draws it, no notes once the row has
 * been still for a day, and a transition trail without its prose
 * (`task-row-slim.ts` on the server names the reader behind each field and
 * the measurements). That is what takes the board's sync from megabytes to a
 * hundred-odd kilobytes on the wire, and it is only safe because of this
 * module: the panel asks for the rest of a row the moment somebody opens one,
 * and every surface downstream reads the whole row exactly as it did before.
 *
 * Three rules, and each of them is a bug this had on the way in:
 *
 *   - **Keyed on the row's revision, not on the id — and on BOTH of its
 *     clocks.** A fetched row is a snapshot, and the projection keeps moving
 *     under it. Holding it against the id alone meant an agent's new note
 *     landed in the ydoc while the panel kept rendering the body it fetched
 *     ten minutes ago; holding it against `updatedAt` alone had the same
 *     failure for the description itself, because a body rewrite deliberately
 *     moves no row clock. See `detailKey`.
 *   - **Asked at most once per snapshot.** `renderDetail` runs on every board
 *     event and every clock tick, so a fetch fired from the render path is a
 *     fetch fired several times a second. The `asked` set is what makes the
 *     call idempotent; a failure stays failed until the row moves, because a
 *     retry loop on the render path is worse than a panel missing its
 *     Activity tab.
 *   - **Never written into the ydoc.** The `tasks` map is server-owned. This
 *     is an overlay `readProjection` merges on the way out, so the next
 *     projection tick cannot be fought by a client write.
 */
import { NARROWED_ROW_FIELDS, TRIMMED_ROW_FIELDS } from '@claude-workspaces/core/task-wire';
import type { BoardState } from './board-actions.ts';
import { fetchJson } from './board-actions.ts';
import type { BoardTask } from './board-model.ts';

/** What the fetch needs from `bootBoard`, and nothing else. */
export interface TaskDetailDeps {
  /** The board's one projection — the overlay is written here. LIVE. */
  state: BoardState;
  workspaceId: string;
  /** Repaint behind the reader's finger — `repaintGuard.schedule`. */
  schedule(paint: () => void): void;
  renderDetail(): void;
}

/** What `bootBoard` keeps. */
export interface TaskDetailLoads {
  /** Make sure the panel has the whole of this row. Cheap and idempotent on
   *  a row that arrived whole, on one already fetched, and on a repeat. */
  loadTaskDetail(taskId: string | null): void;
}

/**
 * The overlay key: a row's identity is its id AND the revision it was at.
 *
 * TWO clocks, because one of them does not tick for the body. `updatedAt`
 * moves on every board-visible change — a note, a review item, a transition,
 * an assignment. It deliberately does NOT move when somebody rewrites the
 * description: `updateBodySnapshot` fires no event and bumps no row clock,
 * because body typing is not board activity. That was invisible while the
 * projection carried the body (the diff-aware refresh pushed the new text),
 * and it is load-bearing now that a trimmed row has no text to differ: keyed
 * on `updatedAt` alone, a fetched snapshot would go on filling the hole with
 * the body somebody had already replaced, for as long as nothing unrelated
 * touched the row. `bodyWrittenAt` is the clock that does move, so it is half
 * the key — and when it moves the overlay misses, `loadTaskDetail` asks
 * again, and the panel repaints with what the row now says.
 */
export function detailKey(taskId: string, updatedAt: number, bodyWrittenAt?: number): string {
  return `${taskId}@${updatedAt}#${bodyWrittenAt ?? 0}`;
}

/**
 * The row a surface should render: the PROJECTED row, with the fields the
 * trim took out of it filled from the fetched one.
 *
 * The fetched row is never handed back wholesale, and that is the bug this
 * shape exists to prevent rather than a preference. A fetched row is a
 * snapshot of the whole ticket; the projection keeps moving under it, and not
 * every move bumps `updatedAt` — a body rewrite (`updateBodySnapshot`)
 * stamps `quote`, clears `possiblyStale` and bumps no row clock. Returning
 * the snapshot whole therefore froze every OTHER field at the revision the
 * fetch happened at: the drift notice a rewrite had just cleared stayed on
 * screen until something unrelated moved the row. (That rewrite is now half
 * the key — `bodyWrittenAt` — so the snapshot is dropped rather than
 * re-applied; the two fixes are separate and this one still has to hold,
 * because `updatedAt` moves for reasons of its own.)
 *
 * So the snapshot fills HOLES and nothing else. Every field the board still
 * sends stays the board's, which is not the same rule as "the trimmed fields
 * come from the snapshot": `detailTrimmed` says something went, never which
 * thing, and `body` is on a row whose `reviews` went. The one field that is
 * replaced rather than filled is the trail, because the trim shortens it in
 * place — see the loop.
 *
 * The marker comes off the merged row: it says "something is missing", and
 * nothing is once this has run — which is also what makes `loadTaskDetail`
 * idempotent on a row it has already filled.
 *
 * Exported because `readProjection` is the only caller and a test is the
 * other — the merge is the half of this design that is easy to get subtly
 * wrong, and it is a pure function so it can be driven directly.
 */
export function mergeTaskDetail(projected: BoardTask, overlay: Map<string, BoardTask>): BoardTask {
  if (!projected.detailTrimmed) return projected;
  const whole = overlay.get(detailKey(projected.id, projected.updatedAt, projected.bodyWrittenAt));
  if (!whole) return projected;
  const merged: BoardTask = { ...projected };
  // Both sides through a string-keyed view: the field names are a union of
  // `BoardTask` keys, and indexing the row with the union resolves to
  // `never` rather than to the value each key holds.
  const filled = merged as unknown as Record<string, unknown>;
  const fetched = whole as unknown as Record<string, unknown>;
  for (const field of TRIMMED_ROW_FIELDS) {
    // A field the PROJECTION still carries is the live one, and the marker is
    // no promise that this particular field went: an open decision keeps its
    // `body` for the walkthrough's card and is still marked, because its
    // `reviews` and `quote` went. Overwriting there would put a snapshot body
    // on a card the projection is keeping current. So the snapshot only ever
    // fills a HOLE.
    if (filled[field] === undefined && fetched[field] !== undefined) {
      filled[field] = fetched[field];
    }
  }
  for (const field of NARROWED_ROW_FIELDS) {
    // The exception, and why these are a separate list: the trail is
    // SHORTENED rather than removed, so the projected row has the key and
    // fill-the-hole would never restore the prose. Safe to replace because
    // every write to a trail is a transition, and a transition bumps
    // `updatedAt` — this key moves before the trail can disagree.
    if (fetched[field] !== undefined) filled[field] = fetched[field];
  }
  merged.detailTrimmed = undefined;
  return merged;
}

export function createTaskDetailLoads(deps: TaskDetailDeps): TaskDetailLoads {
  const { state, workspaceId, schedule, renderDetail } = deps;
  const asked = new Set<string>();
  const repaintDetail = (): void => renderDetail();

  function loadTaskDetail(taskId: string | null): void {
    if (!taskId) return;
    const row = state.tasks.get(taskId);
    // Nothing to ask for: the row is not on the board yet, or it arrived
    // whole because every field the trim looks at was already absent.
    if (!row?.detailTrimmed) return;
    const key = detailKey(taskId, row.updatedAt, row.bodyWrittenAt);
    if (asked.has(key) || state.taskDetail.has(key)) return;
    asked.add(key);
    void fetchJson<{ task: BoardTask }>(
      `/workspaces/${encodeURIComponent(workspaceId)}/tasks/${encodeURIComponent(taskId)}/detail`,
    ).then((res) => {
      // A read that never reached the server is not an empty row — the same
      // rule the three board loads keep. Leaving the overlay unwritten means
      // the panel keeps rendering the list row rather than blanking it.
      if (!res?.task) return;
      state.taskDetail.set(key, res.task);
      // …and fold it into the row the RENDER reads. `readProjection` merges
      // the overlay on its way out, but it only runs on a board update — so
      // storing the answer and repainting would paint the trimmed row again,
      // and go on painting it until some unrelated event moved the board. On
      // a quiet board that is never, which made an old closed ticket open to
      // a permanently empty panel: the primary detail path for exactly the
      // rows the trim exists to make cheap.
      //
      // Through `mergeTaskDetail` rather than by assignment, so the revision
      // guard is the same one line in both places: an answer that arrived
      // after the projection moved past the row it describes is dropped here
      // too, rather than putting a stale body on screen.
      const projected = state.tasks.get(taskId);
      if (projected) state.tasks.set(taskId, mergeTaskDetail(projected, state.taskDetail));
      schedule(repaintDetail);
    });
  }

  return { loadTaskDetail };
}
