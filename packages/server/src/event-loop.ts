/**
 * Keeping the one thread that runs JavaScript answerable.
 *
 * This server is single-threaded. A handler that runs to completion without
 * awaiting holds every other request behind it, including the supervisor's
 * health probe, and the supervisor's answer to an unanswered probe is to
 * restart the process. So an unyielded pass is not a slow route: it is an
 * outage plus a restart.
 *
 * On 2026-09-16 prod stopped answering :8787 twice. The evidence that it was
 * the loop and not the handlers is that the requests which returned late did
 * no work at all: `GET /events/d-…` took 56,016 ms and returned **404**; eight
 * `GET /api/calendar/events` took 12,973–14,427 ms and returned **403**; eight
 * `GET /events/*` took 14,763–14,934 ms and returned **401**, all landing
 * within 171 ms of each other. A 401 cannot take fourteen seconds to compute.
 * Those requests sat in the accept queue while nothing ran them, and they came
 * out together when the loop was handed back — a drained queue, not slow code.
 *
 * The first episode's blocker is named: health checks failed at 14:49:52,
 * 14:50:22, 14:50:53 and 14:51:22, and immediately after the fourth,
 * `POST …/suggestions/resolve_all` logged **114,650 ms**. The next request took
 * 553 ms. The server recovered the instant that handler returned.
 *
 * {@link timeSlice} is what a long pass uses to stay answerable, so the next
 * unbounded loop has a house pattern to reach for instead of inventing one.
 */

/**
 * A budget that says when a long synchronous pass should hand the loop back.
 *
 * Yielding after every item is the obvious shape and the wrong one: it turns a
 * ten-item pass into ten macrotasks for no benefit, and on a big pass the
 * yields cost more than the work. Yielding on ELAPSED TIME instead means a
 * small pass never yields at all — so nothing about its behaviour changes —
 * while a large one is chopped into slices no longer than the budget, whatever
 * the per-item cost turns out to be.
 *
 * That last part is what makes it right for `resolveAllSuggestions`, whose
 * per-item cost is not constant: every resolution re-scans the whole prose
 * fragment, so the same loop is microseconds per item on a small doc and
 * hundreds of milliseconds per item on a large one. A count-based yield tuned
 * for one of those is wrong for the other; a time-based one needs no tuning.
 */
export interface TimeSlice {
  /**
   * Hand the loop back if this slice has run longer than its budget.
   *
   * Always `await` it; it resolves immediately when the budget is intact, so
   * the caller pays one already-resolved promise per item and nothing else.
   */
  yieldIfDue(): Promise<void>;
  /** How many times this slice has actually yielded. For tests and reports. */
  yields(): number;
}

/**
 * The default slice: long enough that a small pass never yields, short enough
 * that a health probe waits well under the supervisor's patience even when a
 * pass runs for minutes.
 */
export const SLICE_BUDGET_MS = 50;

export function timeSlice(
  budgetMs: number = SLICE_BUDGET_MS,
  now: () => number = () => performance.now(),
): TimeSlice {
  let startedAt = now();
  let count = 0;
  return {
    async yieldIfDue(): Promise<void> {
      if (now() - startedAt < budgetMs) return;
      count++;
      // `setImmediate`, not `queueMicrotask` or an awaited resolved promise.
      // A microtask runs before the loop takes any new I/O, so draining a
      // microtask queue is still one turn as far as an unanswered request is
      // concerned — it would satisfy the shape of this code and fix nothing.
      // Only a macrotask lets the socket the probe is waiting on be read, and
      // `setImmediate` fires after the poll phase, so I/O that arrived during
      // the slice is handled before the next slice starts rather than after
      // it. `meeting-titler.ts` already yields this way between doc hydrates;
      // this is that pattern with a budget in front of it.
      await new Promise<void>((resolve) => setImmediate(resolve));
      startedAt = now();
    },
    yields(): number {
      return count;
    },
  };
}
