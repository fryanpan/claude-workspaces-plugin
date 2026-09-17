/**
 * Keeping the one thread that runs JavaScript answerable — and saying so when
 * it was not.
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
 * That one is fixed at its source (`DocEditOps.resolveAllSuggestions` now
 * yields). This module exists because finding it cost a day of reading a log
 * that never said "blocked" — the only trace a wedge leaves today is that some
 * 404 took a minute, and you have to already suspect it to notice. Two pieces:
 *
 *   - {@link LoopLagMonitor} watches for the gap a blocked turn leaves in its
 *     own schedule, and reports it with whatever was in flight at the time.
 *   - {@link timeSlice} is what a long pass uses to stay answerable, so the
 *     next unbounded loop has a house pattern to reach for instead of
 *     inventing one.
 *
 * **The monitor answers a question the log could not.** A stall where a request
 * was in flight is a synchronous pass in that handler. A stall where NOTHING
 * was in flight is a timer callback, a garbage collection, or the OS
 * descheduling a process on a swapping machine — a different fault with a
 * different fix. Those two are indistinguishable in today's log, and the line
 * this module writes separates them.
 */

/** A request the front door has admitted and not yet answered. */
export interface InflightRequest {
  method: string;
  /** Pathname only. The query can carry a person's name, and this line is for
   *  reading durations — the same rule the `[timing]` line already follows. */
  path: string;
  /** `performance.now()` when the front door admitted it. */
  startedAt: number;
}

/**
 * The requests the front door has admitted and not yet answered.
 *
 * Deliberately a `Set` of the entry objects rather than a map keyed by id:
 * `enter` returns the function that removes this exact entry, so a leak needs
 * the caller to drop the closure rather than to compute a key wrongly. Both
 * operations are O(1), which matters because this runs on every request and
 * the whole module is about not adding cost to the hot path.
 *
 * Nothing here holds the `Request`. A pathname and two strings are what the
 * report can print; keeping the request alive would pin its body and headers
 * for as long as the entry lived, which on a wedged server is the whole
 * outage.
 */
export class InflightRegistry {
  private readonly live = new Set<InflightRequest>();
  private readonly now: () => number;

  constructor(now: () => number = () => performance.now()) {
    this.now = now;
  }

  /** Record a request; the returned function retires it. Call it once. */
  enter(req: { method: string; url: string }): () => void {
    let path: string;
    try {
      path = new URL(req.url).pathname;
    } catch {
      // A URL the front door will reject anyway. Never throw from the
      // instrument — an observer that can fail a request is worse than blind.
      path = '<unparsable>';
    }
    const entry: InflightRequest = { method: req.method, path, startedAt: this.now() };
    this.live.add(entry);
    return () => {
      this.live.delete(entry);
    };
  }

  /** What is in flight right now, in no particular order. */
  snapshot(): InflightRequest[] {
    return [...this.live];
  }

  size(): number {
    return this.live.size;
  }
}

/**
 * How often the monitor wakes.
 *
 * It has to be well under the supervisor's 10 s patience for the report to
 * land while the incident is still legible, and its cost is one `now()` and a
 * comparison, so the frequency is nearly free.
 */
export const LOOP_TICK_MS = 250;

/**
 * How long a turn must block before it is worth a line.
 *
 * Under LOOP_TICK_MS this would report ordinary scheduling jitter forever. A
 * second is far above anything a healthy turn does here and far below the
 * supervisor's patience, so every report is an event somebody would want to
 * know about and none of them is noise.
 */
export const LOOP_BLOCK_THRESHOLD_MS = 1_000;

export interface LoopLagMonitorOptions {
  periodMs?: number;
  thresholdMs?: number;
  /** Monotonic clock. Injected so a test drives it without real time. */
  now?: () => number;
  /** Where a report goes. Defaults to the same stream every other server line
   *  uses, so an incident reads in one file. */
  log?: (line: string) => void;
  /** Wall-clock stamp for the line. The server's own log lines carry no
   *  timestamp — only the supervisor's do — which is exactly what made the
   *  16 September episodes hard to place against the health checks. */
  stamp?: () => string;
  /** What the front door was holding when the loop came back. */
  inflight?: () => InflightRequest[];
}

/** How many in-flight requests a report names before it summarises the rest. */
const NAMED_INFLIGHT = 3;

/**
 * Watches for the gap a blocked turn leaves in its own schedule.
 *
 * A timer that asked to run every 250 ms and ran 14 seconds late did not
 * oversleep — nothing else could run either, because there is only one thread.
 * So the lateness of this timer IS the length of the block, measured without
 * instrumenting a single handler.
 */
export class LoopLagMonitor {
  private readonly periodMs: number;
  private readonly thresholdMs: number;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly stamp: () => string;
  private readonly inflight: () => InflightRequest[];
  private timer: ReturnType<typeof setInterval> | undefined;
  /** When the next tick was due. A tick that arrives after this was blocked. */
  private dueAt: number;
  /** Reports written since boot, so a test can assert the quiet case cheaply. */
  private reported = 0;

  constructor(opts: LoopLagMonitorOptions = {}) {
    this.periodMs = opts.periodMs ?? LOOP_TICK_MS;
    this.thresholdMs = opts.thresholdMs ?? LOOP_BLOCK_THRESHOLD_MS;
    this.now = opts.now ?? (() => performance.now());
    this.log = opts.log ?? ((line) => console.error(line));
    this.stamp = opts.stamp ?? (() => new Date().toISOString());
    this.inflight = opts.inflight ?? (() => []);
    this.dueAt = this.now() + this.periodMs;
  }

  /**
   * One wake-up. Public so a test drives the judgement directly rather than
   * waiting on real timers — the block it is judging is measured in seconds,
   * and a suite must never pay that.
   *
   * Returns how long the turn was blocked, which is 0 for a tick that arrived
   * on time or early.
   */
  tick(): number {
    const at = this.now();
    const blockedMs = at - this.dueAt;
    this.dueAt = at + this.periodMs;
    if (blockedMs < this.thresholdMs) return blockedMs > 0 ? blockedMs : 0;
    this.reported++;
    this.log(this.lineFor(blockedMs, at));
    return blockedMs;
  }

  /** Reports written since boot. */
  reportCount(): number {
    return this.reported;
  }

  /**
   * Arm the real timer.
   *
   * `unref` because a monitor must never be the reason the process stays
   * alive: a server that has finished its work should exit, and an observer
   * that prevented it would be a bug of its own making.
   */
  start(): void {
    if (this.timer) return;
    this.dueAt = this.now() + this.periodMs;
    const timer = setInterval(() => this.tick(), this.periodMs);
    (timer as unknown as { unref?: () => void }).unref?.();
    this.timer = timer;
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * The report.
   *
   * Naming the in-flight requests is the whole value: a stall with a request
   * in flight points at that handler, and a stall with none points away from
   * every handler at once. The empty case therefore gets a sentence rather
   * than an empty list, because "nothing in flight" is a FINDING and reads as
   * missing data otherwise.
   */
  private lineFor(blockedMs: number, at: number): string {
    const held = this.inflight();
    const head = `${this.stamp()} [loop] blocked ${Math.round(blockedMs)}ms`;
    if (held.length === 0) {
      return `${head} — nothing in flight; a timer, a GC, or the OS descheduling this process`;
    }
    const oldestFirst = [...held].sort((a, b) => a.startedAt - b.startedAt);
    const named = oldestFirst
      .slice(0, NAMED_INFLIGHT)
      .map((r) => `${r.method} ${r.path} (${Math.round(at - r.startedAt)}ms)`)
      .join(', ');
    const rest = oldestFirst.length - NAMED_INFLIGHT;
    const more = rest > 0 ? `, +${rest} more` : '';
    return `${head} — in flight: ${named}${more}`;
  }
}

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
