/**
 * Resolve a review item named by an agent — on any board this server holds —
 * into the snapshot a comment carries (`LinkedReviewItem`).
 *
 * Two kinds of item: one filed on a ticket (`task.reviews`, addressed by
 * taskId + reviewItemId) and one declared on a comment thread (a comment
 * carrying `review`, addressed by docId + threadId). Each is checked against
 * the board the caller named, so an id from one board cannot be passed off as
 * another's. The link is the one the item's own board opens it at — the
 * ticket's deep link, or the doc at the thread — and stays root-relative.
 *
 * The stores are structural so this module needs neither, and its test drives
 * it with plain objects.
 */
import {
  type DocType,
  type LinkedReviewItem,
  type ReviewPayload,
  type TaskReviewItem,
  type Thread,
  pendingDeclaration,
  readLinkedItem,
} from '@claude-workspaces/core';
import { pageThreadHref, pageUrlOf } from '@claude-workspaces/core/page-thread-link';
import { taskDeepLink } from './home-brief.ts';

/** What the caller asked to link, as parsed off a request body. */
export type LinkItemRequest =
  | { workspaceId: string; taskId: string; reviewItemId: string }
  | { workspaceId: string; docId: string; threadId: string };

const MAX_ID = 300;
const okId = (v: unknown): v is string =>
  typeof v === 'string' && v.trim() !== '' && v.length <= MAX_ID;

/** The `item` of a request body, or null when it names neither kind whole. */
export function parseLinkItemRequest(raw: unknown): LinkItemRequest | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const { workspaceId, taskId, reviewItemId, docId, threadId } = raw as Record<string, unknown>;
  if (!okId(workspaceId)) return null;
  const ticket = taskId !== undefined || reviewItemId !== undefined;
  const thread = docId !== undefined || threadId !== undefined;
  if (ticket === thread) return null;
  if (ticket)
    return okId(taskId) && okId(reviewItemId) ? { workspaceId, taskId, reviewItemId } : null;
  return okId(docId) && okId(threadId) ? { workspaceId, docId, threadId } : null;
}

/** What resolving reads of the server. */
export interface LinkedItemSources {
  boardName(workspaceId: string): string | undefined;
  taskBoard(taskId: string): string | undefined;
  reviewItems(taskId: string): TaskReviewItem[];
  /** Every board holding the doc; a ticket's body doc answers its task's. */
  boardsOfDoc(docId: string): string[];
  thread(docId: string, threadId: string): Thread | null;
  docType(docId: string): DocType | undefined;
  isGoal(id: string): boolean;
}

export type LinkedItemResult =
  | { ok: true; item: LinkedReviewItem }
  | { ok: false; status: 404 | 422; error: string };

const missing = (error: string): LinkedItemResult => ({ ok: false, status: 404, error });

/** The declaration a thread's item is: the standing one, else the newest. */
function threadDeclaration(thread: Thread): ReviewPayload | undefined {
  const standing = pendingDeclaration(thread)?.review;
  if (standing) return standing;
  return [...thread.comments].reverse().find((c) => c.review !== undefined)?.review;
}

/** Where a thread opens on its own board — the link the board's Home builds. */
export function threadItemHref(
  workspaceId: string,
  docId: string,
  thread: Pick<Thread, 'id' | 'anchor'>,
  type: DocType | undefined,
  isGoal: (id: string) => boolean,
): string {
  const board = `/workspaces/${encodeURIComponent(workspaceId)}`;
  if (docId.startsWith('task:')) {
    const id = docId.slice('task:'.length);
    return isGoal(id) ? `${board}?goal=${encodeURIComponent(id)}` : taskDeepLink(workspaceId, id);
  }
  const doc = encodeURIComponent(docId);
  if (type === 'app') {
    return pageThreadHref(`${board}/apps/${doc}/`, thread.id, pageUrlOf(thread.anchor));
  }
  const surface = type === 'mockup' ? 'mockups' : 'docs';
  return pageThreadHref(`${board}/${surface}/${doc}`, thread.id);
}

/** The snapshot for `req`, or the 404 naming what was not found. */
export function resolveLinkedItem(req: LinkItemRequest, src: LinkedItemSources): LinkedItemResult {
  const { workspaceId } = req;
  const board = src.boardName(workspaceId);
  if (board === undefined) return missing('workspace not found');
  let headline: string;
  let url: string;
  let ref: LinkedReviewItem['ref'];
  if ('taskId' in req) {
    if (src.taskBoard(req.taskId) !== workspaceId) return missing('task not found on that board');
    const found = src.reviewItems(req.taskId).find((r) => r.id === req.reviewItemId);
    if (!found) return missing('review item not found');
    headline = found.review.headline;
    url = taskDeepLink(workspaceId, req.taskId);
    ref = { taskId: req.taskId, reviewItemId: req.reviewItemId };
  } else {
    if (!src.boardsOfDoc(req.docId).includes(workspaceId)) {
      return missing('doc not found on that board');
    }
    const thread = src.thread(req.docId, req.threadId);
    if (!thread) return missing('thread not found');
    const review = threadDeclaration(thread);
    if (!review) return missing('that thread carries no review item');
    headline = review.headline;
    url = threadItemHref(workspaceId, req.docId, thread, src.docType(req.docId), src.isGoal);
    ref = { docId: req.docId, threadId: req.threadId };
  }
  // The stored reader's own check, run before the write: a snapshot it would
  // drop on read (a headline past its cap, a link off the origin) is refused
  // here rather than stored as a comment that renders as plain text.
  const item = readLinkedItem({ workspaceId, board: board || workspaceId, headline, url, ref });
  return item
    ? { ok: true, item }
    : { ok: false, status: 422, error: 'that review item cannot be linked' };
}
