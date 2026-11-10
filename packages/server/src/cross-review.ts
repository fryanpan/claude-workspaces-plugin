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
 *
 * Every read of the queue loads its cold docs first, a slice at a time
 * (`prepare`). The queue itself is one synchronous pass over every thread on
 * every live board, and on a 5,722-doc corpus the first one after a boot
 * loaded 1,561 docs inside it, holding the loop for over half a second.
 */
import { isBlockingAsk } from '@claude-workspaces/core/review-blocks';
import { classifyActor } from './actor-identity.ts';
import {
  type AskShape,
  type BoardQueueInput,
  type CrossReviewItem,
  type CrossReviewQueue,
  applyLeadRanks,
  askShapeOf,
  blockingFirst,
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
  type FiledItem,
  type NotQueuedReason,
  findQueueItem,
  ticketItemRef,
  whyNotQueued,
} from './review-key.ts';
import {
  type RankedProject,
  ReviewPlanStore,
  rankProjects,
  resolvePlanBoard,
} from './review-plan.ts';
import type { ReviewSizer, SizedReviewItemRow } from './review-sizing.ts';
import { taskBodyDocId } from './task-row.ts';
import { type BoardWorkspace, LEGACY_REVIEW_ITEM_ID, type TaskStore, isRetired } from './tasks.ts';

export interface CrossReviewContext {
  dataDir: string;
  taskStore: TaskStore;
  docStore: DocStore;
  /** A board's rows; `without` reads them as they stood before that comment. */
  reviewItemsFor: (
    workspace: BoardWorkspace,
    without?: { docId: string; commentId: string },
  ) => SizedReviewItemRow[];
  sizer: ReviewSizer;
  /** Newest real activity per board, the landing page's own reading. */
  lastActivityOf: (workspace: BoardWorkspace) => number;
  spawnerAgentId: string | null;
  /** The plan lead's rank for one item, when one counts (`review-ranks.ts`).
   *  Absent, or undefined for every item, leaves the order unchanged. */
  leadRank?: (item: CrossReviewItem) => number | undefined;
  /** The plan lead's goal tag for one item, when one counts. */
  leadGoal?: (item: CrossReviewItem) => string | undefined;
  /** Where a failed measurement is reported. Never thrown. */
  onError?: (err: unknown) => void;
}

export interface CrossReview {
  plan: ReviewPlanStore;
  /** Every live board in project order, with the plan board they came from. */
  projects(): { planWorkspaceId?: string; projects: RankedProject[] };
  /**
   * Load the cold docs a queue read will take threads from, handing the loop
   * back between loads. `includeRetired` adds the retired boards' task docs,
   * which the landing page's activity reading walks too. Resolves to how many
   * docs it loaded.
   */
  prepare(opts?: { includeRetired?: boolean }): Promise<number>;
  /** Every open item on every live board, top project first. */
  queue(): Promise<CrossReviewQueue & { planWorkspaceId?: string }>;
  /** One open item by any name it goes by (`review-key.ts`), with the plan
   *  board it was read against — or, when a ticket item the name points at
   *  is off the queue, why. Not a read the reader was shown, so the ledger
   *  ignores it. */
  item(key: string): Promise<{
    item?: CrossReviewItem;
    planWorkspaceId?: string;
    notQueued?: { reason: NotQueuedReason; message: string };
  }>;
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
    /** The item carried `blocks`. */
    blocking?: boolean;
  }): Promise<AnswerRecord | null>;
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

  /**
   * Every doc a queue read on `boards` takes threads from, all of them
   * unfiltered: the roster (`knownPeople`) reads resolved threads too, and
   * the activity reading (`lastActivityOf`) reads archived tasks' threads.
   */
  const readTargets = (boards: BoardWorkspace[]): Map<string, undefined> => {
    const targets = new Map<string, undefined>();
    for (const w of boards) {
      for (const t of taskStore.listTasks(w.id, { includeArchived: true })) {
        targets.set(taskBodyDocId(t.id), undefined);
      }
      for (const g of taskStore.listGoalRows(w.id)) targets.set(taskBodyDocId(g.id), undefined);
      for (const docId of w.docIds) targets.set(docId, undefined);
    }
    return targets;
  };

  const prepare: CrossReview['prepare'] = (opts) =>
    docStore.warmForThreadReads(
      readTargets(opts?.includeRetired ? taskStore.listWorkspaces() : liveBoards()),
    );

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
    const q = crossReviewQueue(inputs);
    const { leadRank, leadGoal } = ctx;
    const ranked = blockingFirst(leadRank ? applyLeadRanks(q.items, leadRank) : q.items);
    const items = leadGoal
      ? ranked.map((item) => {
          const goalTag = leadGoal(item);
          return goalTag ? { ...item, goalTag } : item;
        })
      : ranked;
    return { ...q, items, ...(planWorkspaceId ? { planWorkspaceId } : {}) };
  };

  const queue = async () => {
    await prepare();
    const q = compute();
    shown = { at: Date.now(), ranks: new Map(q.projects.map((p) => [p.workspaceId, p.rank])) };
    return q;
  };

  /** The ticket item a key points at, wherever it is filed. Read only on a
   *  miss, so the walk over every board's tasks costs nothing on a hit. */
  const filedItem = (key: string): FiledItem | undefined => {
    const ref = ticketItemRef(key);
    if (!ref) return undefined;
    const tasks = ref.taskId
      ? [taskStore.getTask(ref.taskId)].flatMap((t) => (t ? [t] : []))
      : taskStore
          .listWorkspaces()
          .flatMap((w) => taskStore.listTasks(w.id, { includeArchived: true }));
    for (const task of tasks) {
      const found = taskStore.listReviewItems(task.id).find((i) => i.id === ref.itemId);
      if (!found) continue;
      const w = taskStore.getWorkspace(task.workspaceId);
      return { item: found, task, boardLive: w !== undefined && !isRetired(w) };
    }
    return undefined;
  };

  const item: CrossReview['item'] = async (key) => {
    await prepare();
    const q = compute();
    const found = findQueueItem(q.items, key);
    const notQueued = found ? undefined : whyNotQueued(filedItem(key));
    return {
      ...(found ? { item: found } : {}),
      ...(notQueued ? { notQueued } : {}),
      ...(q.planWorkspaceId ? { planWorkspaceId: q.planWorkspaceId } : {}),
    };
  };

  const recordAnswer: CrossReview['recordAnswer'] = async (args) => {
    if (!isLive(args.workspaceId)) return null;
    await prepare();
    // Asked again: the board can be retired while the loads hand back.
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
      ...(args.blocking ? { blocking: true as const } : {}),
    };
    ledger.append(record);
    return record;
  };

  const isLive = (workspaceId: string): boolean => {
    const w = taskStore.getWorkspace(workspaceId);
    return w !== undefined && !isRetired(w);
  };

  const later = (fn: () => Promise<unknown>) =>
    setTimeout(() => {
      fn().catch((err: unknown) => ctx.onError?.(err));
    }, 0);

  const offTask = taskStore.onEvent((event) => {
    if (event.type !== 'decision.answered') return;
    // A partial answer leaves the ask open; it is recorded when it closes.
    if (event.openParts !== undefined && event.openParts.length > 0) return;
    later(async () => {
      const task = taskStore.getTask(event.taskId);
      if (!task) return;
      const rid = event.reviewItemId ?? LEGACY_REVIEW_ITEM_ID;
      const item = taskStore.listReviewItems(task.id).find((i) => i.id === rid);
      if (!item) return;
      const legacy = rid === LEGACY_REVIEW_ITEM_ID;
      await recordAnswer({
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
        blocking: isBlockingAsk(item.review),
      });
    });
  });

  /** The board a thread's doc sits on, and which kind of row its threads make. */
  const threadHome = (docId: string) => {
    const rowId = docId.startsWith('task:') ? docId.slice('task:'.length) : undefined;
    const task = rowId ? taskStore.getTask(rowId) : undefined;
    const goal = rowId && !task ? taskStore.getGoalRow(rowId) : undefined;
    const workspaceId =
      task?.workspaceId ??
      goal?.workspaceId ??
      taskStore.listWorkspaces().find((w) => w.docIds.includes(docId))?.id;
    if (!workspaceId) return null;
    const kind: 'task-thread' | 'goal-thread' | 'doc-thread' = task
      ? 'task-thread'
      : goal
        ? 'goal-thread'
        : 'doc-thread';
    return { workspaceId, kind, task };
  };

  const offDoc = docStore.onReviewAnswered((event) => {
    if (event.openParts !== undefined && event.openParts.length > 0) return;
    later(async () => {
      const comment = docStore
        .listThreads(event.docId)
        .find((t) => t.id === event.threadId)
        ?.comments.find((c) => c.id === event.commentId);
      const review = comment?.review;
      if (!comment || !review) return;
      const home = threadHome(event.docId);
      if (!home) return;
      const { workspaceId, kind, task } = home;
      await recordAnswer({
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
        blocking: isBlockingAsk(review),
      });
    });
  });

  // An ask nobody declared is answered by an ordinary reply: the person's
  // comment ends the agent's run and the row is gone. So the row is read as
  // the thread stood without that comment, and each one the comment retired
  // is recorded the way a declared answer is.
  const offComment = docStore.onCommentPosted((event) => {
    if (classifyActor(event.author) === 'agent') return;
    later(async () => {
      const home = threadHome(event.docId);
      const w = home && taskStore.listWorkspaces().find((b) => b.id === home.workspaceId);
      if (!home || !w || isRetired(w)) return;
      // Both reads below walk this board's threads; they are loaded first so
      // the pair stays one synchronous stretch over the same state.
      await docStore.warmForThreadReads(readTargets([w]));
      const onThread = (r: SizedReviewItemRow) =>
        r.kind !== 'task-review' && r.docId === event.docId && r.threadId === event.threadId;
      const still = new Set(
        reviewItemsFor(w)
          .filter(onThread)
          .map((r) => r.band),
      );
      for (const row of reviewItemsFor(w, event).filter(onThread)) {
        if (row.kind === 'task-review' || row.band !== 'unreplied' || still.has(row.band)) continue;
        await recordAnswer({
          workspaceId: w.id,
          ask: askShapeOf(row),
          key: `${row.kind}:${row.docId}:${row.threadId}`,
          askedAt: row.askedAt ?? row.since,
          visibleAt: row.askedAt ?? row.since,
          answeredAt: event.ts,
          size: { minutes: row.minutes, size: row.size },
        });
      }
    });
  });

  return {
    plan,
    projects: () => projectsOf(liveBoards()),
    prepare,
    queue,
    item,
    ledger,
    recordAnswer,
    dispose: () => {
      offTask();
      offDoc();
      offComment();
    },
  };
}
