/**
 * Has this item been retired, and by whom: answered by a person, or taken back
 * by its asker. The two facts every other review-item rule reads.
 *
 * A leaf on purpose. The quality gate (`review-item-gate.ts`) and the payload
 * lifecycle (`review-item.ts`) both ask these, and the lifecycle also calls
 * the gate, so the predicates sit below both rather than inside either.
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
