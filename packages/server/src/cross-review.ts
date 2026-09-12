/**
 * The cross-board review flow's server half, composed once: the plan board
 * setting, the ordered queue over every board, and the answer ledger that
 * listens to every door an answer comes through.
 *
 * Composition only — the ordering is `cross-review-queue.ts`, the project
 * ranking `review-plan.ts`, the metrics `review-answer-ledger.ts`. This file
 * is where those meet the stores, so `createServer` gains one call instead of
 * learning four modules.
 *
 * The ledger's listeners run a tick after the answer rather than inside it.
 * The measurement reads every board's queue, which the answering request has
 * no reason to wait for, and a failure in it must never fail an answer that
 * was recorded.
 */
import {
  type AskShape,
  type BoardQueueInput,
  type CrossReviewQueue,
  crossReviewQueue,
} from './cross-review-queue.ts';
import type { DocStore } from './doc-store.ts';
import {
  type AnswerRecord,
  ReviewAnswerLedger,
  measureAnswer,
  visibleAtOf,
} from './review-answer-ledger.ts';
import {
  type RankedProject,
  ReviewPlanStore,
  rankProjects,
  resolvePlanBoard,
} from './review-plan.ts';
import type { ReviewSizer, SizedReviewItemRow } from './review-sizing.ts';
import { type BoardWorkspace, LEGACY_REVIEW_ITEM_ID, type TaskStore, isRetired } from './tasks.ts';

export interface CrossReviewContext {
  dataDir: string;
  taskStore: TaskStore;
  docStore: DocStore;
  reviewItemsFor: (workspace: BoardWorkspace) => SizedReviewItemRow[];
  sizer: ReviewSizer;
  /** Newest real activity per board, the landing page's own reading. */
  lastActivityOf: (workspace: BoardWorkspace) => number;
  spawnerAgentId: string | null;
  /** Where a failed measurement is reported. Never thrown. */
  onError?: (err: unknown) => void;
}

export interface CrossReview {
  plan: ReviewPlanStore;
  /** Every live board in project order, with the plan board they came from. */
  projects(): { planWorkspaceId?: string; projects: RankedProject[] };
  /** Every open item on every live board, top project first. */
  queue(): CrossReviewQueue & { planWorkspaceId?: string };
  ledger: ReviewAnswerLedger;
  /** Measure and record one answer now. Exposed for tests; the listeners
   *  call it a tick after the answer. */
  recordAnswer(args: {
    workspaceId: string;
    ask: AskShape;
    key: string;
    askedAt: number;
    visibleAt: number;
    answeredAt: number;
    size: { minutes: number; size: AnswerRecord['size'] };
  }): AnswerRecord | null;
  dispose(): void;
}

const SHOWN_FRESH_MS = 60 * 60_000;

/** `current` re-numbered by the ranks a reader was shown; a board that was
 *  not on that page keeps its current place after every board that was. */
export function reRank(current: RankedProject[], shownRanks: Map<string, number>): RankedProject[] {
  const place = (p: RankedProject) => shownRanks.get(p.workspaceId) ?? shownRanks.size + p.rank;
  return [...current].sort((a, b) => place(a) - place(b)).map((p, i) => ({ ...p, rank: i + 1 }));
}

export function createCrossReview(ctx: CrossReviewContext): CrossReview {
  const { dataDir, taskStore, docStore, reviewItemsFor, lastActivityOf } = ctx;
  const plan = new ReviewPlanStore(dataDir);
  const ledger = new ReviewAnswerLedger(dataDir);

  const liveBoards = (): BoardWorkspace[] =>
    taskStore.listWorkspaces().filter((w) => !isRetired(w));

  const projectsOf = (boards: BoardWorkspace[]) => {
    const inputs = boards.map((w) => ({
      id: w.id,
      name: w.name,
      lastActivity: lastActivityOf(w),
      ...(w.leadAgentId ? { leadAgentId: w.leadAgentId } : {}),
    }));
    const planWorkspaceId = resolvePlanBoard(inputs, plan.get(), ctx.spawnerAgentId ?? '');
    const planBoard = planWorkspaceId ? taskStore.getWorkspace(planWorkspaceId) : undefined;
    const projects = rankProjects(
      inputs,
      planBoard ? { goals: planBoard.goals, goalRows: taskStore.listGoalRows(planBoard.id) } : null,
    );
    return { ...(planWorkspaceId ? { planWorkspaceId } : {}), projects };
  };

  const boardInput = (w: BoardWorkspace) => ({
    tasks: taskStore.listTasks(w.id).map((t) => ({
      id: t.id,
      goal: t.goal,
      order: t.order,
      createdAt: t.createdAt,
      ...(t.dueAt !== undefined ? { dueAt: t.dueAt } : {}),
    })),
    goalIds: w.goals.map((g) => g.id),
  });

  /**
   * The project order the reader was last SHOWN, and when.
   *
   * An answer is itself activity on its board, so a board no goal names can
   * jump to the top of the recency tail the moment it is answered — and a
   * measurement read afterwards would call every answer on such a board "in
   * order". So the ledger measures against the order the last queue read
   * served, when there was one within the hour, rather than the order the
   * answer just produced.
   */
  let shown: { at: number; ranks: Map<string, number> } | null = null;

  const compute = (rankOverride?: Map<string, number>) => {
    const boards = liveBoards();
    const { planWorkspaceId, projects: current } = projectsOf(boards);
    const projects = rankOverride ? reRank(current, rankOverride) : current;
    const byId = new Map(boards.map((w) => [w.id, w]));
    const inputs: BoardQueueInput[] = [];
    for (const project of projects) {
      const w = byId.get(project.workspaceId);
      if (!w) continue;
      inputs.push({ project, rows: reviewItemsFor(w), ...boardInput(w) });
    }
    return { ...crossReviewQueue(inputs), ...(planWorkspaceId ? { planWorkspaceId } : {}) };
  };

  const queue = () => {
    const q = compute();
    shown = { at: Date.now(), ranks: new Map(q.projects.map((p) => [p.workspaceId, p.rank])) };
    return q;
  };

  const recordAnswer: CrossReview['recordAnswer'] = (args) => {
    const w = taskStore.getWorkspace(args.workspaceId);
    if (!w || isRetired(w)) return null;
    const recent = shown && args.answeredAt - shown.at < SHOWN_FRESH_MS ? shown.ranks : undefined;
    const q = compute(recent);
    const measured = measureAnswer({
      queue: q,
      workspaceId: w.id,
      ask: args.ask,
      board: boardInput(w),
    });
    const record: AnswerRecord = {
      workspaceId: w.id,
      key: args.key,
      askedAt: args.askedAt,
      visibleAt: args.visibleAt,
      answeredAt: args.answeredAt,
      size: args.size.size,
      minutes: args.size.minutes,
      ...measured,
      ...(q.planWorkspaceId ? { planWorkspaceId: q.planWorkspaceId } : {}),
    };
    ledger.append(record);
    return record;
  };

  const later = (fn: () => void) =>
    setTimeout(() => {
      try {
        fn();
      } catch (err) {
        ctx.onError?.(err);
      }
    }, 0);

  const offTask = taskStore.onEvent((event) => {
    if (event.type !== 'decision.answered') return;
    later(() => {
      const task = taskStore.getTask(event.taskId);
      if (!task) return;
      const rid = event.reviewItemId ?? LEGACY_REVIEW_ITEM_ID;
      const item = taskStore.listReviewItems(task.id).find((i) => i.id === rid);
      if (!item) return;
      const legacy = rid === LEGACY_REVIEW_ITEM_ID;
      recordAnswer({
        workspaceId: task.workspaceId,
        ask: {
          kind: 'task-review',
          taskId: task.id,
          legacy,
          direct: true,
          since: item.createdAt,
          tie: legacy ? task.id : `${task.id}:${rid}`,
        },
        key: legacy ? `decision:${task.id}` : `task-review:${task.id}:${rid}`,
        askedAt: item.createdAt,
        visibleAt: visibleAtOf(item.createdAt, item.judge, item.revisions?.[0]?.at),
        answeredAt: event.ts,
        size: ctx.sizer.one({ review: item.review, ask: item.review.headline }),
      });
    });
  });

  const offDoc = docStore.onReviewAnswered((event) => {
    later(() => {
      const comment = docStore
        .listThreads(event.docId)
        .find((t) => t.id === event.threadId)
        ?.comments.find((c) => c.id === event.commentId);
      const review = comment?.review;
      if (!comment || !review) return;
      const rowId = event.docId.startsWith('task:') ? event.docId.slice('task:'.length) : undefined;
      const task = rowId ? taskStore.getTask(rowId) : undefined;
      const goal = rowId && !task ? taskStore.getGoalRow(rowId) : undefined;
      const workspaceId =
        task?.workspaceId ??
        goal?.workspaceId ??
        taskStore.listWorkspaces().find((w) => w.docIds.includes(event.docId))?.id;
      if (!workspaceId) return;
      const kind = task ? 'task-thread' : goal ? 'goal-thread' : 'doc-thread';
      recordAnswer({
        workspaceId,
        ask: {
          kind,
          ...(task ? { taskId: task.id } : {}),
          direct: true,
          since: comment.ts,
          tie: event.threadId,
        },
        key: `${kind}:${event.docId}:${event.threadId}`,
        askedAt: comment.ts,
        visibleAt: visibleAtOf(comment.ts, review.judge, review.revisions?.[0]?.at),
        answeredAt: event.ts,
        size: ctx.sizer.one({ review, ask: review.headline }),
      });
    });
  });

  return {
    plan,
    projects: () => projectsOf(liveBoards()),
    queue,
    ledger,
    recordAnswer,
    dispose: () => {
      offTask();
      offDoc();
    },
  };
}
