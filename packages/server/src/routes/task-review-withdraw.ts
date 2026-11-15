/**
 * Taking a ticket-borne review item back, and putting it back.
 *
 * Split from `task-review-items.ts`, whose other verbs file, answer, release
 * and revise an item; this one only moves it off the reader's queue and on
 * again.
 */
import { isReviewItemHeld } from '@claude-workspaces/core';
import { matchRest } from '../middleware/workspace-scope.ts';
import { reviewItemFilerId } from '../review-items/analytics.ts';
import { SHARING_NOTICE_ACTOR } from '../sharing-notice.ts';
import { isCategoryAuthor } from '../task-owner.ts';
import type { WithdrawReviewItemAnswer, WithdrawReviewItemBody } from './review-items-contract.ts';
import { answerAs, sent } from './route-contract.ts';
import {
  type TaskRouteRequest,
  type TaskRoutesContext,
  ownerOnlyDenial,
} from './task-routes-context.ts';

/** Answers `…/review-items/:itemId/withdraw` and `/withdraw/undo`, or `undefined`. */
export async function handleTaskReviewWithdraw(
  ctx: TaskRoutesContext,
  rq: TaskRouteRequest,
): Promise<Response | undefined> {
  const { taskStore, taskProjection, j, safeJson, announceTaskReview } = ctx;
  const { req, scope, authorFor, refuseCategoryAuthor } = rq;
  // Taking a TICKET-borne ask back — the same exit the doc-thread
  // withdraw route has had, for the surface that lacked it: an item
  // filed with add_review_item had no way off the reader's queue short
  // of revising it into something else, which is a lie about what was
  // asked. Same contract as the doc route: the words stay on the ticket
  // verbatim, marked withdrawn with the reason beside them; refused on
  // an answered item (409 — the state, not the request, is what's
  // wrong); `/undo` puts the ask back in front of the reader.
  const taskReviewWithdrawMatch = matchRest(
    scope,
    /^tasks\/([^/]+)\/review-items\/([^/]+)\/withdraw(\/undo)?$/,
  );
  if (taskReviewWithdrawMatch && req.method === 'POST') {
    // No visitor refusal here, unlike its neighbours. Withdrawing is the exit
    // from filing, and a share member files review items on the board they
    // were admitted to (Bryan, 2026-09-03). The board question is asked one
    // layer up: `shareScopeAllows` admits this path only when the TASK is on
    // the workspace this member holds.
    const taskId = decodeURIComponent(taskReviewWithdrawMatch[1] ?? '');
    const reviewItemId = decodeURIComponent(taskReviewWithdrawMatch[2] ?? '');
    const denied = ownerOnlyDenial(ctx, rq, taskId, reviewItemId);
    if (denied) return denied;
    // The sharing notice's card is the owner's one way back in while sharing
    // is off; an agent that withdrew it would leave him nothing to approve.
    // Only the notice itself takes it down, when the switch comes back on.
    {
      const task = taskStore.getTask(taskId);
      if (task && reviewItemFilerId(task, reviewItemId) === SHARING_NOTICE_ACTOR.id) {
        return j(403, {
          error: 'sharing-notice',
          message: 'the sharing notice withdraws itself when sharing is turned back on',
        });
      }
    }
    const undo = taskReviewWithdrawMatch[3] !== undefined;
    const body = sent<WithdrawReviewItemBody>(await safeJson(req));
    const author = authorFor(body?.author);
    if (!author) return j(400, { error: 'author required' });
    if (isCategoryAuthor(author)) return refuseCategoryAuthor();
    const reason = body?.reason;
    if (reason !== undefined && typeof reason !== 'string') {
      return j(400, { error: 'reason must be a string' });
    }
    const res = taskStore.withdrawReviewItem(taskId, reviewItemId, {
      actor: author,
      ...(reason !== undefined ? { reason } : {}),
      ...(undo ? { undo: true } : {}),
    });
    if (!res.ok) {
      const status =
        res.error === 'not-found' || res.error === 'unknown-review-item'
          ? 404
          : res.error === 'answered'
            ? 409
            : 400;
      return j(status, {
        error: res.error,
        ...(res.message !== undefined ? { message: res.message } : {}),
      });
    }
    taskProjection.refreshTask(res.task);
    // Announced on the way BACK only, exactly as the doc route reasons:
    // a withdrawal must not buzz the reader with the ask just taken off
    // their queue, and a reinstated item still held by the gate is on
    // nobody's queue yet.
    if (undo && !isReviewItemHeld(res.item)) {
      announceTaskReview(res.task, res.item, author);
    }
    return j(
      200,
      answerAs<WithdrawReviewItemAnswer>({
        taskId,
        reviewItemId,
        item: res.item,
        withdrawn: !undo,
      }),
    );
  }
  return undefined;
}
