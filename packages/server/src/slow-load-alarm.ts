/**
 * A page that loaded slowly says so, out loud, while the reader is still
 * looking at it.
 *
 * Every page POSTs one load report per page load, naming its page type
 * (`page-load-report.ts` in the app). Until 19 Oct 2026 only the board did,
 * and a review page that took 5-10s on a phone raised nothing. The board's
 * reports have been written to a JSONL log since the day "the board is slow
 * on the iPad" stopped being a memory. A log nobody reads is not monitoring:
 * the 3.7x regression this module was written alongside sat in that file for
 * eleven days, fully recorded, and was found because somebody complained. So
 * the report now also RAISES — through the server's Sentry client, which the
 * sentry-claude-channel plugin turns into a message an agent receives.
 *
 * Three decisions, none of them incidental:
 *
 *   - **The budget is the product promise, not a percentile.** Two seconds to
 *     a page's main content is what every page is supposed to do; anything
 *     above it is worth a person's attention whether or not it is typical
 *     this week. A threshold derived from recent history would have quietly
 *     ratified the regression as the new normal.
 *   - **A load whose content NEVER arrives is the worst case, not a missing
 *     datum.** The content stamp is absent when it never landed before the
 *     client gave up — two of eight loads on the live board the night this
 *     was written. Treating absent as "no reading" would have made the
 *     loudest failure the silent one.
 *   - **One alarm per page type per board per cooldown.** A slow page is slow
 *     for every tab that opens it, and a reader who reloads three times in
 *     frustration is one incident. The cooldown is what keeps this a signal
 *     rather than a way to fill somebody's inbox.
 *
 * Nothing here reads the log or the network. It is a decision over one report
 * plus a clock, which is why it can be driven directly by a test.
 */

/** Every page that reports its load, by the word its report names it with. */
export const PAGE_TYPES = ['board', 'home', 'review', 'doc', 'mock', 'diff', 'folder'] as const;
export type PageType = (typeof PAGE_TYPES)[number];

/** The pages on no board. They post to `/api/load-reports`; every other page
 *  posts to its board's own route. */
export const BOARDLESS_PAGES: readonly PageType[] = ['home', 'review'];

/** What "main content" is on each page, in the alarm's words. */
const CONTENT_WORD: Record<PageType, string> = {
  board: 'task list',
  home: 'workspace list',
  review: 'first review item',
  doc: 'doc text',
  mock: 'mock',
  diff: 'diff',
  folder: 'file',
};

/**
 * The page type a report names, or null when it names one this server does
 * not know. A report naming none is the board's: every board client from
 * before page types sent exactly that, and some of those tabs are still open.
 */
export function pageTypeOf(raw: unknown): PageType | null {
  if (raw === undefined) return 'board';
  return (PAGE_TYPES as readonly unknown[]).includes(raw) ? (raw as PageType) : null;
}

/** What the client reported, as far as this decision is concerned. */
export interface LoadReportReading {
  /** Which page loaded. Absent on the board's older reports. */
  page?: unknown;
  /** ms from navigation to the page's own first paint. */
  msToBoot?: unknown;
  /** ms to the page's main content on screen. Absent when it never arrived
   *  before the client's fallback deadline. */
  msToContent?: unknown;
  /** The board's name for the same stamp, from before page types: the
   *  ydoc's task projection. */
  msToFirstProjection?: unknown;
}

/**
 * How long a page's main content may take before a load is worth waking
 * somebody over. Bryan's number: "first list paint under two seconds", now
 * held by every page.
 */
export const PAGE_LOAD_BUDGET_MS = 2_000;

/** How long one page type on one board stays quiet after raising. */
export const ALARM_COOLDOWN_MS = 5 * 60 * 1000;

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** The page type a report is for, and the ms to its content (null: never arrived). */
export interface ContentReading {
  page: PageType;
  msToContent: number | null;
}

/**
 * The one reading a report is judged on, or null when the report is not one
 * this can reason about.
 *
 * A report with no `msToBoot` is not judged at all: the client sends the
 * report once its content is in or at its fallback deadline, and something
 * arriving without the boot stamp is not a page load. A report naming an
 * unknown page type is not judged either, so a typo cannot page anybody.
 */
export function contentReading(report: LoadReportReading): ContentReading | null {
  const page = pageTypeOf(report.page);
  if (!page || !finite(report.msToBoot)) return null;
  if (finite(report.msToContent)) return { page, msToContent: report.msToContent };
  // The board's older clients send the same stamp under its phase's name.
  if (page === 'board' && finite(report.msToFirstProjection)) {
    return { page, msToContent: report.msToFirstProjection };
  }
  return { page, msToContent: null };
}

/** Why this load was slow, or null when it was not. */
export interface SlowLoadVerdict {
  page: PageType;
  /** `never-arrived` — the content never landed. `over-budget` — it did,
   *  too late. The two want different investigations, so they are different
   *  words rather than one number over a line. */
  reason: 'never-arrived' | 'over-budget';
  /** The reading that failed the budget, or null when there was none. */
  msToContent: number | null;
  budgetMs: number;
}

/** Read one report against the budget. */
export function slowLoadVerdict(report: LoadReportReading): SlowLoadVerdict | null {
  const reading = contentReading(report);
  if (!reading) return null;
  const { page, msToContent } = reading;
  if (msToContent === null) {
    return { page, reason: 'never-arrived', msToContent: null, budgetMs: PAGE_LOAD_BUDGET_MS };
  }
  if (msToContent <= PAGE_LOAD_BUDGET_MS) return null;
  return { page, reason: 'over-budget', msToContent, budgetMs: PAGE_LOAD_BUDGET_MS };
}

/** The one line a reader of the alert sees first. It leads with the page
 *  type, because that decides where to look. */
export function slowLoadMessage(workspaceId: string | null, verdict: SlowLoadVerdict): string {
  const where = workspaceId
    ? `${verdict.page} page on board ${workspaceId}`
    : `${verdict.page} page`;
  const what = CONTENT_WORD[verdict.page];
  return verdict.reason === 'never-arrived'
    ? `${where}: the ${what} never arrived before the client gave up`
    : `${where}: the ${what} took ${verdict.msToContent}ms, over the ${verdict.budgetMs}ms budget`;
}

/**
 * The cooldown, keyed by page type and board, as a thing a caller holds
 * rather than module state.
 *
 * A module-level map would be shared by every server a test starts in one
 * process, which is exactly the shape that makes a rate limiter pass alone
 * and fail in a suite. The key holds the page type so a slow review page
 * never silences a slow board, and the board so one slow board never
 * silences another.
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
   * Judge one report and raise if it is slow and its page type on its board
   * is out of cooldown. `workspaceId` is null for a page on no board. Returns
   * the verdict it acted on, or null — the return is for the test and for a
   * caller that wants to log alongside.
   */
  consider(
    workspaceId: string | null,
    report: LoadReportReading,
    now: number,
  ): SlowLoadVerdict | null {
    const verdict = slowLoadVerdict(report);
    if (!verdict) return null;
    const key = `${verdict.page} ${workspaceId ?? ''}`;
    const last = this.lastRaised.get(key);
    if (last !== undefined && now - last < this.cooldownMs) return null;
    this.lastRaised.set(key, now);
    this.raise(slowLoadMessage(workspaceId, verdict), {
      page: verdict.page,
      ...(workspaceId ? { workspaceId } : {}),
      reason: verdict.reason,
      msToContent: String(verdict.msToContent ?? 'never'),
      budgetMs: String(verdict.budgetMs),
    });
    return verdict;
  }
}
