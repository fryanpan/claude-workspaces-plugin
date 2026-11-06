/**
 * The doc page's load report: one per page load, for whichever document the
 * page opened first, and one for each file switch inside an open diff after
 * that.
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
 *
 * A file switch is an in-place swap (`router.ts`), so nothing about it reaches
 * the page load report. Each one is timed from the click to the same stamp: its
 * mount done AND its ydoc synced, on the next frame. A diff mounts only after
 * its first sync and first diff (`code-app.ts`), so the main thread's time is
 * inside the number. A redline finishes after its mount, so it hands over
 * `ctx.contentDrawn` and the stamp waits for that too.
 */
import type { MountContext } from '../mount-context.ts';
import {
  type FileSwitchClock,
  type PageType,
  startFileSwitchReport,
  startPageLoadReport,
} from '../page-load-report.ts';

/** Which page type a mounted document is. */
export function docPageType(ctx: Pick<MountContext, 'docType' | 'workspaceId'>): PageType {
  if (ctx.docType === 'diff') return 'diff';
  return ctx.workspaceId ? 'folder' : 'doc';
}

export interface DocLoadReport {
  /** A document's surface has mounted. */
  mounted(ctx: MountContext): void;
  /** The reader asked for another document. */
  navigated(): void;
}

/**
 * Start the report for a page on `boardId`. A page on no board sends nothing:
 * every doc address is under its board, so that is not a page this bundle
 * serves.
 */
export function startDocLoadReport(boardId: string | null): DocLoadReport {
  if (!boardId) return { mounted: () => {}, navigated: () => {} };
  let pending: ReturnType<typeof startPageLoadReport> | null = startPageLoadReport({
    page: 'doc',
    workspaceId: boardId,
  });
  let onDiff = false;
  let fileSwitch: FileSwitchClock | null = null;
  return {
    navigated() {
      fileSwitch?.abandon();
      fileSwitch = !pending && onDiff ? startFileSwitchReport({ workspaceId: boardId }) : null;
    },
    mounted(ctx) {
      if (ctx.scope.disposed) return;
      onDiff = ctx.docType === 'diff';
      const clock = fileSwitch;
      if (clock && !onDiff) {
        clock.abandon();
        fileSwitch = null;
      } else if (clock) {
        clock.mounted();
        const show = (): void => {
          if (ctx.scope.disposed || fileSwitch !== clock) return;
          fileSwitch = null;
          clock.contentShown();
        };
        ctx.client.onReady(() => {
          if (ctx.contentDrawn) void ctx.contentDrawn.then(show);
          else show();
        });
      }
      const report = pending;
      if (!report) return;
      report.setPage(docPageType(ctx));
      ctx.client.onReady(() => {
        if (ctx.scope.disposed || pending !== report) return;
        pending = null;
        report.contentShown();
      });
    },
  };
}
