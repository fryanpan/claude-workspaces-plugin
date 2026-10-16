/**
 * The plan lead's ranks and its feed of new asks, composed against the
 * server's stores: one call from `server.ts`.
 *
 *  - `ranks` (`review-ranks.ts`) holds the lead's rank per item and the
 *    person moves that void one. `leadRank` is what the cross-board queue
 *    reads; a rank on a board the lead may not hear from never counts.
 *  - `feed` (`ask-feed.ts`) hears every new review item, on a ticket through
 *    the task store's `review_item.added` and on a doc thread through the
 *    live-doc event hook (`onDocEvent`), and sends them to the lead in
 *    batches.
 *  - `isOff` is the exclusion for both the feed and a rank or tag: the
 *    coach's (`coach/exclusion.ts`), including the boards the owner turned
 *    the coach off for, and every board while the coach's state cannot be
 *    read.
 */
import type { WebhookPayload } from '@claude-workspaces/core';
import {
  AskFeed,
  type AskFrame,
  type GoalTitleOf,
  type ThreadHome,
  askFromReviewItemAdded,
  asksFromThreadEvent,
} from './ask-feed.ts';
import type { CrossReviewItem } from './cross-review-queue.ts';
import { ReviewRanks } from './review-ranks.ts';
import type { TaskStoreEvent } from './tasks.ts';

export interface LeadRankWiringDeps {
  dataDir: string;
  /** The plan board's id, read when it is needed. */
  planBoard: () => string | undefined;
  leadOf: (workspaceId: string) => string | undefined;
  boardName: (workspaceId: string) => string | undefined;
  /** A goal's title, for the goal a blocking ask stops (`ask-feed.ts`). */
  goalTitle?: GoalTitleOf;
  isOff: (place: { workspaceId: string; docId?: string }) => boolean;
  /** Where a doc's threads sit (`threadHomes`). */
  taskWorkspace: (taskId: string) => string | undefined;
  goalWorkspace: (rowId: string) => string | undefined;
  boardsForDoc: (docId: string) => Iterable<string>;
  onTaskEvent: (listener: (event: TaskStoreEvent) => void) => () => void;
  sendToAgent: (workspaceId: string, agentId: string, frame: AskFrame) => number;
  agentConnected: (workspaceId: string, agentId: string) => boolean;
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => () => void;
}

export interface LeadRankWiring {
  ranks: ReviewRanks;
  feed: AskFeed;
  leadRank: (item: CrossReviewItem) => number | undefined;
  leadGoal: (item: CrossReviewItem) => string | undefined;
  onDocEvent: (docId: string, payload: WebhookPayload) => void;
  stop: () => void;
}

/** The task an item's rank is voided by a person moving, if any. */
const taskOfItem = (item: CrossReviewItem): string | undefined =>
  item.kind === 'task-review' || item.kind === 'task-thread' ? item.taskId : undefined;

const placeOfItem = (item: CrossReviewItem): { workspaceId: string; docId?: string } => {
  const docId = item.kind === 'task-review' ? `task:${item.taskId}` : item.docId;
  return { workspaceId: item.workspaceId, docId };
};

export function wireLeadRanks(deps: LeadRankWiringDeps): LeadRankWiring {
  const ranks = new ReviewRanks(deps.dataDir, deps.now);
  const feed = new AskFeed({
    lead: () => {
      const ws = deps.planBoard();
      const agentId = ws ? deps.leadOf(ws) : undefined;
      return ws && agentId ? { workspaceId: ws, agentId } : null;
    },
    isOff: deps.isOff,
    send: deps.sendToAgent,
    connected: deps.agentConnected,
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.schedule ? { schedule: deps.schedule } : {}),
  });

  const threadHomes = (docId: string): ThreadHome[] => {
    const rowId = docId.startsWith('task:') ? docId.slice('task:'.length) : undefined;
    if (rowId) {
      const taskWs = deps.taskWorkspace(rowId);
      if (taskWs) return [{ workspaceId: taskWs, kind: 'task-thread', taskId: rowId }];
      const goalWs = deps.goalWorkspace(rowId);
      return goalWs ? [{ workspaceId: goalWs, kind: 'goal-thread' }] : [];
    }
    return [...deps.boardsForDoc(docId)].map((workspaceId) => ({
      workspaceId,
      kind: 'doc-thread' as const,
    }));
  };

  // Both hooks run inside the write that emitted them, so a failure here is
  // logged and never thrown back into the filing or the comment.
  const guarded = (what: string, fn: () => void): void => {
    try {
      fn();
    } catch (err) {
      console.warn(`[lead-ranks] ${what} failed: ${String(err)}`);
    }
  };

  const offTask = deps.onTaskEvent((ev) => {
    if (ev.type === 'review_item.added') {
      guarded('ask feed', () =>
        feed.offer(askFromReviewItemAdded(ev, deps.boardName(ev.workspaceId), deps.goalTitle)),
      );
    } else if (ev.type === 'task.regrouped' && ev.actor.kind === 'person') {
      guarded('person move', () => ranks.notePersonMove(ev.workspaceId, ev.taskId, ev.ts));
    }
  });

  /** Whether an item may carry the lead's opinion at all. Only an item with
   *  something stored pays for the privacy check. */
  const counts = (item: CrossReviewItem): boolean => {
    if (!ranks.has(item.key)) return false;
    try {
      return !deps.isOff(placeOfItem(item));
    } catch {
      return false;
    }
  };

  return {
    ranks,
    feed,
    leadRank: (item) =>
      counts(item) ? ranks.rankOf(item.key, item.workspaceId, taskOfItem(item)) : undefined,
    leadGoal: (item) =>
      counts(item) ? ranks.goalOf(item.key, item.workspaceId, taskOfItem(item)) : undefined,
    onDocEvent: (docId, payload) => {
      if (payload.event !== 'thread.created' && payload.event !== 'thread.replied') return;
      guarded('ask feed', () => {
        const homes = threadHomes(docId).map((h) => {
          const board = deps.boardName(h.workspaceId);
          return board ? { ...h, board } : h;
        });
        for (const ask of asksFromThreadEvent(payload, homes, deps.goalTitle)) feed.offer(ask);
      });
    },
    stop: () => {
      offTask();
      feed.stop();
    },
  };
}
