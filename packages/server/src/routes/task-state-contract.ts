import type { ExternalWait } from '@claude-workspaces/core/task-wire';
/**
 * The contract for the routes that move one task or change one of its
 * fields: its status, owner, blockers, wait, goal band, schedule, and its
 * archive, title and body (`route-contract.ts` says what a contract is). Two
 * families serve them: `task-status-links.ts` (the transition and the goal
 * band) and `task-fields.ts` (the rest).
 *
 * Every body carries `author`, which `authorFor` resolves, so it is
 * `unknown` here.
 */
import { Hono } from 'hono';
import type { OwnerKind } from '../task-owner.ts';
import type { BoardRow, Task, TransitionBlocker } from '../tasks.ts';
import { answers, json } from './route-contract.ts';

export interface TransitionBody {
  to: string;
  author?: unknown;
  note?: string;
  usage?: { inputTokens: number; outputTokens: number };
}
export interface AssigneeBody {
  assignee: string;
  assigneeKind?: 'person' | 'agent';
  author?: unknown;
}
/** `blockedBy` adds blockers; an older bundle's `parkedUntil` parks the row. */
export interface ParkBody {
  blockedBy?: string[];
  parkedUntil?: number | null;
  reason?: string;
  author?: unknown;
}
export interface WaitBody {
  what?: string;
  hours?: number;
  clear?: boolean;
  author?: unknown;
}
export interface ArchiveTaskBody {
  reason?: string;
  author?: unknown;
}
export interface RestoreTaskBody {
  author?: unknown;
}
export interface AfterBody {
  after: string[];
  afterEnforce?: string[];
  author?: unknown;
}
/** Read whole by `parseSchedule`; `rule: null` clears. */
export interface ScheduleBody {
  rule: unknown;
  timezone?: string;
  until?: number;
  onMissed?: string;
  output?: unknown;
  author?: unknown;
}
export interface TitleBody {
  title: string;
  reason?: string;
  author?: unknown;
}
/** A body rewrite may retitle the row in the same act. */
export interface TaskBodyBody {
  markdown: string;
  title?: string;
  reason?: string;
  author?: unknown;
}
export interface TaskGoalBody {
  goal: string;
  position?: number;
  /** The row this one lands behind, or null for the top of the goal. */
  after?: string | null;
  batchId?: string;
  author?: unknown;
}

/** A row after a write, and whether the write moved anything. */
export interface TaskChange {
  ok: true;
  task: Task;
  changed: boolean;
}
export interface TransitionAnswer {
  ok: true;
  task: BoardRow;
  /** The non-enforcing blockers, cut to the caller's board. */
  blockers?: TransitionBlocker[];
}
export interface AssigneeAnswer extends TaskChange {
  ownerKind: OwnerKind;
}
/** The blocking arm answers `after`; the older parking arm `commented`. */
export interface ParkAnswer extends TaskChange {
  after?: string[];
  commented?: boolean;
  message?: string;
}
/** Setting a wait answers `wait`; clearing one answers `changed`. */
export interface WaitAnswer {
  ok: true;
  task: Task;
  changed?: boolean;
  wait?: ExternalWait;
}
/** The rewritten row, read back after the body's live doc flushed. */
export interface TaskBodyAnswer {
  ok: true;
  task: Task | undefined;
}
export interface ScheduleAnswer {
  ok: true;
  task: Task;
}

const task = '/workspaces/:ws/tasks/:taskId';

export const taskStateContract = new Hono()
  .post(`${task}/transition`, json<TransitionBody>(), answers<TransitionAnswer>())
  .post(`${task}/assignee`, json<AssigneeBody>(), answers<AssigneeAnswer>())
  .post(`${task}/park`, json<ParkBody>(), answers<ParkAnswer>())
  .post(`${task}/wait`, json<WaitBody>(), answers<WaitAnswer>())
  .post(`${task}/archive`, json<ArchiveTaskBody>(), answers<TaskChange>())
  .post(`${task}/restore`, json<RestoreTaskBody>(), answers<TaskChange>())
  .post(`${task}/after`, json<AfterBody>(), answers<TaskChange>())
  .post(`${task}/schedule`, json<ScheduleBody>(), answers<ScheduleAnswer>())
  .post(`${task}/goal`, json<TaskGoalBody>(), answers<TaskChange>())
  .post(`${task}/title`, json<TitleBody>(), answers<TaskChange>())
  .post(`${task}/body`, json<TaskBodyBody>(), answers<TaskBodyAnswer>());

export type TaskStateContract = typeof taskStateContract;
