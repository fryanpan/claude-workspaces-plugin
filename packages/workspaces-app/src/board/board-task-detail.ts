/**
 * The five fields a closed row does not arrive with, fetched for the one
 * reader who opened it.
 *
 * The server sends a closed task out as a LIST row — no body, no notes, no
 * review items, no original words, and a transition trail without its prose
 * (`task-row-slim.ts` on the server names the fields and the measurements).
 * That is what takes the board's sync from megabytes to hundreds of
 * kilobytes, and it is only safe because of this module: the panel asks for
 * the rest of a row the moment somebody opens one, and every surface
 * downstream reads the whole row exactly as it did before.
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
 * The row a surface should render: the fetched whole one when it matches the
 * projected row's revision, otherwise the projected row itself.
 *
 * Exported because `readProjection` is the only caller and a test is the
 * other — the merge is the half of this design that is easy to get subtly
 * wrong, and it is a pure function so it can be driven directly.
 */
export function mergeTaskDetail(projected: BoardTask, overlay: Map<string, BoardTask>): BoardTask {
  if (!projected.detailTrimmed) return projected;
  return overlay.get(detailKey(projected.id, projected.updatedAt)) ?? projected;
}

export function createTaskDetailLoads(deps: TaskDetailDeps): TaskDetailLoads {
  const { state, workspaceId, schedule, renderDetail } = deps;
  const asked = new Set<string>();
  const repaintDetail = (): void => renderDetail();

  function loadTaskDetail(taskId: string | null): void {
    if (!taskId) return;
    const row = state.tasks.get(taskId);
    // Nothing to ask for: the row is not on the board yet, or it arrived
    // whole because it is open or it closed within the day.
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
      schedule(repaintDetail);
    });
  }

  return { loadTaskDetail };
}
