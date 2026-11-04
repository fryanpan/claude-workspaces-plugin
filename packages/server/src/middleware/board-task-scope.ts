/**
 * The task writes a board-scoped agent may make on its own board's tasks,
 * beyond what `collabScope` lists for a member.
 *
 * A board agent is a caller holding a board agent token (`at2`,
 * `middleware/board-agent-door.ts`) or arriving on that board's own socket
 * (`middleware/board-socket-door.ts`). Neither is a share or collaboration
 * visitor, and `shareScopeAllows` is not widened by this file: a person in a
 * browser reaches none of these paths through it.
 *
 * `collabScope` already gives a member the transition, title, body, goal,
 * dependency, link and review-item verbs. These are the rest of what the MCP
 * child calls to work a task, each a write to one row of the board:
 *
 * - `POST tasks/<task>/wait` — `declare_wait`;
 * - `POST tasks/<task>/done-when` — `rewrite_task`'s done-when list;
 * - `POST tasks/<task>/done-when/report` — `report_done_when`;
 * - `POST tasks/<task>/schedule` — `set_task_schedule`;
 * - `POST tasks/batch` — `create_tasks`, which files rows on the path's board.
 *
 * Two conditions, both required: the path's board is the caller's board, and
 * for a row verb the task is on that board. The board-wide owner verbs (the
 * goal list, the parallelism cap, sharing, the lead seat, workspace admin)
 * are not here and stay refused. Anything not named here is refused, so a
 * route added later is closed to a board agent until somebody decides
 * otherwise.
 */

/** Every board an id belongs to, as `collabScope` asks it. */
type WorkspacesOf = (id: string) => string[];

const TASK_PATH = /^\/workspaces\/([^/]+)\/tasks\/([^/]+)(?:\/(.+))?$/;

/** The row verbs, after `tasks/<task>/`. Each answers POST only. */
const TASK_VERBS: ReadonlySet<string> = new Set([
  'wait',
  'done-when',
  'done-when/report',
  'schedule',
]);

export function boardTaskWriteAllows(
  pathname: string,
  method: string,
  boardId: string,
  workspacesOf: WorkspacesOf,
): boolean {
  if (method.toUpperCase() !== 'POST') return false;
  const match = pathname.match(TASK_PATH);
  if (!match || decoded(match[1] ?? '') !== boardId) return false;
  const taskId = decoded(match[2] ?? '');
  const verb = match[3];
  if (verb === undefined) return taskId === 'batch';
  if (!TASK_VERBS.has(verb)) return false;
  const owners = workspacesOf(`task:${taskId}`);
  return Array.isArray(owners) && owners.includes(boardId);
}

function decoded(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
