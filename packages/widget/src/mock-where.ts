/**
 * Where a person is inside a mock's frame, for the host page, which cannot read
 * in: the frame shows a place the host posts, and reports the place its person
 * is at. Part of `mock-bridge.ts`, and imported only by it.
 */
/** A place the host page asks the mock to show: words, or how far down. */
export interface MockAt {
  quote?: unknown;
  scroll?: unknown;
}

// --- A place a followed agent or person points at ---
// The host page posts a phrase or a scroll fraction (`mock-presence.ts`
// in the app): the phrase is found by its words and centred, else the
// page scrolls to the fraction. Read, never written.
export function showAt(at: MockAt): void {
  const root = document.scrollingElement ?? document.documentElement;
  if (typeof at.quote === 'string' && at.quote) {
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      if (n.textContent?.includes(at.quote)) {
        n.parentElement?.scrollIntoView({ block: 'center' });
        return;
      }
    }
  }
  if (typeof at.scroll === 'number' && at.scroll >= 0 && at.scroll <= 1) {
    window.scrollTo(0, at.scroll * (root.scrollHeight - window.innerHeight));
  }
}

// --- Where the person in this frame is ---
// The host page cannot read into the frame, so it is told, a moment after
// each scroll or tap: how far down, the heading of the section on screen,
// the thread open. `mock-presence.ts` in the app turns that into the
// person's spot and a voice message's context.
export function reportWhere(boardOrigin: string): void {
  const heading = (): string | undefined => {
    let last: string | undefined;
    for (const h of Array.from(document.querySelectorAll('h1, h2, h3'))) {
      const box = h.getBoundingClientRect();
      if (box.top > window.innerHeight / 2) break;
      const text = h.textContent?.trim();
      if (text && box.height > 0) last = text;
    }
    return last;
  };
  let timer: ReturnType<typeof setTimeout> | null = null;
  const report = (): void => {
    timer = null;
    const root = document.scrollingElement ?? document.documentElement;
    const room = root.scrollHeight - window.innerHeight;
    const widget = document.querySelector('claude-feedback-widget') as {
      activeThread?: unknown;
    } | null;
    window.parent.postMessage(
      {
        cw: 'here',
        scroll: room > 1 ? Math.min(1, Math.max(0, root.scrollTop / room)) : undefined,
        heading: heading(),
        thread: widget?.activeThread ?? undefined,
      },
      boardOrigin,
      [],
    );
  };
  const soon = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(report, 150);
  };
  window.addEventListener('scroll', soon, { passive: true });
  window.addEventListener('click', soon, { passive: true, capture: true });
  window.addEventListener('load', soon);
}
