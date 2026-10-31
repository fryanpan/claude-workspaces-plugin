/**
 * The ASK-BACK pair on a ticket's review item: the two doors that record a
 * question rather than move the item.
 *
 * - A person's question typed into the answer box (`askBackFromAnswer`,
 *   called from the answer route in `task-review-items.ts`) becomes a thread
 *   on the item, and the item waits on its owner.
 * - An agent's "tell me more" (`handleTaskReviewMoreInfo`, the
 *   `request_more_info` tool's door) records the question with no thread,
 *   and the item stays on the person's queue.
 *
 * They differ on purpose — people ask, agents answer — and both read the same
 * owner-only rule as every other write on an item.
 */
import { type User, answerAsksBack } from '@claude-workspaces/core';
import { classifyActor } from '../actor-identity.ts';
import { matchRest } from '../middleware/workspace-scope.ts';
import {
  type TaskRouteRequest,
  type TaskRoutesContext,
  ownerOnlyDenial,
} from './task-routes-context.ts';

/** What the answer route has already parsed and checked. */
export interface AnswerBoxInput {
  taskId: string;
  reviewItemId: string;
  text: string;
  author: User;
  answeredWith: string | undefined;
}

/**
 * A question typed where the answer goes is an ASK BACK, not a decision.
 * Recording it as the answer closed the item and left `revise` refusing it
 * ("the answer is to the words it has"), so the only way to keep asking was a
 * duplicate row (Bryan, 2026-08-30: "Why is this important?" stamped as a
 * decision's answer). A person's un-tapped answer that ends asking is routed
 * through the EXISTING more-info shape instead: the question lands as a
 * thread on the item, the item waits on its owner, and the owner's revision
 * re-presents it with the question quoted. A tapped option is an answer
 * whatever its label ends in, and an agent's words never convert.
 *
 * Returns the response when the text was a question, `undefined` when the
 * answer route should record it as an answer. The caller has already run the
 * owner-only check, because this conversion is itself a write on the item.
 */
export async function askBackFromAnswer(
  ctx: TaskRoutesContext,
  rq: TaskRouteRequest,
  input: AnswerBoxInput,
): Promise<Response | undefined> {
  const { taskId, reviewItemId, text, author, answeredWith } = input;
  if (answeredWith !== undefined || classifyActor(author) !== 'person') return undefined;
  if (!answerAsksBack(text)) return undefined;
  const { taskStore, j, askBackOnItem } = ctx;
  const task = taskStore.getTask(taskId);
  if (!task) return j(404, { error: 'not-found' });
  // The ticket's OWN decision (`r-legacy`) takes this path too —
  // `listReviewItems` derives its row. It used to be recorded through the
  // task-level "tell me more" with no thread, which left the decision on the
  // queue under a question the reader had just asked; now it gets the same
  // thread and the same waiting state as a stored item.
  const item = taskStore.listReviewItems(taskId).find((r) => r.id === reviewItemId);
  // An unknown item falls through to the ordinary answer path, which owns
  // that refusal. An ANSWERED one is refused here: the fall-through would let
  // `answerTaskReview`'s legal repeat-answer displace the standing answer
  // with a question — a stale form racing another reader's answer would
  // overwrite it with the exact words this conversion exists to keep out of
  // that field (codex review). A question recorded on a closed item would
  // also reach nobody: `reviewItemState` reads `answer` first.
  if (item?.answer !== undefined) {
    return j(409, {
      error: 'answered',
      message:
        'this item is already answered — a question cannot displace the recorded answer; undo the answer first, or ask on the item’s thread',
    });
  }
  if (item) return askBackOnItem(task, item, text, author, Boolean(rq.visitor));
  return undefined;
}

/**
 * "Tell me more" on ONE review item — the `request_more_info` tool's door,
 * and deliberately NOT the reader's "I have a question". It records the
 * question with no thread, so `reviewItemState` never reads the item as
 * `waiting` and it stays on the queue: this is the agent-side ask for
 * context, and an agent asking must not take an item off the person's queue.
 * A person's question goes through the threads route (a `review-item` anchor
 * on the task doc), which is what makes the item wait on its owner.
 */
export async function handleTaskReviewMoreInfo(
  ctx: TaskRoutesContext,
  rq: TaskRouteRequest,
): Promise<Response | undefined> {
  const match = matchRest(rq.scope, /^tasks\/([^/]+)\/review-items\/([^/]+)\/more-info$/);
  if (!match || rq.req.method !== 'POST') return undefined;
  const { taskStore, taskProjection, j, safeJson } = ctx;
  const taskId = decodeURIComponent(match[1] ?? '');
  const reviewItemId = decodeURIComponent(match[2] ?? '');
  const denied = ownerOnlyDenial(ctx, rq, taskId, reviewItemId);
  if (denied) return denied;
  const body = await safeJson(rq.req);
  const question = typeof body?.question === 'string' ? body.question.trim() : '';
  if (question.length === 0) return j(400, { error: 'question required' });
  const author = rq.authorFor(body?.author);
  if (!author) return j(400, { error: 'author required' });
  const res = taskStore.requestMoreInfoOnReview(taskId, reviewItemId, question, {
    actor: author,
  });
  if (!res.ok) return j(res.error === 'not-found' ? 404 : 400, res);
  taskProjection.refreshTask(res.task);
  return j(200, res);
}
