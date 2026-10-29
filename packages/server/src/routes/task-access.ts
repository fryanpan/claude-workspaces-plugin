import { readAccessChange, sameAccessChange } from '@claude-workspaces/core/review-access';
import { userForIdentity } from '../identities.ts';
import { matchRest } from '../middleware/workspace-scope.ts';
import { reviewItemAnsweredEvent, reviewItemFilerId } from '../review-items/analytics.ts';
import { ACCESS_APPROVE, ACCESS_REJECT } from '../review-items/owner-steps.ts';
import { refuseOwnerOnlyWrite } from '../share/board-role.ts';
import { ownerProof } from '../share/owner-proof.ts';
import type { TaskRouteRequest, TaskRoutesContext } from './task-routes-context.ts';

/**
 * THE ACCESS DOOR — the one route that applies an access change an agent
 * proposed (`share/access-proposals.ts`). Bryan, 29 Oct: only he changes who
 * is in.
 *
 * `POST /workspaces/<ws>/tasks/<id>/review-items/<item>/access` with
 * `{ decision: 'approve' | 'reject', access: <the change the card showed> }`.
 * Approve applies the change and records the answer; Reject records the
 * answer and changes nothing. Either closes the card.
 *
 * The grant door's six gates, in its order, because the property is the
 * same — an agent can file the card and cannot answer it:
 *  1. The task is on the path's board and the item carries an access change.
 *  2. `refuseOwnerOnlyWrite`: a share or collab visitor is refused.
 *  3. A person proof naming the owner (`share/owner-proof.ts`), never a
 *     body's claimed author, a widget token or an agent token.
 *  4. Sent same-origin from the board's own page.
 *  5. After the body is read, from a fresh read: the card is still open and
 *     the store would record the answer.
 *  6. The change the browser was SHOWING equals the change stored, so the
 *     owner approves exactly what they read.
 * Nothing between step 5 and the answer awaits, so the answer cannot be
 * refused after the change lands.
 */
export async function handleTaskAccess(
  ctx: TaskRoutesContext,
  rq: TaskRouteRequest,
): Promise<Response | undefined> {
  const { taskStore, taskProjection, j, safeJson, accessProposals } = ctx;
  const { req, scope, requireOwner, roleFor, provenIdentityFor, requestOriginFor } = rq;
  const match = matchRest(scope, /^tasks\/([^/]+)\/review-items\/([^/]+)\/access$/);
  if (!match || req.method !== 'POST') return undefined;
  const workspaceId = scope?.workspaceId ?? '';
  const taskId = decodeURIComponent(match[1] ?? '');
  const reviewItemId = decodeURIComponent(match[2] ?? '');

  const task = taskStore.getTask(taskId);
  if (!task || task.workspaceId !== workspaceId) return j(404, { error: 'not-found' });
  const item = taskStore.listReviewItems(taskId).find((r) => r.id === reviewItemId);
  if (!item) return j(404, { error: 'not-found' });
  if (!readAccessChange(item.access)) {
    return j(400, { error: 'not-an-access-item', message: 'this item proposes no access change' });
  }
  {
    const denied = refuseOwnerOnlyWrite(item.review, task.workspaceId, requireOwner);
    if (denied) return denied;
  }
  const proof = ownerProof(req, provenIdentityFor, requestOriginFor);
  if (!proof.ok) {
    return j(proof.status, {
      error: proof.error,
      message:
        proof.error === 'owner-proof-required'
          ? "Only the board's owner, signed in, can change who is in. An agent cannot answer this card."
          : "Approve access changes from the card on this board's own page.",
    });
  }
  if (item.answer !== undefined) {
    return j(409, { error: 'answered', message: 'this card is already answered' });
  }

  const body = await safeJson(req);
  const decision = body?.decision;
  if (decision !== 'approve' && decision !== 'reject') {
    return j(400, { error: "decision must be 'approve' or 'reject'" });
  }
  // Read again: the body read awaited. From here to the answer nothing awaits.
  const current = taskStore.listReviewItems(taskId).find((r) => r.id === reviewItemId);
  const change = readAccessChange(current?.access);
  if (!current || current.answer !== undefined || !change) {
    return j(409, { error: 'answered', message: 'this card is already answered' });
  }
  if (change.workspaceId !== workspaceId || !sameAccessChange(body?.access, change)) {
    return j(409, {
      error: 'card-changed',
      message: 'the change on this card is not the one you were shown — reload and read it again',
    });
  }
  const author = userForIdentity(proof.proven);
  {
    const refused = taskStore.answerTaskReviewRefusal(taskId, reviewItemId, {
      actor: author,
      door: 'access',
    });
    if (refused) return j(refused.error === 'not-found' ? 404 : 400, refused);
  }

  let text = 'Rejected. Nothing changed.';
  let url: string | undefined;
  if (decision === 'approve') {
    if (!accessProposals) {
      return j(503, { error: 'access-unavailable', message: 'this server cannot apply it' });
    }
    const applied = accessProposals.apply(change, author.name);
    if (!applied.ok) {
      return j(409, {
        error: applied.error,
        message: `${applied.message}. The card is still open.`,
      });
    }
    text = applied.text;
    url = applied.url;
  }

  const answered = taskStore.answerTaskReview(taskId, reviewItemId, text, {
    actor: author,
    answeredWith: decision === 'approve' ? ACCESS_APPROVE : ACCESS_REJECT,
    door: 'access',
    ...(proof.proven.email ? { provenEmail: proof.proven.email } : {}),
  });
  if (!answered.ok) return j(answered.error === 'not-found' ? 404 : 400, answered);
  taskProjection.refreshTask(answered.task);
  accessProposals?.changed();
  const filedById = reviewItemFilerId(answered.task, reviewItemId);
  taskStore.emit(
    reviewItemAnsweredEvent({
      workspaceId: answered.task.workspaceId,
      reviewItemId,
      taskId,
      actorId: author.id,
      isOwner: roleFor(answered.task.workspaceId) === 'owner',
      ...(filedById !== undefined ? { filedById } : {}),
      ts: Date.now(),
    }),
  );
  return j(200, {
    taskId,
    reviewItemId,
    item: answered.item,
    decision,
    ...(url ? { url } : {}),
  });
}
