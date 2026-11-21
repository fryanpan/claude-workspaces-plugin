/**
 * The quality gate's half of a review item: whether the judge's verdict keeps
 * an item off the reader's queue, how that verdict is stored, and how its
 * reason is quoted.
 *
 * Out of `review-item.ts` because nothing else there writes a verdict, and
 * these functions read only the verdict and the two retirement facts. The
 * server's gate (`packages/server/src/review-gate.ts`) is the writer; the
 * queue, the ticket note and the stall monitor are the readers. Every name is
 * still re-exported from `review-item.ts`, which is what callers import.
 */

import { reviewAnswered, reviewWithdrawn } from './review-item-retired.ts';
import type { ReviewItemJudgement, ReviewPayload, TaskReviewItem } from './review-item-types.ts';

/** The same verdict with its hold history dropped — see `withdrawReview`. */
export function withoutHoldHistory(judgement: ReviewItemJudgement): ReviewItemJudgement {
  const { heldFor: _dropped, ...rest } = judgement;
  return rest;
}

/**
 * The judgement as it is STORED — the projected fields, picked in one place.
 *
 * Three call sites write a verdict onto a row (a ticket item, a ticket's own
 * decision, a comment-borne payload), and each used to spell the record out
 * field by field. That is three places a new field has to be remembered in,
 * and `heldFor` is exactly the kind of field whose loss is invisible: the
 * gate would simply start counting from zero again and hold forever.
 */
export function storedJudgement(judgement: ReviewItemJudgement): ReviewItemJudgement {
  return {
    at: judgement.at,
    verdict: judgement.verdict,
    reason: judgement.reason,
    ...(judgement.heldFor && judgement.heldFor.length > 0
      ? { heldFor: [...judgement.heldFor] }
      : {}),
    ...(judgement.quote !== undefined && judgement.quote !== '' ? { quote: judgement.quote } : {}),
    // How it reached the reader without passing, and the filer's reason when
    // that is why — facts about the item's history, so they are stored and
    // not re-derived.
    ...(judgement.admitted !== undefined ? { admitted: judgement.admitted } : {}),
    ...(judgement.lessSpecific !== undefined && judgement.lessSpecific !== ''
      ? { lessSpecific: judgement.lessSpecific }
      : {}),
    ...(judgement.lessSpecificFor !== undefined && judgement.lessSpecificFor !== ''
      ? { lessSpecificFor: judgement.lessSpecificFor }
      : {}),
    ...(judgement.gapKey !== undefined && judgement.gapKey !== ''
      ? { gapKey: judgement.gapKey }
      : {}),
    ...(judgement.refused !== undefined ? { refused: judgement.refused } : {}),
  };
}

/**
 * Is this item HELD by the quality gate — filed, on the ticket, but kept off
 * the reader's queue until its filer revises it?
 *
 * An answered item is never held, whatever the verdict says: the answer is
 * the fact that closes an item (`isReviewItemOpen`), and a hold on a closed
 * item would be a second opinion about words somebody has already acted on.
 *
 * A WITHDRAWN item is never held either, and for the same reason wearing the
 * other face. `reviewWithdrawn` is the twin of `reviewAnswered` — both retire
 * an item — so a rule that reads one and not the other is half a rule. The
 * half that was missing is what this predicate's callers pay for: a
 * withdrawal leaves the standing verdict in place on purpose (see
 * `withdrawReview`, which keeps it so a reinstated item is still held), so an
 * item taken back by its asker kept answering `true` here forever. It sat in
 * the stall monitor's held index with nothing left that could clear it —
 * `revise_review_item` refuses a withdrawn item, and answering it is the
 * reader's door, which a withdrawal is the act of closing. Measured on a live
 * board as `workspace.review_item_held` re-firing at the filer every few
 * minutes for hours after the withdrawal, and the same items named inside
 * every `workspace.stalled` frame.
 */
export function isReviewItemHeld(item: TaskReviewItem): boolean {
  return (
    item.answer === undefined && !reviewWithdrawn(item.review) && item.judge?.verdict === 'held'
  );
}

/**
 * The judge's reason as a CLAUSE — no trailing full stops — for the surfaces
 * that carry on the sentence after it ("… — the agent has been asked to
 * revise it").
 *
 * The judge writes a sentence, and every caller that appended to one produced
 * doubled punctuation: the ticket note read "…rather than 'see below'. — the
 * agent has been asked…" and the filer's channel line read "…'see below'..
 * It has been held for 4m" (UX review, 2026-08-29). Only full stops are
 * stripped: a reason that ends in a question mark or an ellipsis is quoted as
 * it was written.
 */
export function judgeReasonClause(reason: string): string {
  return reason.trim().replace(/\.+$/, '').trimEnd();
}

/**
 * The judge's reason as its own SENTENCE — exactly one terminal mark — for
 * the surfaces that stop after it. `?`, `!` and `…` are left alone; anything
 * else gains a full stop, so a reason and the sentence after it never run
 * together either.
 */
export function judgeReasonSentence(reason: string): string {
  const clause = judgeReasonClause(reason);
  if (clause === '') return '';
  return /[?!…]$/.test(clause) ? clause : `${clause}.`;
}

/**
 * Is this item OFF the reader's queue because of the quality gate — held,
 * or still being judged? The queue asks this one; the ticket's "Held: …"
 * note asks `isReviewItemHeld`, because there is nothing to say about an
 * item whose verdict is seconds away.
 */
export function isReviewItemGated(item: TaskReviewItem): boolean {
  if (item.answer !== undefined) return false;
  const verdict = item.judge?.verdict;
  return verdict === 'held' || verdict === 'pending';
}

/**
 * The two above, for an item that lives on a COMMENT rather than a ticket.
 *
 * Same rule, one difference: what "answered" is. A ticket item carries an
 * `answer` object on its wrapper; a comment-borne one carries the answer
 * STAMPS on the payload (`reviewAnswered`). Both say "a person has acted on
 * these words, so a second opinion about them changes nothing". Withdrawal
 * lives on the payload on BOTH surfaces, so `reviewWithdrawn` is read the
 * same way in each — see `isReviewItemHeld` for what reading only half of
 * "retired" cost.
 *
 * Separate functions rather than one over a union, because the two inputs are
 * genuinely different shapes and a caller holding a `TaskReviewItem` must not
 * be able to pass its `.review` by accident: the wrapper's `answer` would be
 * invisible here and an answered item would read as held.
 */
export function isReviewPayloadHeld(review: ReviewPayload): boolean {
  return !reviewAnswered(review) && !reviewWithdrawn(review) && review.judge?.verdict === 'held';
}

export function isReviewPayloadGated(review: ReviewPayload): boolean {
  if (reviewAnswered(review)) return false;
  const verdict = review.judge?.verdict;
  return verdict === 'held' || verdict === 'pending';
}

/**
 * Which WORDS a comment-borne item currently has — the payload twin of
 * `reviewItemVersion`, and the same guard against a verdict outliving the
 * words it judged. A revision appends to `revisions`, so the count moves on
 * exactly the edits a verdict is about.
 */
export function reviewPayloadVersion(review: ReviewPayload): number {
  return review.revisions?.length ?? 0;
}
