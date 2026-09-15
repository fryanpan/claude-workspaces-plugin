/**
 * The two measurement rows a review item causes — built here and nowhere
 * else, so "ids and timestamps only" is a property of one function rather
 * than a rule four call sites are each trusted to remember.
 *
 * `review_item.viewed` says somebody's client put the ask on screen;
 * `review_item.answered` says an answer landed on it. Same log, same clock,
 * same `reviewItemId`, so the minutes between them are a subtraction. The
 * event types themselves are documented in `tasks.ts` beside every other
 * board event.
 *
 * WHY A CONSTRUCTOR RATHER THAN OBJECT LITERALS AT THE CALL SITES. Every
 * caller has the whole item in hand: the stored review payload with its
 * headline and detail, the answer's verbatim text, the task with its title
 * and body. A literal at each site is one `...item` away from carrying all of
 * it into a row that is written far more often than any other and is read by
 * a reporting agent rather than by the board. These take primitives and
 * return a closed shape, so widening the row is an edit to this file — which
 * is the file the no-text test drives.
 */
import type { ReviewItemAnsweredEvent, ReviewItemViewedEvent } from '../tasks.ts';

/** Everything either row is allowed to know. */
export interface ReviewItemMeasurement {
  workspaceId: string;
  /** The item's universal id: minted on a ticket row, derived on a
   *  doc-thread one. One vocabulary for both surfaces. */
  reviewItemId: string;
  /** The ticket it hangs on, when it hangs on one. Absent — not empty — for
   *  an item declared on an ordinary doc's thread. */
  taskId?: string;
  /** Who. An id, never a name: a subtraction has no use for the name, and
   *  these ids derive from an email address. */
  actorId: string;
  /** Whether that person holds the board's `owner` role. Resolved by the
   *  admission gate; a request body claiming it is ignored. */
  isOwner: boolean;
  ts: number;
}

/** The one shape both rows share, spelled once. */
function row(m: ReviewItemMeasurement): Omit<ReviewItemViewedEvent, 'type'> {
  return {
    workspaceId: m.workspaceId,
    reviewItemId: m.reviewItemId,
    ...(m.taskId !== undefined && m.taskId !== '' ? { taskId: m.taskId } : {}),
    actorId: m.actorId,
    isOwner: m.isOwner,
    ts: m.ts,
  };
}

/** Somebody's client showed this item for the first time this session. */
export function reviewItemViewedEvent(m: ReviewItemMeasurement): ReviewItemViewedEvent {
  return { type: 'review_item.viewed', ...row(m) };
}

/** An answer landed on this item, wherever it was answered from. */
export function reviewItemAnsweredEvent(m: ReviewItemMeasurement): ReviewItemAnsweredEvent {
  return { type: 'review_item.answered', ...row(m) };
}

/**
 * The event names and the log, named once for the agent that reads them.
 *
 * Weekly Review is told these two strings and the file they land in; nothing
 * else about this feature is addressable from outside the server. Exported so
 * the Activity view can strip them from a feed written for people, and so a
 * test asserts the names it documents.
 */
export const REVIEW_ITEM_MEASUREMENT_EVENTS = ['review_item.viewed', 'review_item.answered'];

/** Is this the name of a measurement row rather than a board event? */
export function isReviewItemMeasurementEvent(event: unknown): boolean {
  return typeof event === 'string' && REVIEW_ITEM_MEASUREMENT_EVENTS.includes(event);
}
