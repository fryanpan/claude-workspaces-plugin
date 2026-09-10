/**
 * A board that loaded slowly says so, out loud, while the reader is still
 * looking at it.
 *
 * Every board POSTs one load report per page load (`board-load-report.ts`),
 * and the server has been writing them to a JSONL log since the day "the
 * board is slow on the iPad" stopped being a memory. A log nobody reads is
 * not monitoring: the 3.7x regression this module was written alongside sat
 * in that file for eleven days, fully recorded, and was found because
 * somebody complained. So the report now also RAISES — through the server's
 * Sentry client, which the sentry-claude-channel plugin turns into a message
 * an agent receives.
 *
 * Three decisions, none of them incidental:
 *
 *   - **The budget is the product promise, not a percentile.** Two seconds to
 *     the task list is what the board is supposed to do; anything above it is
 *     worth a person's attention whether or not it is typical this week. A
 *     threshold derived from recent history would have quietly ratified the
 *     regression as the new normal.
 *   - **A load that NEVER syncs is the worst case, not a missing datum.**
 *     `msToFirstProjection` is absent when the ydoc never landed before the
 *     client gave up — two of eight loads on the live board the night this
 *     was written. Treating absent as "no reading" would have made the
 *     loudest failure the silent one.
 *   - **One alarm per board per cooldown.** A slow board is slow for every
 *     tab that opens it, and a reader who reloads three times in frustration
 *     is one incident. The cooldown is what keeps this a signal rather than a
 *     way to fill somebody's inbox.
 *
 * Nothing here reads the log or the network. It is a decision over one report
 * plus a clock, which is why it can be driven directly by a test.
 */

/** What the client reported, as far as this decision is concerned. */
export interface LoadReportReading {
  /** ms from navigation to the REST first paint. */
  msToBoot?: unknown;
  /** ms to the ydoc's initial sync — the task list appearing. Absent when it
   *  never arrived before the client's fallback deadline. */
  msToFirstProjection?: unknown;
}

/**
 * How long the task list may take before a load is worth waking somebody
 * over. Bryan's number: "first list paint under two seconds".
 */
export const LIST_PAINT_BUDGET_MS = 2_000;

/** How long one board stays quiet after raising. A slow board is slow for
 *  every tab that opens it; this makes an incident one alarm. */
export const ALARM_COOLDOWN_MS = 5 * 60 * 1000;

/** Why this load was slow, or null when it was not. */
export interface SlowLoadVerdict {
  /** `never-synced` — the projection never landed. `over-budget` — it did,
   *  too late. The two want different investigations, so they are different
   *  words rather than one number over a line. */
  reason: 'never-synced' | 'over-budget';
  /** The reading that failed the budget, or null when there was none. */
  msToFirstProjection: number | null;
  budgetMs: number;
}

/**
 * Read one report against the budget.
 *
 * A report with no `msToBoot` is not judged at all: the client sends the
 * report once BOTH phases are in or at its fallback deadline, and something
 * arriving without the boot stamp is not a board load this can reason about.
 */
export function slowLoadVerdict(report: LoadReportReading): SlowLoadVerdict | null {
  if (typeof report.msToBoot !== 'number' || !Number.isFinite(report.msToBoot)) return null;
  const projection = report.msToFirstProjection;
  if (typeof projection !== 'number' || !Number.isFinite(projection)) {
    return { reason: 'never-synced', msToFirstProjection: null, budgetMs: LIST_PAINT_BUDGET_MS };
  }
  if (projection <= LIST_PAINT_BUDGET_MS) return null;
  return { reason: 'over-budget', msToFirstProjection: projection, budgetMs: LIST_PAINT_BUDGET_MS };
}

/** The one line a reader of the alert sees first. */
export function slowLoadMessage(workspaceId: string, verdict: SlowLoadVerdict): string {
  return verdict.reason === 'never-synced'
    ? `board ${workspaceId}: the task list never synced before the client gave up`
    : `board ${workspaceId}: the task list took ${verdict.msToFirstProjection}ms, over the ${verdict.budgetMs}ms budget`;
}

/**
 * The per-board cooldown, as a thing a caller holds rather than module state.
 *
 * A module-level map would be shared by every server a test starts in one
 * process, which is exactly the shape that makes a rate limiter pass alone
 * and fail in a suite.
 */
export class SlowLoadAlarm {
  private lastRaised = new Map<string, number>();

  constructor(
    /** Where a raised alarm goes. Injected so the decision can be tested
     *  without a Sentry client, and so the server can hand it whichever
     *  capture it has. */
    private readonly raise: (message: string, extra: Record<string, string>) => void,
    private readonly cooldownMs: number = ALARM_COOLDOWN_MS,
  ) {}

  /**
   * Judge one report and raise if it is slow and the board is out of
   * cooldown. Returns the verdict it acted on, or null — the return is for
   * the test and for a caller that wants to log alongside.
   */
  consider(workspaceId: string, report: LoadReportReading, now: number): SlowLoadVerdict | null {
    const verdict = slowLoadVerdict(report);
    if (!verdict) return null;
    const last = this.lastRaised.get(workspaceId);
    if (last !== undefined && now - last < this.cooldownMs) return null;
    this.lastRaised.set(workspaceId, now);
    this.raise(slowLoadMessage(workspaceId, verdict), {
      workspaceId,
      reason: verdict.reason,
      msToFirstProjection: String(verdict.msToFirstProjection ?? 'never'),
      budgetMs: String(verdict.budgetMs),
    });
    return verdict;
  }
}
