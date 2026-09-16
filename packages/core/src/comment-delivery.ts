/**
 * Stamping a comment as delivered — the write behind the second tick.
 *
 * Its own file rather than a tenth function in `schema.ts` for one reason
 * that is about bytes rather than tidiness: `comment-receipt.ts` holds the
 * DECISION and the glyph and is imported by the injectable widget, which is
 * size-gated; this half imports Yjs and is only ever called by the server.
 * Keeping them apart keeps the widget's copy to the decision.
 */

import type * as Y from 'yjs';
import { getThreads } from './schema.ts';

/**
 * What a stamp attempt did. Three answers rather than a boolean because the
 * caller acts differently on each: `stamped` is the one that tells anybody,
 * `already` is the common no-op on a busy board, and `gone` is the race.
 */
export type DeliveryStamp = 'stamped' | 'already' | 'gone';

/**
 * Record that a watching session was handed this comment.
 *
 * WRITE-ONCE. A comment that is already stamped is left exactly as it is:
 * delivery is a thing that happened, the first session to be handed it is the
 * one the reader cares about, and re-stamping on every later redelivery would
 * make the mark say "the last time somebody got it", which is a different and
 * less useful sentence. It also keeps this off the hot path — a stamped
 * comment costs a read and no transaction, so the per-broadcast call on a
 * busy board writes nothing and tells nobody.
 *
 * `gone` means the thread or the comment went between the caller's read and
 * this write. That is a race, not an error the caller caused, and it costs a
 * tick rather than a comment.
 */
export function setCommentDelivered(
  doc: Y.Doc,
  threadId: string,
  commentId: string,
  at: number,
): DeliveryStamp {
  const threadMap = getThreads(doc).get(threadId);
  const comments = threadMap?.get('comments') as Y.Array<Y.Map<unknown>> | undefined;
  if (!comments) return 'gone';
  for (const c of comments) {
    if (c.get('id') !== commentId) continue;
    if (typeof c.get('deliveredAt') === 'number') return 'already';
    doc.transact(() => c.set('deliveredAt', at));
    return 'stamped';
  }
  return 'gone';
}
