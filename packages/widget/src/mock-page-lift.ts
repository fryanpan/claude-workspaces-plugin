/**
 * A mock's own buttons along the bottom stand above a docked review item.
 *
 * The dock is a bar across the bottom of the page (`widget-dock.ts`), and the
 * widget lifts its own buttons by the bar's height (`--cw-dock-h`). A mock's
 * buttons are the mock's: a bar fixed 20px up sat under the dock, so the
 * question waiting for the reader hid the controls he was using (28 October,
 * a mock of the lead chat). The mock cannot know the dock is there, so this
 * lifts for it: every element the mock fixes in the bottom half of the screen
 * that reaches into the dock's band moves up by the dock's height, through
 * the `translate` property, which leaves the mock's own `transform` alone. It
 * comes back down when the dock clears.
 *
 * Only on a served mock (`mockup-live.ts` calls it). On a dev server the
 * widget is a guest, and moving the host's elements is not its business.
 */

/** The widget's own chrome — the chevrons included — lifts itself. */
const OWN = 'claude-feedback-widget, [data-feedback-widget]';

/** Each lifted element: its inline `translate` before, and how far it rose. */
const lifted = new Map<HTMLElement, { was: string; by: number }>();

function dockHeight(host: HTMLElement): number {
  return Number.parseFloat(host.style.getPropertyValue('--cw-dock-h')) || 0;
}

function drop(el: HTMLElement): void {
  el.style.translate = lifted.get(el)?.was ?? '';
  lifted.delete(el);
}

/** Lift what the dock would cover and drop what it no longer does. */
export function liftPage(doc: Document, host: HTMLElement): void {
  const h = dockHeight(host);
  if (h === 0 && lifted.size === 0) return;
  const view = doc.documentElement.clientHeight;
  const want = new Set<HTMLElement>();
  if (h > 0) {
    for (const el of doc.body.querySelectorAll<HTMLElement>('*')) {
      if (el.closest(OWN) || getComputedStyle(el).position !== 'fixed') continue;
      // A fixed child of a lifted element moves with it.
      if ([...want].some((w) => w.contains(el))) continue;
      const r = el.getBoundingClientRect();
      const by = lifted.get(el)?.by ?? 0;
      const top = r.top + by;
      const bottom = r.bottom + by;
      // Bottom-half chrome only: a full-height panel or an overlay reaches
      // the band too, and lifting it would push its top off the screen.
      if (r.width > 0 && top >= view / 2 && bottom > view - h) want.add(el);
    }
  }
  for (const el of [...lifted.keys()]) if (!want.has(el)) drop(el);
  for (const el of want) {
    const was = lifted.get(el)?.was ?? el.style.translate;
    lifted.set(el, { was, by: h });
    const to = `0px -${h}px`;
    if (el.style.translate !== to) el.style.translate = to;
  }
}

/**
 * Keep the page lifted: when the widget writes a new dock height, when the
 * window resizes, and when the mock changes its own page — a button that
 * appears in the corner after a tap has to clear the dock too. One pass per
 * frame at most, and a pass that changes nothing writes nothing, so its own
 * writes settle rather than loop.
 */
export function keepPageLifted(doc: Document): void {
  const host = doc.querySelector<HTMLElement>('claude-feedback-widget');
  if (!host) return;
  let queued = false;
  const pass = (): void => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      liftPage(doc, host);
    });
  };
  new MutationObserver(pass).observe(host, { attributeFilter: ['style'] });
  new MutationObserver(pass).observe(doc.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['class', 'style', 'hidden'],
  });
  addEventListener('resize', pass);
  pass();
}
