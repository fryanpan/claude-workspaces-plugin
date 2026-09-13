import { isInOwnChrome } from './widget-picker.ts';

/**
 * The page's OWN bar along the bottom of the screen — a tab bar, a sticky
 * footer — and how far up it reaches.
 *
 * The widget's bottom controls (the FAB, the list button, the phone prompt and
 * composer, the dock) are measured from the screen's bottom edge, which is
 * exactly where such a bar sits. So on a mock with a fixed nav they covered
 * it: at 430 wide the prompt lay over every tab and took every tap, and at
 * 1180 the FAB sat on the last tab, where a tap left comment mode instead of
 * commenting. The widget cannot be hit-tested through, because the FAB is the
 * mode's off switch, so it stands on top of the bar instead: `widget.ts` adds
 * this height to `--cw-vv-bottom`, the offset every one of them already rides.
 *
 * Found by hit-testing just inside the screen's bottom edge at three points
 * across it, skipping the widget's own chrome, and walking up to the nearest
 * fixed or sticky box. Only that box counts, and only if it is short and
 * touches the bottom: a short child of a full-screen fixed shell is content
 * scrolling past, not a bar, and lifting for it would make the buttons jump
 * as the page scrolls. A page with no such box measures zero and nothing
 * moves.
 */
export function pageBarHeight(vv: VisualViewport): number {
  const bottom = vv.offsetTop + vv.height;
  const y = bottom - 2;
  let top = bottom;
  for (const f of [0.1, 0.5, 0.9]) {
    const hit = document
      .elementsFromPoint(vv.offsetLeft + vv.width * f, y)
      .find((e) => !isInOwnChrome(e));
    for (let e: Element | null | undefined = hit; e && e !== document.body; e = e.parentElement) {
      if (/fixed|sticky/.test(getComputedStyle(e).position)) {
        const r = e.getBoundingClientRect();
        if (r.height < vv.height * 0.35 && r.bottom >= y) top = Math.min(top, r.top);
        break;
      }
    }
  }
  return Math.round(bottom - top);
}

/**
 * Re-run `update` in the next frame whenever the bar could have come or gone:
 * the window resizing, anything scrolling (a sticky footer sticks on scroll),
 * and the page's DOM changing — a node added, or a class, style or `hidden`
 * flipped, which is how an app hides its tab bar on a full-screen view.
 * Mutations inside the widget's own chrome are skipped, or the widget's own
 * writes would re-measure forever. Returns the teardown.
 */
export function watchPageBar(update: () => void): () => void {
  let queued = 0;
  const soon = () => {
    queued ||= requestAnimationFrame(() => {
      queued = 0;
      update();
    });
  };
  const mo = new MutationObserver((records) => {
    if (records.some((r) => !isInOwnChrome(r.target))) soon();
  });
  mo.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['class', 'style', 'hidden'],
  });
  addEventListener('resize', soon);
  addEventListener('scroll', soon, { capture: true, passive: true });
  return () => {
    mo.disconnect();
    removeEventListener('resize', soon);
    removeEventListener('scroll', soon, true);
  };
}
