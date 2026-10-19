/**
 * One load report per page load, from every page: how long the page took to
 * show its main content, and which page it was.
 *
 * The board reported its load from the day "the board is slow on the iPad"
 * stopped being a memory; nothing else did, so a review page that took 5-10s
 * on a phone (19 Oct 2026) raised nothing. Each page now measures the moment
 * its own main content is on screen — the board's task list, Home's workspace
 * list, the review page's first item, a doc's text, a mock's frame, a diff, a
 * folder's file — and the server judges every one against the same two
 * seconds (`server/src/slow-load-alarm.ts`).
 *
 * Both stamps are ms from navigation start (`performance.now()`'s zero), so
 * they compare across pages and across loads. `msToBoot` is when the page's
 * own script started; `msToContent` is the content, and is ABSENT, never zero,
 * when it had not arrived by the deadline — that load is the one most worth
 * recording.
 *
 * Where it posts: a page on a board posts to that board's
 * `/workspaces/<ws>/load-reports`, which a share member of the board may
 * reach; Home and the review page are on no board and post to
 * `/api/load-reports`. The mock's host page reports from the widget bundle,
 * which cannot import this module, with the same shape (`mock-host.ts`).
 */
import { asBackgroundWrite } from './signin/write-gate.ts';

export type PageType = 'board' | 'home' | 'review' | 'doc' | 'mock' | 'diff' | 'folder';

/** The pageload trace to stamp alongside the POST, or null when the SDK
 *  never loaded — `pageSentry()`'s answer. */
export interface LoadTrace {
  setMeasurement(name: string, value: number, unit: string): void;
}

export interface PageLoadReportInput {
  page: PageType;
  /** The board the page is on, or null for Home and the review page. */
  workspaceId: string | null;
  msToBoot: number;
  /** null when the content never arrived before the deadline. */
  msToContent: number | null;
  /** Page-specific numbers that ride along, flat. */
  fields?: Record<string, number>;
  sentry?: LoadTrace | null;
}

/** Where a report goes: its board's route, or the one for pages on no board. */
export function loadReportUrl(workspaceId: string | null): string {
  return workspaceId
    ? `/workspaces/${encodeURIComponent(workspaceId)}/load-reports`
    : '/api/load-reports';
}

/**
 * POST the report, and stamp the content time on the pageload trace.
 *
 * Fire-and-forget by construction: a recorder must never break the page it
 * measures, so the fetch swallows its own failure and the trace write is
 * wrapped.
 */
export function postPageLoadReport(input: PageLoadReportInput): void {
  const { page, workspaceId, msToBoot, msToContent, fields, sentry } = input;
  // What the network actually moved: "slow because big" and "slow because
  // far" need different fixes, and the report should tell them apart.
  const resources = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
  // Nobody asked for this POST — it is telemetry about the load that just
  // happened. Marked, so that a signed-out reader gets the standing bar
  // rather than a modal demanding they sign in to do something they never
  // did. Measured on the board: unmarked, it raised the modal within four
  // seconds of opening it.
  asBackgroundWrite(() => {
    void fetch(loadReportUrl(workspaceId), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        page,
        msToBoot,
        ...(msToContent !== null ? { msToContent } : {}),
        ...fields,
        resourceCount: resources.length,
        transferBytes: resources.reduce((sum, r) => sum + (r.transferSize || 0), 0),
        decodedBytes: resources.reduce((sum, r) => sum + (r.decodedBodySize || 0), 0),
      }),
    }).catch(() => {});
  });
  try {
    sentry?.setMeasurement('ms_to_boot', msToBoot, 'millisecond');
    if (msToContent !== null) sentry?.setMeasurement('ms_to_content', msToContent, 'millisecond');
  } catch {
    // The recorder never breaks the page it measures.
  }
}

/** How long a page waits for its content before reporting that it never came.
 *  The board's own deadline, so every page's "never arrived" means the same. */
export const PAGE_LOAD_DEADLINE_MS = 15_000;

export interface PageLoadClock {
  /** Name the page once it is known — a doc page learns it is a diff or a
   *  folder only when its meta arrives. */
  setPage(page: PageType): void;
  /** The main content has been put in the DOM. Stamped on the next frame, so
   *  the number is when it was painted rather than when it was written. */
  contentShown(): void;
}

/**
 * Start the one report this page load sends: `msToBoot` is now, the content
 * stamp is the first `contentShown()`, and the report goes once — at the
 * content, or at the deadline without it.
 */
export function startPageLoadReport(opts: {
  page: PageType;
  workspaceId: string | null;
  sentry?: LoadTrace | null;
  deadlineMs?: number;
}): PageLoadClock {
  let page = opts.page;
  const msToBoot = Math.round(performance.now());
  let sent = false;
  const send = (msToContent: number | null): void => {
    if (sent) return;
    sent = true;
    clearTimeout(deadline);
    postPageLoadReport({
      page,
      workspaceId: opts.workspaceId,
      msToBoot,
      msToContent,
      sentry: opts.sentry ?? null,
    });
  };
  const deadline = setTimeout(() => send(null), opts.deadlineMs ?? PAGE_LOAD_DEADLINE_MS);
  return {
    setPage(next) {
      page = next;
    },
    contentShown() {
      if (sent) return;
      // A tab opened in the background paints no frame until it is shown, and
      // waiting for one would report the reader's delay as the page's.
      if (document.visibilityState === 'hidden') send(Math.round(performance.now()));
      else requestAnimationFrame(() => send(Math.round(performance.now())));
    },
  };
}
