/**
 * The contract for the routes that file, answer, revise and withdraw a
 * ticket's review items, ask back on one, and find where a bare item id lives
 * (`route-contract.ts` says what a contract is). Four families serve them:
 * `task-review-items.ts` (filing, answering, revising and withdrawing an
 * item), `task-answers.ts` (the ticket's own decision), `task-review-ask-back.ts`
 * (asking back on an item) and `workspace-home.ts` (the resolve).
 *
 * Every body carries `author`, which `authorFor` resolves, so it is `unknown`
 * here.
 */
import type { TaskReviewItem, Thread } from '@claude-workspaces/core';
import type { Task } from '@claude-workspaces/core/task-wire';
import { Hono } from 'hono';
import type { HeldFields } from '../review-gate-types.ts';
import { answers, json } from './route-contract.ts';

/** Checked whole by `checkReviewPayload` in the store. */
export interface AddReviewItemBody {
  review: unknown;
  author?: unknown;
}
/** `answeredWith` names the option the words came from. */
export interface ReviewAnswerBody {
  text: string;
  answeredWith?: string;
  author?: unknown;
}
/** The ticket's own decision; `optionId` is the legacy spelling of `answeredWith`. */
export interface DecisionAnswerBody {
  text: string;
  optionId?: string;
  author?: unknown;
}
export interface ReviseReviewItemBody {
  headline?: string;
  detail?: string;
  options?: unknown;
  revisedRange?: { start: number; end: number };
  lessSpecific?: string;
  reply?: string;
  reason?: string;
  author?: unknown;
}
export interface WithdrawReviewItemBody {
  reason?: string;
  author?: unknown;
}
export interface MoreInfoBody {
  question: string;
  author?: unknown;
}

export type AddReviewItemAnswer = HeldFields & {
  task: Task;
  item: TaskReviewItem;
  url?: string;
  reviewAdvice?: string;
};
/** Every answer and ask-back answers the ticket as it now stands. */
export interface TicketAnswer {
  task: Task;
  /** A person's question typed where the answer goes was recorded as an ask-back. */
  asked?: true;
}
export type ReviseReviewItemAnswer = HeldFields & {
  task: Task;
  item: TaskReviewItem;
  url?: string;
  threadId?: string;
  thread?: Thread;
  reviewAdvice?: string;
};
export interface WithdrawReviewItemAnswer {
  taskId: string;
  reviewItemId: string;
  item: TaskReviewItem;
  withdrawn: boolean;
}
/** Where a bare item id lives: a comment on a doc thread, or a row on a ticket. */
export type ResolveReviewItemAnswer =
  | {
      reviewItemId: string;
      kind: 'doc-thread';
      docId: string;
      threadId: string;
      commentId: string;
      workspaceId?: string;
    }
  | { reviewItemId: string; kind: 'task-item'; taskId: string; workspaceId: string };

const task = '/workspaces/:ws/tasks/:taskId';
const item = `${task}/review-items/:itemId`;

export const reviewItemsContract = new Hono()
  .post(`${task}/review-items`, json<AddReviewItemBody>(), answers<AddReviewItemAnswer>())
  .post(`${task}/answer`, json<DecisionAnswerBody>(), answers<TicketAnswer>())
  .post(`${task}/more-info`, json<MoreInfoBody>(), answers<TicketAnswer>())
  .post(`${item}/answer`, json<ReviewAnswerBody>(), answers<TicketAnswer>())
  .post(`${item}/revise`, json<ReviseReviewItemBody>(), answers<ReviseReviewItemAnswer>())
  .post(`${item}/withdraw`, json<WithdrawReviewItemBody>(), answers<WithdrawReviewItemAnswer>())
  .post(
    `${item}/withdraw/undo`,
    json<WithdrawReviewItemBody>(),
    answers<WithdrawReviewItemAnswer>(),
  )
  .post(`${item}/more-info`, json<MoreInfoBody>(), answers<TicketAnswer>())
  .get('/workspaces/:ws/review-items/:itemId', answers<ResolveReviewItemAnswer>());

export type ReviewItemsContract = typeof reviewItemsContract;
