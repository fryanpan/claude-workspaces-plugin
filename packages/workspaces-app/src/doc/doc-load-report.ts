/**
 * The doc page's load report: one per page load, for whichever document the
 * page opened first.
 *
 * One bundle serves three page types. A diff member is a `diff` page; a file
 * of a bound folder — any member of an attachment set that is not a diff
 * file — is a `folder` page; everything else is a `doc` page. Which one is
 * known only once the doc's meta has arrived, so the report starts as `doc`
 * and is renamed at the first mount.
 *
 * The content stamp is the first mount's surface having mounted AND its
 * ydoc having synced, on the next frame: a diff's base text is fetched inside
 * the mount, and the text of every surface arrives with the sync. A
 * navigation inside the page before that hands the report to the next mount,
 * so a reader who clicks on in the sidebar does not file a load that never
 * arrived.
 */
import type { MountContext } from '../mount-context.ts';
import { type PageType, startPageLoadReport } from '../page-load-report.ts';
import { pageSentry } from '../sentry-page.ts';

/** Which page type a mounted document is. */
export function docPageType(ctx: Pick<MountContext, 'docType' | 'workspaceId'>): PageType {
  if (ctx.docType === 'diff') return 'diff';
  return ctx.workspaceId ? 'folder' : 'doc';
}

/**
 * Start the report for a page on `boardId`. Returns what to call after each
 * mount; it does nothing once the report is sent. A page on no board sends
 * nothing — every doc address is under its board, so that is not a page this
 * bundle serves.
 */
export function startDocLoadReport(boardId: string | null): (ctx: MountContext) => void {
  if (!boardId) return () => {};
  let pending: ReturnType<typeof startPageLoadReport> | null = startPageLoadReport({
    page: 'doc',
    workspaceId: boardId,
    sentry: pageSentry(),
  });
  return (ctx) => {
    const report = pending;
    if (!report || ctx.scope.disposed) return;
    report.setPage(docPageType(ctx));
    ctx.client.onReady(() => {
      if (ctx.scope.disposed || pending !== report) return;
      pending = null;
      report.contentShown();
    });
  };
}
