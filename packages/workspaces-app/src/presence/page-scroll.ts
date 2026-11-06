/**
 * How far down a page its reader is, for a page with no block to name: a
 * board tab, a task panel, a code file, a diff, a media page.
 *
 * `scroll` in a spot is a fraction from 0 (top) to 1 (bottom), so two windows
 * of different heights agree. Which element scrolls differs by page and by
 * width, so it is found rather than named: the outermost element under the
 * page's roots that has room to scroll, else the document.
 */

/** The element that scrolls `root`'s content, or null if nothing does. */
function scrollerIn(root: Element, win: Window): Element | null {
  const walk: Element[] = [root];
  while (walk.length > 0) {
    const el = walk.shift() as Element;
    if (el.scrollHeight - el.clientHeight > 1) {
      const y = win.getComputedStyle(el).overflowY;
      if (y === 'auto' || y === 'scroll') return el;
    }
    walk.push(...Array.from(el.children));
  }
  return null;
}

/** The first of `roots` showing on the page that has a scroller; else the
 *  document's. A root is a selector, so a page's own mount may come and go. */
export function pageScroller(doc: Document, roots: readonly string[]): Element | null {
  const win = doc.defaultView;
  if (!win) return null;
  for (const selector of roots) {
    const root = doc.querySelector(selector);
    if (!root || root.getClientRects().length === 0) continue;
    const found = scrollerIn(root, win);
    if (found) return found;
  }
  const top = doc.scrollingElement;
  return top && top.scrollHeight - top.clientHeight > 1 ? top : null;
}

/** How far down `el` is, or undefined when it has no room to scroll. */
export function scrollFraction(el: Element | null): number | undefined {
  if (!el) return undefined;
  const room = el.scrollHeight - el.clientHeight;
  return room > 1 ? Math.min(1, Math.max(0, el.scrollTop / room)) : undefined;
}

/** Take `el` to a fraction of the way down. */
export function scrollToFraction(el: Element | null, fraction: number): void {
  if (el) el.scrollTop = fraction * (el.scrollHeight - el.clientHeight);
}

/**
 * Run `cb` a moment after any scroll on the page settles. In the capture
 * phase, because a scroll does not bubble and which element scrolls is the
 * thing this cannot name. Returns the way to stop.
 */
export function onPageScroll(
  target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>,
  cb: () => void,
  settleMs = 150,
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const scrolled = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      cb();
    }, settleMs);
  };
  target.addEventListener('scroll', scrolled, { capture: true, passive: true });
  return () => {
    if (timer) clearTimeout(timer);
    target.removeEventListener('scroll', scrolled, { capture: true });
  };
}
