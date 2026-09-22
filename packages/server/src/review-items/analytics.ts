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
import type { StoredReviewItem } from '@claude-workspaces/core/task-wire';
import type { ReviewItemAnsweredEvent, ReviewItemViewedEvent } from '../tasks.ts';
import { LEGACY_REVIEW_ITEM_ID } from './derive.ts';

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
  /**
   * The agent that FILED the item, on the `answered` row only.
   *
   * It does not widen the contract above: it is an id, the row already
   * carries two, and no words come with it. It is here because the answer is
   * what the filing agent stopped for, and the MCP child addresses the wake
   * at that agent rather than broadcasting it — see `ReviewItemAnsweredEvent`.
   * `viewed` does not take it: that row is written far more often and nobody
   * addresses anything off it.
   */
  filedById?: string;
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
  return {
    type: 'review_item.answered',
    ...row(m),
    ...(m.filedById !== undefined && m.filedById !== '' ? { filedById: m.filedById } : {}),
  };
}

/**
 * The agent that filed one review item on a ticket, or `undefined` when the
 * store never recorded one.
 *
 * Read off the RAW row, because `filedBy` is store-only by the §3.3 visitor
 * contract and `readTaskReviewItem` drops it — the same read
 * `review-items/queries.ts` does to address a quality-gate hold. The legacy
 * `r-legacy` row is the ticket's own decision and keeps its filer on the task
 * instead, as `decisionFiledBy`.
 */
export function reviewItemFilerId(
  task: { reviews?: readonly StoredReviewItem[]; decisionFiledBy?: { id?: string } } | undefined,
  reviewItemId: string,
): string | undefined {
  if (!task) return undefined;
  if (reviewItemId === LEGACY_REVIEW_ITEM_ID) return task.decisionFiledBy?.id;
  return task.reviews?.find((r) => r.id === reviewItemId)?.filedBy?.id;
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

/**
 * The events that only the measurement log reads, so the server keeps them
 * off the SSE fan-out.
 *
 * `review_item.viewed` says a person opened a card. No task changes, no
 * status changes, and no surface reads the frame — the board writes the
 * beacon and never listens for it. An agent that got the frame would spend a
 * turn to learn that somebody looked at its ask. Bryan asked for the rule on
 * 2026-09-17: an event that exists for analytics does not go to a listening
 * agent.
 *
 * `review_item.answered` is NOT on this list, although the same file builds
 * it. An answer is the thing an agent waits for, and the wake is the point.
 * The test for this list is "who acts on it", not "which file wrote it".
 *
 * The audit log is unaffected. `TaskEventBus.emit` appends the row before it
 * calls any listener, so Weekly Review reads the same `events.jsonl` it read
 * before.
 */
export const ANALYTICS_ONLY_EVENTS = ['review_item.viewed'];

/** Does this event exist for measurement alone? */
export function isAnalyticsOnlyEvent(event: unknown): boolean {
  return typeof event === 'string' && ANALYTICS_ONLY_EVENTS.includes(event);
}
