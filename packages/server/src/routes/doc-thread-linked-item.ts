/**
 * `POST /workspaces/:ws/docs/:docId/threads/:threadId/linked-items` — an
 * agent points a thread at a review item filed anywhere on this server,
 * including another board (`link_review_item`).
 *
 * One new comment on the thread, posted through the same `postComment` path a
 * reply takes, so every open page gets it over the doc's sync and every
 * watcher hears `thread.replied`. Its `text` names the board, the headline and
 * the link, so a surface that renders only words still shows what was linked;
 * its `linkedItem` is the snapshot a surface that knows the field draws as a
 * card (`linked-review-item.ts` resolves it).
 *
 * Gated as a reply is — the board scope this resource block already sits
 * behind, `authorFor` and the category-author refusal — and closed to share
 * visitors outright: the item may be on a board the visitor cannot see, and
 * its headline is that board's content. For the same reason an item from
 * another board is refused onto a board that is shared at all, unless the
 * owner asks from the board's own page: the snapshot would be read there by
 * its members.
 */
import { linkedItemText } from '@claude-workspaces/core';
import { parseLinkItemRequest, resolveLinkedItem } from '../linked-review-item.ts';
import { writeViaOf } from '../mockup-frame.ts';
import { hasOwnerProof } from '../share/owner-proof.ts';
import { isCategoryAuthor } from '../task-owner.ts';
import type { DocResourceRouteRequest, DocRoutesContext } from './docs-routes-context.ts';

const PATH = /^threads\/([^/]+)\/linked-items$/;
/** The longest note an agent may put above the link. */
const MAX_NOTE = 4000;

export async function handleDocThreadLinkedItemRoute(
  ctx: DocRoutesContext,
  rq: DocResourceRouteRequest,
): Promise<Response | undefined> {
  const m = rq.rest.match(PATH);
  if (!m || rq.req.method !== 'POST') return undefined;
  const { docStore, taskStore, j, safeJson } = ctx;
  if (rq.visitor) return j(403, { error: 'linking a review item is not open to share visitors' });
  const threadId = decodeURIComponent(m[1] ?? '');
  const body = await safeJson(rq.req);
  if (!body) return j(400, { error: 'JSON body required' });
  const user = rq.authorFor(body.author);
  if (!user) return j(400, { error: 'author required' });
  if (isCategoryAuthor(user)) return rq.refuseCategoryAuthor();
  const note = body.text;
  if (note !== undefined && (typeof note !== 'string' || note.length > MAX_NOTE)) {
    return j(400, { error: `text must be a string of at most ${MAX_NOTE} characters` });
  }
  const parsed = parseLinkItemRequest(body.item);
  if (!parsed) {
    return j(400, {
      error:
        'item must be {workspaceId, taskId, reviewItemId} for a ticket item or ' +
        '{workspaceId, docId, threadId} for a thread item',
    });
  }
  if (!docStore.getThread(rq.docId, threadId)) return j(404, { error: 'thread not found' });
  // Another board's item on a board somebody else can open would show them
  // that board's headline, which nobody gave them (security.md: a read of
  // another board dressed as a write). So it is linked only onto a board
  // nobody else can open, or by the owner from the board's own page. Asked
  // before the item is looked up, so the refusal says nothing about whether
  // it exists.
  const here = rq.scope?.workspaceId;
  if (
    parsed.workspaceId !== here &&
    (!here || ctx.boardIsShared(here)) &&
    !hasOwnerProof(rq.req, rq.provenIdentityFor, rq.requestOriginFor)
  ) {
    return j(403, {
      error:
        'this board is shared, so only its owner, from the board, may link a review item ' +
        'from another board here: its headline would reach people that board was never shared with',
    });
  }
  // A doc named by an alias is stored by its own id, so the snapshot's ref
  // and link name the doc the way every other surface does.
  const request =
    'docId' in parsed ? { ...parsed, docId: docStore.resolveDocId(parsed.docId) } : parsed;
  const resolved = resolveLinkedItem(request, {
    boardName: (ws) => taskStore.getWorkspace(ws)?.name,
    taskBoard: (taskId) => taskStore.getTask(taskId)?.workspaceId,
    reviewItems: (taskId) => taskStore.listReviewItems(taskId),
    boardsOfDoc: (docId) => {
      const ticketBoard = taskStore.workspaceOfDoc(docId);
      return [...(ticketBoard ? [ticketBoard] : []), ...ctx.workspacesOfDoc(docId)];
    },
    thread: (docId, id) => docStore.getThread(docId, id),
    docType: (docId) => docStore.peekMeta(docId)?.type,
    isGoal: (id) => taskStore.getGoalRow(id) !== undefined,
  });
  if (!resolved.ok) return j(resolved.status, { error: resolved.error });
  // Recorded, as on a reply, when a mock page's host relayed the write.
  const via = writeViaOf(rq.req);
  const thread = await docStore.postComment(
    rq.docId,
    threadId,
    user,
    linkedItemText(resolved.item, typeof note === 'string' ? note : undefined),
    undefined,
    { generate: true, linkedItem: resolved.item, ...(via ? { via } : {}) },
  );
  if (!thread) return j(404, { error: 'thread not found' });
  const comment = [...thread.comments]
    .reverse()
    .find((c) => c.author.id === user.id && c.linkedItem);
  return j(200, {
    thread: docStore.getThread(rq.docId, thread.id) ?? thread,
    ...(comment ? { commentId: comment.id } : {}),
    linkedItem: resolved.item,
  });
}
