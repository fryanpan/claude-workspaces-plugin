import { isOwnerActor } from '../actor-identity.ts';
import { userForIdentity } from '../identities.ts';
import { matchRest } from '../middleware/workspace-scope.ts';
import { taskIsClosed } from '../permission-grants.ts';
import { reviewItemAnsweredEvent, reviewItemFilerId } from '../review-items/analytics.ts';
import { refuseOwnerOnlyWrite } from '../share/board-role.ts';
import type { TaskRouteRequest, TaskRoutesContext } from './task-routes-context.ts';

/**
 * THE GRANT DOOR — the one route on this server that writes the owner's
 * Claude Code user settings, and it only ever appends the allow lines a
 * `grant` card listed.
 *
 * `POST /workspaces/<ws>/tasks/<id>/review-items/<item>/grant` with
 * `{ decision: 'approve' | 'decline', allowRules: [...] }`. Approve writes
 * the lines (`permission-grants.ts`) and records the answer; Decline records
 * the answer and writes nothing. Either closes the card.
 *
 * THE ORDER OF THE REFUSALS IS THE SECURITY PROPERTY, as on the secrets door
 * beside it:
 *  1. The task must be on the path's board (404 otherwise, as for a task
 *     that does not exist), and the item must be a grant card — the shape,
 *     not a flag, decides.
 *  2. `refuseOwnerOnlyWrite`, asked about the TASK's board: a share or
 *     collab visitor is refused (the route is also absent from the host
 *     guard's member allowlist, so none reaches it at all).
 *  3. A PERSON PROOF naming the owner — the Cloudflare Access email or the
 *     signed session cookie, resolved by `provenIdentityFor`. `requireOwner`
 *     alone is not enough here: it passes every loopback caller, and every
 *     agent and MCP child on this machine is one. A body's claimed author is
 *     never read for this, and neither is a widget popup token (the widget
 *     never renders a grant card) nor an agent token. So an agent can file
 *     the card and cannot approve it.
 *  4. The request came from the board's own page: `Sec-Fetch-Site:
 *     same-origin` and an `Origin` equal to this server's own. The
 *     cross-origin write gate admits a dev server on any local port, and a
 *     session cookie is same-site with it, so without this a page an agent
 *     wrote could press Approve for a signed-in owner.
 *  5. After the body is read, from a fresh read: for an Approve, the task
 *     is still open (its lines would be written after the close released
 *     it, and stay until the next boot); the card is still open; and the
 *     store would record the answer.
 *  6. The lines the browser was SHOWING must equal the lines stored. A card
 *     reworded between render and tap is refused, so the owner approves
 *     exactly what they read.
 * Only then is the settings file touched, and a refused write (the file does
 * not parse, it changed underfoot) leaves the card open with the reason.
 * Nothing between step 5 and the answer awaits, so the answer cannot be
 * refused after the lines are written.
 */
export async function handleTaskGrants(
  ctx: TaskRoutesContext,
  rq: TaskRouteRequest,
): Promise<Response | undefined> {
  const { taskStore, taskProjection, j, safeJson, permissionGrants } = ctx;
  const { req, scope, requireOwner, roleFor, provenIdentityFor, requestOriginFor } = rq;
  const match = matchRest(scope, /^tasks\/([^/]+)\/review-items\/([^/]+)\/grant$/);
  if (!match || req.method !== 'POST') return undefined;
  const workspaceId = scope?.workspaceId ?? '';
  const taskId = decodeURIComponent(match[1] ?? '');
  const reviewItemId = decodeURIComponent(match[2] ?? '');

  const task = taskStore.getTask(taskId);
  if (!task || task.workspaceId !== workspaceId) return j(404, { error: 'not-found' });
  const item = taskStore.listReviewItems(taskId).find((r) => r.id === reviewItemId);
  if (!item) return j(404, { error: 'not-found' });
  if (item.review.shape !== 'grant' || (item.review.allowRules ?? []).length === 0) {
    return j(400, { error: 'not-a-grant-item', message: 'this item does not ask for permissions' });
  }
  {
    const denied = refuseOwnerOnlyWrite(item.review, task.workspaceId, requireOwner);
    if (denied) return denied;
  }
  const proven = provenIdentityFor?.() ?? null;
  if (!proven || !isOwnerActor({ id: proven.id })) {
    return j(403, {
      error: 'owner-proof-required',
      message:
        "Only the board's owner, signed in, can approve permissions. An agent cannot answer this card.",
    });
  }
  const origin = req.headers.get('origin');
  const ownOrigin = requestOriginFor?.();
  if (
    req.headers.get('sec-fetch-site') !== 'same-origin' ||
    origin === null ||
    ownOrigin === undefined ||
    origin !== ownOrigin
  ) {
    return j(403, {
      error: 'same-origin-only',
      message: "Approve permissions from the card on this board's own page.",
    });
  }
  if (item.answer !== undefined) {
    return j(409, { error: 'answered', message: 'this card is already answered' });
  }

  const body = await safeJson(req);
  const decision = body?.decision;
  if (decision !== 'approve' && decision !== 'decline') {
    return j(400, { error: "decision must be 'approve' or 'decline'" });
  }
  // Read again: the body read awaited, and the card or its task may have
  // moved in the meantime. From here to the answer nothing awaits.
  if (decision === 'approve' && taskIsClosed(taskStore, taskId)) {
    return j(409, {
      error: 'task-closed',
      message: 'this task is closed, so its permissions would never be taken back',
    });
  }
  const current = taskStore.listReviewItems(taskId).find((r) => r.id === reviewItemId);
  if (!current || current.answer !== undefined) {
    return j(409, { error: 'answered', message: 'this card is already answered' });
  }
  const rules = current.review.shape === 'grant' ? (current.review.allowRules ?? []) : [];
  const shown = body?.allowRules;
  if (
    rules.length === 0 ||
    !Array.isArray(shown) ||
    shown.length !== rules.length ||
    shown.some((r, i) => r !== rules[i])
  ) {
    return j(409, {
      error: 'card-changed',
      message: 'the lines on this card changed since you opened it — reload and read them again',
    });
  }
  const author = userForIdentity(proven);
  {
    const refused = taskStore.answerTaskReviewRefusal(taskId, reviewItemId, {
      actor: author,
      door: 'grant',
    });
    if (refused) return j(refused.error === 'not-found' ? 404 : 400, refused);
  }

  let text: string;
  if (decision === 'approve') {
    if (!permissionGrants) {
      return j(503, {
        error: 'grants-unavailable',
        message: 'this server is not set up to edit your settings',
      });
    }
    const res = permissionGrants.grant(taskId, reviewItemId, rules, author.id, Date.now());
    if (!res.ok) {
      return j(409, {
        error: res.error,
        message: `${res.message}. The card is still open.`,
      });
    }
    text = `Approved. Allowed until this task closes: ${rules.join(', ')}`;
  } else {
    text = 'Declined. No permissions were added.';
  }

  // No `answeredWith`: a grant card has no options, and the store refuses an
  // option id the row does not carry. The decision is in the text.
  const answered = taskStore.answerTaskReview(taskId, reviewItemId, text, {
    actor: author,
    door: 'grant',
    ...(proven.email ? { provenEmail: proven.email } : {}),
  });
  if (!answered.ok) return j(answered.error === 'not-found' ? 404 : 400, answered);
  taskProjection.refreshTask(answered.task);
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
  return j(200, { taskId, reviewItemId, item: answered.item, decision });
}
