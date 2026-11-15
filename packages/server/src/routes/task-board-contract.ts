/**
 * The contract for the routes that read a board's tasks and write its goal
 * bands: the work queue, the task list, the goal list's replace, rename and
 * reorder, and a band's restore (`route-contract.ts` says what a contract
 * is). Three families serve them: `workspace-next.ts` (the queue),
 * `tasks-list-create.ts` (the list) and `workspace-goals.ts` (the bands).
 *
 * The goal answers are the store's own results with `ok` narrowed to true, so
 * a field the store renames fails typecheck in the MCP tool that reads it.
 */
import { Hono } from 'hono';
import type { OwnerKind } from '../task-owner.ts';
import type { ClaimSession, OwnerSession } from '../task-projection.ts';
import type { QueueRow } from '../task-queue.ts';
import type {
  ArchiveGoalResult,
  RenameGoalResult,
  ReorderGoalsResult,
  RetiredNotice,
  SetGoalListResult,
  Task,
} from '../tasks.ts';
import { answers, json, query } from './route-contract.ts';

export type NextQuery = {
  assignee?: string;
  limit?: string;
  includeBlocked?: 'true';
  includeArchived?: 'true';
};
/** `format=json` is what tells the list apart from the board's Tasks tab. */
export type TaskListQuery = {
  format: 'json';
  goal?: string;
  status?: string;
  assignee?: string;
  needs?: string;
  includeArchived?: 'true';
};

/** Each entry is checked by `parseGoalList`; `drop` acknowledges a band that holds work. */
export interface GoalListBody {
  goals: unknown[];
  drop?: string[];
  author?: unknown;
}
/** `dueAt: null` clears the date; absent leaves it alone. */
export interface RenameGoalBody {
  goal: string;
  title: string;
  dueAt?: number | null;
  author?: unknown;
}
export interface ReorderGoalsBody {
  order: string[];
  parent?: string;
  author?: unknown;
}
export interface RestoreGoalBody {
  author?: unknown;
}

export interface NextAnswer {
  workspaceId: string;
  tasks: Array<QueueRow & { ownerSession?: OwnerSession; claimedBy?: ClaimSession }>;
  capacity?: { cap: number; inUse: number; free: number; heldForCapacity?: number };
  retired?: RetiredNotice;
}
export interface TaskListAnswer {
  workspaceId: string;
  tasks: Array<Task & { ownerKind: OwnerKind; ownerSession?: OwnerSession }>;
}
type Done<R> = Extract<R, { ok: true }>;
export type GoalListAnswer = Done<SetGoalListResult>;
export type RenameGoalAnswer = Done<RenameGoalResult>;
export type ReorderGoalsAnswer = Done<ReorderGoalsResult>;
export type RestoreGoalAnswer = Done<ArchiveGoalResult>;

const ws = '/workspaces/:ws';

export const taskBoardContract = new Hono()
  .get(`${ws}/next`, query<NextQuery>(), answers<NextAnswer>())
  .get(`${ws}/tasks`, query<TaskListQuery>(), answers<TaskListAnswer>())
  .put(`${ws}/goals`, json<GoalListBody>(), answers<GoalListAnswer>())
  .post(`${ws}/goals/rename`, json<RenameGoalBody>(), answers<RenameGoalAnswer>())
  .post(`${ws}/goals/reorder`, json<ReorderGoalsBody>(), answers<ReorderGoalsAnswer>())
  .post(`${ws}/goals/:goalId/restore`, json<RestoreGoalBody>(), answers<RestoreGoalAnswer>());

export type TaskBoardContract = typeof taskBoardContract;
