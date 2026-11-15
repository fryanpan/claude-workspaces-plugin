/**
 * The contract for the routes that file tasks and write what a task says or
 * points at: a batch of new rows, a tracker import, the done-when list and
 * the reports against it, and a row's links and backlinks
 * (`route-contract.ts` says what a contract is). A row's title and body are
 * in `task-state-contract.ts`, beside the other one-field writes.
 *
 * Four families serve them: `tasks-batch.ts`, `workspace-content.ts` (the
 * import), `task-done-when.ts` and `task-status-links.ts` (links and
 * backlinks).
 */
import type { DoneWhenLine } from '@claude-workspaces/core/done-when';
import type { Ref, TaskStatus } from '@claude-workspaces/core/task-wire';
import { Hono } from 'hono';
import type { OwnerCheckHold } from '../review-items/done-when-owner.ts';
import type { PlaceableGoal } from '../task-queue.ts';
import type { Task, TaskChip } from '../tasks.ts';
import { answers, contractOnly, json } from './route-contract.ts';

/** The rows are parsed one by one, and a bad row is reported by index. */
export interface TaskBatchBody {
  tasks: unknown[];
  sourceDoc?: { docId: string; mode?: 'plan' | 'discussion' };
  author?: unknown;
}
export interface ImportTasksBody {
  path: string;
  apply?: boolean;
  author?: unknown;
}
/** The whole list; `[]` clears it. Each line is checked by `parseDoneWhenInput`. */
export interface DoneWhenBody {
  lines: unknown[];
  author?: unknown;
}
/** The lines the report names, each `{ id, verdict, proof? }`. */
export interface DoneWhenReportBody {
  lines: unknown[];
  author?: unknown;
}
export interface RefBody {
  ref: unknown;
}

/** `create_tasks` reads every field: each row, and the notes on it by id. */
export interface TaskBatchAnswer {
  workspaceId: string;
  tasks: Array<Task & { url?: string }>;
  failures: Array<{ index: number; title?: string; error: string; message?: string }>;
  placement?: { unplaced: string[]; goals: PlaceableGoal[] };
  ignoredLinks?: Array<{ taskId: string; ignored: unknown[] }>;
  shapeGaps?: Array<{ taskId: string; gaps: string[] }>;
  reviewAdvice?: Array<{ taskId: string; advice: string }>;
  held?: Array<{ taskId: string; reviewItemId: string; heldReason: string; message: string }>;
  visibility?: Array<{ taskId: string; note: string }>;
  sourceDoc?: { docId: string; mode: 'plan' | 'discussion'; held: boolean };
}
/** Every done-when write answers the list, and whether it closed the row. */
export interface DoneWhenAnswer {
  taskId: string;
  lines: DoneWhenLine[];
  closed: boolean;
  status: TaskStatus;
  held?: OwnerCheckHold[];
}
export interface LinkAnswer {
  ok: true;
  changed: boolean;
  task: Task;
}
export interface BacklinksAnswer {
  ref: Ref;
  tasks: TaskChip[];
}

const ws = '/workspaces/:ws';
const task = `${ws}/tasks/:taskId`;

export const taskContentContract = new Hono()
  .post(`${ws}/tasks/batch`, json<TaskBatchBody>(), answers<TaskBatchAnswer>())
  .post(`${ws}/import-tasks`, json<ImportTasksBody>(), contractOnly)
  .post(`${task}/done-when`, json<DoneWhenBody>(), answers<DoneWhenAnswer>())
  .post(`${task}/done-when/report`, json<DoneWhenReportBody>(), answers<DoneWhenAnswer>())
  .post(`${task}/links`, json<RefBody>(), answers<LinkAnswer>())
  .delete(`${task}/links`, json<RefBody>(), answers<LinkAnswer>())
  .post(`${ws}/refs:backlinks`, json<RefBody>(), answers<BacklinksAnswer>());

export type TaskContentContract = typeof taskContentContract;
