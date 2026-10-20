/**
 * The board's load report: how long the board took to appear, and how long
 * its data took to arrive.
 *
 * Its two numbers mean nothing apart. `msToBoot` is the REST first paint;
 * `msToFirstProjection` is when the ydoc's task projection was on screen —
 * the payload that spent those ten seconds on the iPad — and never before the
 * first paint, since a sync that lands first is only visible once that paint
 * draws it. The projection is the board's main content, so it is also the
 * report's `msToContent`, which is what the server judges for every page type
 * (`page-load-report.ts`); it keeps its own name too, so the board's log
 * still reads by phase.
 *
 * `bootBoard` keeps the two stamps and the sent-once guard, because WHEN each
 * phase ends is a fact about the boot sequence. What is here is what a report
 * contains.
 */
import { postPageLoadReport } from '../page-load-report.ts';

/** The one report, as `bootBoard` has it at send time. */
export interface LoadReportInput {
  workspaceId: string;
  /** ms from navigation start to the boot render. */
  msToBoot: number;
  /** ms to the ydoc's initial sync, or null when it never arrived — the
   *  fallback deadline reports boot-only rather than nothing, because that
   *  slow load is the one most worth recording. */
  msToFirstProjection: number | null;
}

/** POST the board's report. */
export function postLoadReport(input: LoadReportInput): void {
  const { workspaceId, msToBoot, msToFirstProjection } = input;
  postPageLoadReport({
    page: 'board',
    workspaceId,
    msToBoot,
    msToContent: msToFirstProjection,
    ...(msToFirstProjection !== null ? { fields: { msToFirstProjection } } : {}),
  });
}
