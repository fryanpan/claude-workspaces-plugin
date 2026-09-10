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
 *   - **Keyed on `updatedAt`, not on the id.** A fetched row is a snapshot,
 *     and the projection keeps moving under it. Holding it against the id
 *     alone meant an agent's new note landed in the ydoc while the panel
 *     kept rendering the body it fetched ten minutes ago.
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

/** The overlay key: a row's identity is its id AND the revision it was at. */
export function detailKey(taskId: string, updatedAt: number): string {
  return `${taskId}@${updatedAt}`;
}

/**
 * The row a surface should render: the PROJECTED row, with the fields the
 * trim took out of it filled from the fetched one.
 *
 * The fetched row is never handed back wholesale, and that is the bug this
 * shape exists to prevent rather than a preference. A fetched row is a
 * snapshot of the whole ticket; the projection keeps moving under it, and not
 * every move bumps `updatedAt` — a body rewrite (`updateBodySnapshot`)
 * stamps `quote`, clears `possiblyStale` and touches nothing the key is built
 * from. Returning the snapshot whole therefore froze every OTHER field at the
 * revision the fetch happened at: the drift notice a rewrite had just
 * cleared stayed on screen until something unrelated moved the row. Taking
 * only `TRIMMED_ROW_FIELDS` and `NARROWED_ROW_FIELDS` from it leaves every
 * field the board still sends live, so the snapshot can only be stale about
 * the fields it is the sole source of.
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
  const whole = overlay.get(detailKey(projected.id, projected.updatedAt));
  if (!whole) return projected;
  const merged: BoardTask = { ...projected };
  // Both sides through a string-keyed view: the field names are a union of
  // `BoardTask` keys, and indexing the row with the union resolves to
  // `never` rather than to the value each key holds.
  const filled = merged as unknown as Record<string, unknown>;
  const fetched = whole as unknown as Record<string, unknown>;
  for (const field of [...TRIMMED_ROW_FIELDS, ...NARROWED_ROW_FIELDS]) {
    // `undefined` is the fetched row saying the ticket does not have one, so
    // it must not overwrite — a row with no notes and a row whose notes were
    // trimmed both arrive here with the key absent.
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
    const key = detailKey(taskId, row.updatedAt);
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
