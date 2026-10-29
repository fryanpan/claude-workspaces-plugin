/**
 * The two kinds of ask only the board's owner may answer, beyond the ones a
 * filer marks `ownerOnly` itself (Bryan, 29 Oct).
 *
 * - A STEP the board names in `requireOwnerFor` — `push`, `jira`, `send`. An
 *   item whose `review.step` is one of them is filed owner-only whatever its
 *   filer sent, so an agent cannot ask a member to approve a push the owner
 *   reserved.
 * - An ACCESS change: who may be in the board. Its words are derived from the
 *   change (`accessChangeLine`), it is always owner-only, and its two options
 *   are what the access door reads.
 */
import { type ReviewAccessChange, accessChangeLine } from '@claude-workspaces/core/review-access';

export const ACCESS_APPROVE = 'o-approve';
export const ACCESS_REJECT = 'o-reject';

/** `review` with `ownerOnly: true` when its step is one the board reserves. */
export function ownerOnlyForStep(review: unknown, steps: readonly string[]): unknown {
  if (steps.length === 0 || typeof review !== 'object' || review === null) return review;
  const step = (review as { step?: unknown }).step;
  if (typeof step !== 'string' || !steps.includes(step)) return review;
  return { ...review, ownerOnly: true };
}

/** The decision an access item asks, built from the change alone. */
export function accessReviewPayload(change: ReviewAccessChange, why: string): unknown {
  return {
    shape: 'decision',
    headline: accessChangeLine(change),
    detail: why,
    options: [
      { id: ACCESS_APPROVE, label: 'Approve', detail: 'Applies the change now' },
      { id: ACCESS_REJECT, label: 'Reject', detail: 'Nothing changes, and the agent is told' },
    ],
    ownerOnly: true,
  };
}

/**
 * Parse the steps an owner sent for `requireOwnerFor`. Undefined for a value
 * that is not a list of step names, so the route can refuse it whole.
 */
export function readOwnerSteps(raw: unknown): string[] | undefined {
  if (raw === null) return [];
  if (!Array.isArray(raw) || raw.length > 20) return undefined;
  const out: string[] = [];
  for (const s of raw) {
    if (typeof s !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(s)) return undefined;
    out.push(s);
  }
  return out;
}
