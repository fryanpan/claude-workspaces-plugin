/**
 * `POST /workspaces/<ws>/tasks/<taskId>/review-items/<itemId>/answer/undo`:
 * take back the answer on one of a ticket's review items.
 *
 * The undo the item's `/answer` door lacked. The ticket's own decision has
 * `tasks/<id>/answer/undo` and a doc-thread item has `threads/<id>/answer/undo`;
 * this is the same act for a row filed on the ticket, and it accepts
 * `r-legacy` too, so a caller holding a queue row has one address whatever
 * the row is. The store side is `review-items/undo-answer.ts`.
 *
 * Gated as `/answer` is, short of share visitors: the owner-only refusal, and
 * the secret and grant refusals, since neither shape is answered here. It is
 * not on the share member allowlist, so a share visitor never reaches it.
 */
import { matchRest } from '../middleware/workspace-scope.ts';
import { PERSON_PROOF_REQUIRED, unprovenPersonAnswer } from '../review-items/answer-proof.ts';
import {
  GRANT_ANSWER_DENIAL,
  SECRET_ANSWER_DENIAL,
  asksForGrant,
  asksForSecret,
  refuseOwnerOnlyWrite,
} from '../share/board-role.ts';
import { isCategoryAuthor } from '../task-owner.ts';
import type { TaskRouteRequest, TaskRoutesContext } from './task-routes-context.ts';

/** Answers the route above, or `undefined` when the path is not it. */
export async function handleTaskReviewAnswerUndo(
  ctx: TaskRoutesContext,
  rq: TaskRouteRequest,
): Promise<Response | undefined> {
  const { taskStore, taskProjection, j, safeJson } = ctx;
  const { req, scope, authorFor, refuseCategoryAuthor, requireOwner } = rq;
  const match = matchRest(scope, /^tasks\/([^/]+)\/review-items\/([^/]+)\/answer\/undo$/);
  if (!match || req.method !== 'POST') return undefined;
  const taskId = decodeURIComponent(match[1] ?? '');
  const reviewItemId = decodeURIComponent(match[2] ?? '');
  const item = taskStore.listReviewItems(taskId).find((r) => r.id === reviewItemId);
  {
    const denied = refuseOwnerOnlyWrite(item?.review, scope?.workspaceId ?? '', requireOwner);
    if (denied) return denied;
  }
  if (asksForSecret(item?.review)) return j(400, SECRET_ANSWER_DENIAL);
  if (asksForGrant(item?.review)) return j(400, GRANT_ANSWER_DENIAL);
  const body = await safeJson(req);
  const author = authorFor(body?.author);
  if (!author) return j(400, { error: 'author required' });
  if (isCategoryAuthor(author)) return refuseCategoryAuthor();
  // Taking back a person's answer is that person's, on the same proof.
  if (unprovenPersonAnswer(author, rq.answerProof)) return j(403, PERSON_PROOF_REQUIRED);
  const res = taskStore.undoTaskReviewAnswer(taskId, reviewItemId, { actor: author });
  if (!res.ok) {
    if (res.error === 'answered-by-other') return j(409, res);
    const status = res.error === 'not-found' || res.error === 'unknown-review-item' ? 404 : 400;
    return j(status, { error: res.error });
  }
  taskProjection.refreshTask(res.task);
  return j(200, { taskId, reviewItemId, item: res.item });
}
