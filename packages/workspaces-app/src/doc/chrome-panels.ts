import type { MountScope } from '../mount-scope.ts';
import type { ReviewChrome } from '../review-chrome.ts';
import type { ReviewSurface } from '../review-surface.ts';

/**
 * The two pieces of chrome that are about panels and pointing rather than
 * about a review: the resize handle a side panel hangs off, and the click on a
 * `.thread-range` span in the prose that focuses the thread it belongs to.
 *
 * Both take the chrome they drive as an argument, so neither needs to be
 * inside `mountReviewChrome` to reach it.
 */

// --- thread-range click → focus the thread -------------------------------------

export interface ThreadFocusOpts {
  /** The scroll container that hosts the editor's `.thread-range` spans. */
  editorMount: HTMLElement;
  chrome: ReviewChrome;
  surface: Pick<ReviewSurface, 'pulseRange' | 'placeCaretAtPoint'>;
  scope: MountScope;
  /**
   * Try showing the thread in the balloon margin first (the "vice versa" of
   * "click a balloon, see its anchor" — see markup-margin.ts). Return true
   * when handled; the drawer/thread-view fallback below is skipped. Omit on
   * surfaces with no margin (the click still highlights + pulses the anchor).
   */
  revealBalloon?: (threadId: string) => boolean;
}

/**
 * Tap-on-highlight in the editor → focus the thread. Shared by the plain
 * markdown mount and the redline mount so the click-to-focus behaviour is
 * one implementation, not two forks that drift.
 *   • A balloon margin present and showing the thread → scroll the balloon
 *     into view (the balloon already reads as the mini-drawer for that spot).
 *   • Otherwise: mobile → full-screen thread view; desktop → open the side
 *     drawer and scroll to the thread's card.
 */
export function wireThreadRangeClicks(opts: ThreadFocusOpts): void {
  const { editorMount, chrome, surface, scope, revealBalloon } = opts;
  scope.listen(editorMount, 'click', (ev) => {
    const t = ((ev as MouseEvent).target as HTMLElement).closest('.thread-range');
    if (!t) return;
    const threadId = t.getAttribute('data-thread-id');
    if (!threadId) return;
    ev.preventDefault();
    ev.stopPropagation();
    // FIRST, before any repaint: adopt the caret this very click just put in
    // the prose.
    //
    // The doc is editable now, so a click on a highlight both places a caret
    // and opens a thread. The browser reports the new caret to the editor
    // asynchronously, well after this handler returns, while
    // `refreshThreadDecorations` below repaints the highlight synchronously —
    // and a repaint writes the editor's selection back to the DOM. So the
    // editor's PREVIOUS selection, which on a freshly loaded doc is the very
    // start of it, used to land back on screen a moment after the reader's
    // finger left the word they tapped. The caret then sat in the title, the
    // comment pill followed it to the top of the window over the back arrow,
    // and the next keystroke was typed into the heading — and, this being a
    // bound doc, saved there.
    const ptr = ev as MouseEvent;
    surface.placeCaretAtPoint?.(ptr.clientX, ptr.clientY);
    chrome.refreshThreadDecorations(threadId);
    // No scrollToPos here — the user clicked the highlight, it's already
    // on screen; jumping the doc would feel broken.
    const range = chrome.resolveThreadRange(threadId);
    if (range) surface.pulseRange(range.from, range.to);
    // Asked BEFORE the balloon, because a balloon reveal expands the card in
    // the column — which is the treatment this thread was promoted out of.
    // This is the one route into a thread that does not pass through
    // `onThreadClick`, so without this the modal would be reachable from the
    // drawer and not from the highlight the reader actually taps.
    if (chrome.openInModal(threadId)) return;
    if (revealBalloon?.(threadId)) return;
    if (chrome.isMobile()) {
      // The card is already inline, directly under the text just tapped —
      // unfold it where it sits (every copy) instead of covering the doc
      // with a separate view of the same thread.
      chrome.threadsPanel.setActive(threadId);
    } else {
      chrome.openDrawer();
      requestAnimationFrame(() => chrome.threadsPanel.revealThread(threadId));
    }
  });
}

// --- resizable side panels ----------------------------------------------------

export interface ResizeOpts {
  pane: HTMLElement | null;
  cssVar: string;
  storageKey: string;
  min: number;
  max: () => number;
  /** Pointer x → desired panel width (direction depends on which edge). */
  widthFromPointer: (e: PointerEvent) => number;
  handleClass: string;
  label: string;
}

export function wireResizeHandle(opts: ResizeOpts): void {
  const { pane } = opts;
  if (!pane) return;
  // The pane and handle are shell-level (doc-independent), but mountReviewChrome
  // runs per navigation — wire the handle exactly once so re-mounts don't stack
  // duplicate drag bars (and duplicate window pointer listeners) on the pane.
  // Each pane owns a distinct handleClass, so a plain class query is precise.
  if (pane.querySelector(`.${opts.handleClass}`)) return;
  const clamp = (w: number) => Math.max(opts.min, Math.min(opts.max(), w));
  const apply = (w: number) => document.documentElement.style.setProperty(opts.cssVar, `${w}px`);
  try {
    const saved = Number(localStorage.getItem(opts.storageKey));
    if (Number.isFinite(saved) && saved >= opts.min) apply(clamp(saved));
  } catch {
    // localStorage unavailable — fall back to the CSS default width.
  }

  const handle = document.createElement('div');
  handle.className = opts.handleClass;
  handle.setAttribute('role', 'separator');
  handle.setAttribute('aria-orientation', 'vertical');
  handle.setAttribute('aria-label', opts.label);
  handle.title = 'Drag to resize · double-click to reset';
  pane.appendChild(handle);

  let dragging = false;
  const onMove = (e: PointerEvent) => {
    if (dragging) apply(clamp(opts.widthFromPointer(e)));
  };
  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    document.body.classList.remove('threads-resizing');
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    const px = Number.parseInt(
      getComputedStyle(document.documentElement).getPropertyValue(opts.cssVar),
      10,
    );
    if (Number.isFinite(px)) {
      try {
        localStorage.setItem(opts.storageKey, String(px));
      } catch {
        // ignore — width still applied for this session
      }
    }
  };
  handle.addEventListener('pointerdown', (e) => {
    if (window.matchMedia('(max-width: 900px)').matches) return;
    e.preventDefault();
    dragging = true;
    handle.classList.add('dragging');
    document.body.classList.add('threads-resizing');
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  });
  handle.addEventListener('dblclick', () => {
    document.documentElement.style.removeProperty(opts.cssVar);
    try {
      localStorage.removeItem(opts.storageKey);
    } catch {
      // ignore
    }
  });
}
