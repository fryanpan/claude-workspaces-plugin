/**
 * A comment's link to a review item, read defensively.
 *
 * An agent on one board can point a thread at an ask filed anywhere on the
 * server (`link_review_item`). The server resolves the item and stores a
 * snapshot on the comment: the board's name, the headline and the path that
 * opens it. Like every other note a comment carries, the stored value is
 * written by whatever peer synced it, so a malformed one reads as absent
 * rather than reaching a renderer. The path must be root-relative, so a
 * stored link can never send the reader off the board's origin.
 */
import type * as Y from 'yjs';
import { getThreads, listThreads, postReply } from './schema.ts';
import type { Comment, LinkedReviewItem, Thread } from './types.ts';

/** The longest board name, headline and path a stored link may carry. */
export const MAX_LINKED_BOARD = 200;
export const MAX_LINKED_HEADLINE = 500;
export const MAX_LINKED_URL = 2000;
const MAX_ID = 300;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

const okString = (v: unknown, max: number): v is string =>
  typeof v === 'string' && v.trim() !== '' && v.length <= max;

/** A path on this origin: one leading `/`, no scheme, no host, no backslash,
 *  no whitespace or control characters. */
export function isRootRelativePath(v: unknown): v is string {
  if (!okString(v, MAX_LINKED_URL)) return false;
  if (!v.startsWith('/') || v.startsWith('//')) return false;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing them is the point
  return !/[\\\s\u0000-\u001f\u007f]/.test(v);
}

function readRef(raw: unknown): LinkedReviewItem['ref'] | undefined {
  if (!isRecord(raw)) return undefined;
  const { taskId, reviewItemId, docId, threadId } = raw;
  if (okString(taskId, MAX_ID) && okString(reviewItemId, MAX_ID)) {
    if (docId !== undefined || threadId !== undefined) return undefined;
    return { taskId, reviewItemId };
  }
  if (okString(docId, MAX_ID) && okString(threadId, MAX_ID)) {
    if (taskId !== undefined || reviewItemId !== undefined) return undefined;
    return { docId, threadId };
  }
  return undefined;
}

/** A stored or posted linked item, or nothing. */
export function readLinkedItem(raw: unknown): LinkedReviewItem | undefined {
  if (!isRecord(raw)) return undefined;
  const { workspaceId, board, headline, url } = raw;
  if (!okString(workspaceId, MAX_ID)) return undefined;
  if (!okString(board, MAX_LINKED_BOARD) || !okString(headline, MAX_LINKED_HEADLINE)) {
    return undefined;
  }
  if (!isRootRelativePath(url)) return undefined;
  const ref = readRef(raw.ref);
  if (!ref) return undefined;
  return { workspaceId, board, headline, url, ref };
}

/** A comment's `linkedItem` field, spread-ready: `{}` when there is none. */
export function readLinkedItemField(raw: unknown): { linkedItem?: LinkedReviewItem } {
  const linkedItem = readLinkedItem(raw);
  return linkedItem ? { linkedItem } : {};
}

/** The words a surface that renders only text shows for a linked item. */
export function linkedItemText(item: LinkedReviewItem, note?: string): string {
  const line = `Linked review item on ${item.board}: "${item.headline}" — ${item.url}`;
  return note && note.trim() !== '' ? `${note.trim()}\n\n${line}` : line;
}

/**
 * `listThreads`, with each comment's `linkedItem` read in.
 *
 * Kept out of `readThread` on purpose: `schema.ts` ships in the widget's
 * budgeted bundle, and this reader does not fit under its ceiling. The server
 * builds every thread payload it hands out through this, and the widget
 * reads the raw field in its own unbudgeted chunk.
 */
export function listThreadsWithLinks(doc: Y.Doc): Thread[] {
  const maps = getThreads(doc);
  return listThreads(doc).map((t) => {
    const raw = maps.get(t.id)?.get('comments') as Y.Array<Y.Map<unknown>> | undefined;
    if (!raw) return t;
    const linked = new Map<string, LinkedReviewItem>();
    for (const c of raw) {
      const item = readLinkedItem(c.get('linkedItem'));
      const id = c.get('id');
      if (item && typeof id === 'string') linked.set(id, item);
    }
    if (linked.size === 0) return t;
    return {
      ...t,
      comments: t.comments.map((c) => {
        const linkedItem = linked.get(c.id);
        return linkedItem ? { ...c, linkedItem } : c;
      }),
    };
  });
}

/**
 * Post a reply that carries a linked item: `postReply`, then the field on the
 * new comment, in one transaction so no peer sees the comment without it.
 * Kept out of `postReply` for the same reason the reader is kept out of
 * `readThread`: the widget's budgeted bundle.
 */
export function postLinkedReply(
  doc: Y.Doc,
  threadId: string,
  reply: Parameters<typeof postReply>[2] & { linkedItem: LinkedReviewItem },
): Comment | null {
  const { linkedItem, ...rest } = reply;
  let out: Comment | null = null;
  doc.transact(() => {
    out = postReply(doc, threadId, rest);
    const comments = getThreads(doc).get(threadId)?.get('comments') as
      | Y.Array<Y.Map<unknown>>
      | undefined;
    comments?.get(comments.length - 1)?.set('linkedItem', linkedItem);
  });
  const posted = out as Comment | null;
  return posted ? { ...posted, linkedItem } : null;
}
