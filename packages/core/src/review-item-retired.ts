/**
 * Has this item been retired, and by whom: answered by a person, or taken back
 * by its asker. The two facts every other review-item rule reads, and
 * `pendingDeclaration`, the same two facts asked of a whole thread.
 *
 * A leaf on purpose. The quality gate (`review-item-gate.ts`) and the payload
 * lifecycle (`review-item.ts`) both ask these, and the lifecycle also calls
 * the gate, so the predicates sit below both rather than inside either. The
 * widget's dock reads only this module and the gate, so it never bundles the
 * lifecycle.
 */

import type { ReviewPayload } from './review-item-types.ts';

/**
 * Has a person answered this item?
 *
 * One predicate, because the queue, the card and any future surface must not
 * each decide it — and because the two stamps mean the same thing arriving by
 * two routes: `answeredAt` on every answer since it existed, `answeredWith`
 * alone on an option tapped before it did.
 */
export function reviewAnswered(review: ReviewPayload): boolean {
  return review.answeredAt !== undefined || review.answeredWith !== undefined;
}

/**
 * Has the ASKER taken this item back?
 *
 * The counterpart to `reviewAnswered`, and separate from it on purpose: both
 * retire an item, and which one happened is exactly what the reader needs to
 * see. An answered item records a decision; a withdrawn one records that no
 * decision was ever needed. Collapsing them into one "closed" flag would make
 * the queue's history unable to tell "you settled this" from "we retracted
 * this", which is the difference between work done and work undone.
 */
export function reviewWithdrawn(review: ReviewPayload): boolean {
  return review.withdrawnAt !== undefined;
}

/**
 * The declaration on this thread that nobody has answered, or null.
 *
 * ONE rule, read by every surface. The server's queue (review-queue.ts) and
 * the doc panel's reply box (threads.ts) each need to answer "which item is
 * pending on this thread", and for one release they answered it differently —
 * the doc panel scanned raw array order, skipped answered declarations to
 * find buried ones, and ignored thread status, so it could render a full
 * Answer composer for an item Home had already retired. Answering it stamped
 * a comment no queue was offering. Both halves import this now; a second
 * copy of the rule is how they drift again.
 *
 * The rule itself, unchanged from the server's:
 *
 * - The NEWEST declaration decides, and only it. An agent that asks again
 *   has moved on from what it asked before, so an older unanswered payload
 *   buried under a newer answered one is history rather than a live question.
 * - By time, not by array position. Comment order in a Yjs array is a CRDT's
 *   merge order, not a clock — "the last element" answers a question about
 *   array layout, not about who spoke last.
 * - A withdrawn declaration is stepped over, not stopped at. The newest ask
 *   decides only while it stands; one the asker took back has no claim on the
 *   thread, so the search continues underneath it.
 * - A non-open thread has nothing pending: an authored ask is retired by an
 *   ANSWER (`reviewAnswered`), by its ASKER withdrawing it
 *   (`reviewWithdrawn`), or by its thread being resolved, and by nothing
 *   else.
 *
 * `null` means "nothing here to answer" — an ordinary thread, a retired one,
 * or one whose newest ask is settled — and the caller posts a plain comment.
 * That is the honest fallback rather than a default target: inventing one
 * would let a remark stamp an answer nobody gave.
 *
 * Generic over the comment shape (rather than importing `Comment`) so this
 * module stays pure and dependency-free — the MCP tool, the REST route and
 * the browser all check the same rule.
 */
export function pendingDeclaration<C extends { ts: number; review?: ReviewPayload }>(thread: {
  status: string;
  comments?: ReadonlyArray<C>;
}): C | null {
  if (thread.status !== 'open') return null;
  const byTime = [...(thread.comments ?? [])].sort((a, b) => a.ts - b.ts);
  for (let i = byTime.length - 1; i >= 0; i -= 1) {
    const c = byTime[i];
    if (c?.review === undefined) continue;
    // A withdrawn ask supersedes nothing — it was taken back, so the thread
    // falls through to whatever it was asking before. This is the only way an
    // older ask can come back into view, and it is deliberate: it is what
    // lets an agent that filed a correction as a SECOND item on the thread
    // clean up after itself, withdrawing the stale one and leaving the live
    // one answerable, without resolving the thread they share.
    if (reviewWithdrawn(c.review)) continue;
    return reviewAnswered(c.review) ? null : c;
  }
  return null;
}
