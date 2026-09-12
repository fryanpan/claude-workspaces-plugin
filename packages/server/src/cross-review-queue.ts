/**
 * Every open review item on every board, in one order: top project first,
 * then each board's own Home order.
 *
 * Bryan runs several boards and used to open each one to find what was
 * waiting on him. This is the list the cross-board flow walks, and the list
 * the answer metrics measure "in priority order" against, so both read the
 * SAME order rather than two that could drift.
 *
 * Project order is `rankProjects` (review-plan.ts). Inside a board the order
 * is a port of Home's `compareAsk` (board-review-model.ts in the app): the
 * task's goal band, then its place in the band, then its age, then which kind
 * of ask it is (the ticket's own decision, then questions about the work,
 * then doc comments), then a direct question over a status note, then the
 * wait. An ask with no task on the board sorts after every ask that has one.
 * The port exists because the server has to know an item's rank at the
 * moment it is answered, and the client is not there to ask.
 *
 * A legacy decision rides as its derived `r-legacy` row, which Home skips
 * only because it draws the same question from the board projection. Here
 * there is no projection, and the row's answer route already delegates to
 * the decision path, so it stays and ranks where Home ranks the decision.
 */
import type { ReviewSize } from '@claude-workspaces/core';
import type { RankedProject } from './review-plan.ts';
import type { SizedReviewItemRow } from './review-sizing.ts';
import { LEGACY_REVIEW_ITEM_ID } from './tasks.ts';

/** What the order reads of one task. */
export interface OrderTask {
  id: string;
  goal: string;
  order: number;
  createdAt: number;
}

/** One board's inputs. */
export interface BoardQueueInput {
  project: RankedProject;
  rows: SizedReviewItemRow[];
  tasks: OrderTask[];
  /** Goal ids in band order. */
  goalIds: string[];
}

export type CrossReviewItem = SizedReviewItemRow & {
  workspaceId: string;
  project: string;
  /** Stable across reads: `<workspaceId>:<row key>`. */
  key: string;
};

export interface CrossReviewQueue {
  projects: RankedProject[];
  items: CrossReviewItem[];
}

const BAND_TASK_ROW = 0;
const BAND_TASK_THREAD = 1;
const BAND_DOC_THREAD = 2;

interface AskRank {
  placed: 0 | 1;
  goal: number;
  order: number;
  createdAt: number;
  taskId: string;
  band: number;
  direct: 0 | 1;
  since: number;
  tie: string;
}

function compareAsk(a: AskRank, b: AskRank): number {
  return (
    a.placed - b.placed ||
    a.goal - b.goal ||
    a.order - b.order ||
    a.createdAt - b.createdAt ||
    a.taskId.localeCompare(b.taskId) ||
    a.band - b.band ||
    a.direct - b.direct ||
    a.since - b.since ||
    a.tie.localeCompare(b.tie)
  );
}

/** The key a row is known by within its board — the same spelling Home uses. */
export function rowKey(row: SizedReviewItemRow): string {
  if (row.kind === 'task-review') {
    return row.reviewItemId === LEGACY_REVIEW_ITEM_ID
      ? `decision:${row.taskId}`
      : `task-review:${row.taskId}:${row.reviewItemId}`;
  }
  return `${row.kind}:${row.docId}:${row.threadId}`;
}

/** What `rankOf` needs to place an ask, whether or not it is still open. */
export interface AskShape {
  kind: SizedReviewItemRow['kind'];
  taskId?: string;
  legacy?: boolean;
  direct: boolean;
  since: number;
  tie: string;
}

export function askShapeOf(row: SizedReviewItemRow): AskShape {
  if (row.kind === 'task-review') {
    return {
      kind: row.kind,
      taskId: row.taskId,
      legacy: row.reviewItemId === LEGACY_REVIEW_ITEM_ID,
      direct: true,
      since: row.since,
      tie:
        row.reviewItemId === LEGACY_REVIEW_ITEM_ID
          ? row.taskId
          : `${row.taskId}:${row.reviewItemId}`,
    };
  }
  return {
    kind: row.kind,
    ...(row.taskId ? { taskId: row.taskId } : {}),
    direct: row.direct,
    since: row.since,
    tie: row.threadId,
  };
}

/** A board's ranking function: where an ask sits among that board's asks. */
export function boardRanker(tasks: OrderTask[], goalIds: string[]): (ask: AskShape) => AskRank {
  const goalIndex = new Map(goalIds.map((id, i) => [id, i]));
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  return (ask) => {
    // Only a ticket's own rows and its discussion inherit its priority; a
    // goal's discussion and a doc comment have no task to rank by.
    const task =
      ask.taskId && (ask.kind === 'task-review' || ask.kind === 'task-thread')
        ? taskById.get(ask.taskId)
        : undefined;
    const band =
      ask.kind === 'task-review'
        ? ask.legacy
          ? BAND_TASK_ROW
          : BAND_TASK_THREAD
        : ask.kind === 'doc-thread'
          ? BAND_DOC_THREAD
          : BAND_TASK_THREAD;
    const direct: 0 | 1 = ask.direct ? 0 : 1;
    return task
      ? {
          placed: 0,
          goal: goalIndex.get(task.goal) ?? goalIds.length,
          order: task.order,
          createdAt: task.createdAt,
          taskId: task.id,
          band,
          direct,
          since: ask.since,
          tie: ask.tie,
        }
      : {
          placed: 1,
          goal: 0,
          order: 0,
          createdAt: 0,
          taskId: '',
          band,
          direct,
          since: ask.since,
          tie: ask.tie,
        };
  };
}

/** One board's rows in Home order. */
export function boardOrder(input: Omit<BoardQueueInput, 'project'>): SizedReviewItemRow[] {
  const rank = boardRanker(input.tasks, input.goalIds);
  return input.rows
    .map((row) => ({ row, rank: rank(askShapeOf(row)) }))
    .sort((a, b) => compareAsk(a.rank, b.rank))
    .map((r) => r.row);
}

/** Whether `ask` ranks ahead of `than` on one board. */
export function ranksAhead(
  ranker: (ask: AskShape) => AskRank,
  ask: AskShape,
  than: AskShape,
): boolean {
  return compareAsk(ranker(ask), ranker(than)) < 0;
}

/** Every board's rows, top project first. */
export function crossReviewQueue(boards: BoardQueueInput[]): CrossReviewQueue {
  const ordered = [...boards].sort((a, b) => a.project.rank - b.project.rank);
  const items: CrossReviewItem[] = [];
  for (const board of ordered) {
    for (const row of boardOrder(board)) {
      items.push({
        ...row,
        workspaceId: board.project.workspaceId,
        project: board.project.name,
        key: `${board.project.workspaceId}:${rowKey(row)}`,
      });
    }
  }
  return { projects: ordered.map((b) => b.project), items };
}

/** How many of `items` are at or under each size — the per-level count a
 *  cumulative filter shows. */
export function countBySize(
  items: ReadonlyArray<{ size: ReviewSize }>,
): Record<ReviewSize, number> {
  const out: Record<ReviewSize, number> = { easy: 0, medium: 0, hard: 0 };
  for (const it of items) {
    if (it.size === 'easy') out.easy += 1;
    if (it.size !== 'hard') out.medium += 1;
    out.hard += 1;
  }
  return out;
}
