/**
 * A code file, a diff, a redline or a media page in the presence room. These
 * have no blocks to name, so a person's spot on one is how far down they are
 * and the thread they have open; a followed spot shows a thread the way a
 * marker tap does, scrolls to a fraction, or finds a phrase by the surface's
 * own `find` (CodeMirror draws only the lines on screen, so the page's text
 * cannot be searched).
 *
 * `doc-spot.ts` is the markdown editor's counterpart.
 */
import type { PresenceSpot } from '@claude-workspaces/core/workspace-presence';
import type { MountScope } from '../mount-scope.ts';
import { docSpotMoved, setDocSpotHandle } from './doc-spot-slot.ts';
import { onPageScroll, pageScroller, scrollFraction, scrollToFraction } from './page-scroll.ts';

/** What can scroll on a doc page, the surface first. */
const DOC_SCROLL_ROOTS = ['.cm-scroller', '#editor', '#shell'] as const;
/** How long a followed spot waits for the file to arrive: a folder's files
 *  open lazily, so a follow lands before there is anything to scroll. */
const ARRIVAL_MS = 3_000;

export function wireFlatDocSpot(opts: {
  docId: string;
  document: Document;
  openThread: () => string | null;
  revealThread: (id: string) => void;
  /** Bring the words into view; false when they are not on this page. */
  find?: (quote: string) => boolean;
  scope: MountScope;
}): void {
  const { document, scope } = opts;
  const scroller = () => pageScroller(document, DOC_SCROLL_ROOTS);
  /** Bumped by each spot, so a newer one ends the wait for an older one. */
  let latest = 0;
  const place = (spot: PresenceSpot): boolean => {
    if (spot.quote && opts.find?.(spot.quote)) return true;
    const root = scroller();
    if (spot.scroll === undefined || !root || root.scrollHeight <= root.clientHeight) return false;
    scrollToFraction(root, spot.scroll);
    return true;
  };
  const show = (spot: PresenceSpot): void => {
    const mine = ++latest;
    if (spot.threadId) {
      opts.revealThread(spot.threadId);
      return;
    }
    const until = performance.now() + ARRIVAL_MS;
    const attempt = (): void => {
      if (mine !== latest || scope.disposed || place(spot) || performance.now() > until) return;
      requestAnimationFrame(attempt);
    };
    attempt();
  };
  const report = (): void => {
    const threadId = opts.openThread();
    const scroll = scrollFraction(scroller());
    docSpotMoved(
      { ...(threadId ? { threadId } : {}), ...(scroll === undefined ? {} : { scroll }) },
      undefined,
    );
  };
  scope.onCleanup(setDocSpotHandle({ docId: opts.docId, show }));
  scope.onCleanup(onPageScroll(document, report));
  report();
}
