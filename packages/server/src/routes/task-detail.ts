/**
 * The other half of the closed-row trim: one task's row, in full.
 *
 * The board's ydoc carries a closed row as a LIST row — no body, no notes, no
 * review items, no original words, and a transition trail without its prose
 * (`task-row-slim.ts` says why, and names the fields). Everything dropped
 * there has exactly one reader, the open detail panel, and this is where that
 * reader gets it back. One extra round trip when somebody opens a ticket that
 * closed more than a day ago; nothing at all for every other row, and 1.4 MB
 * off the download that every board reader pays on every load.
 *
 * Gated like every other row-addressed task route — `share-scope`, resolved
 * once by `middleware/workspace-scope.ts` — because it answers with exactly
 * what the projection already hands a board reader. It cannot widen the share
 * surface: a visitor who may read the board may read its rows, and a row this
 * refuses is a row the ydoc never carried either.
 */
import type { TaskRouteRequest, TaskRoutesContext } from './task-routes-context.ts';

/** Answers `GET /workspaces/:ws/tasks/:taskId/detail`, or `undefined`. */
export async function handleTaskDetail(
  ctx: TaskRoutesContext,
  rq: TaskRouteRequest,
): Promise<Response | undefined> {
  const { taskStore, taskProjection, j } = ctx;
  const { req, pathname, scope } = rq;
  const match = pathname.match(/^\/workspaces\/([^/]+)\/tasks\/([^/]+)\/detail$/);
  if (!match || !scope || req.method !== 'GET') return undefined;
  const { workspaceId } = scope;
  const taskId = decodeURIComponent(match[2] ?? '');
  const task = taskStore.getTask(taskId);
  // Two separate refusals collapsed into one answer on purpose: a row that
  // does not exist and a row belonging to a different board are the same
  // thing to a reader of THIS board, and telling them apart would say
  // whether an id exists somewhere else on the machine.
  if (!task || task.workspaceId !== workspaceId) return j(404, { error: 'task not found' });
  return j(200, { task: taskProjection.projectRowInFull(workspaceId, task) });
}
