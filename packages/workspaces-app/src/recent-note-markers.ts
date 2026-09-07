/**
 * The edge markers: when a tinted note (settle-wash.ts) sits above or below
 * the part of the doc on screen, a pill at that edge says how many and
 * scrolls there on a tap. Approved mock `recent-notes-round1`: the marker
 * counts and DISAPPEARS rather than being dismissed — it goes when the last
 * note past that edge ages out, so it is never something to clear.
 *
 * Plain DOM pinned to the editor pane (the element the scroller sits in),
 * never inside the prose: nothing here can enter the document or sync.
 * Driven by the same thing it reports — which `.recent-note` elements are
 * outside the scroller's box right now — and re-counted on scroll, on
 * resize, and whenever the tint set changes.
 */

export interface RecentNoteMarkersOptions {
  /** The positioned element the pills pin to — the editor pane. */
  pane: HTMLElement;
  /** The element that scrolls the prose. */
  scroller: HTMLElement;
  /** The prose root the tinted lines live in. */
  prose: HTMLElement;
  /** Reduced-motion preference; read from the media query by default. */
  reducedMotion?: () => boolean;
}

export interface RecentNoteMarkers {
  /** Re-count now. Cheap: one rect per tinted line. */
  sync(): void;
  destroy(): void;
}

/** A line is past an edge only when it is wholly outside the box; a line
 *  half-visible is on screen and needs no marker. */
const EDGE_SLACK_PX = 2;

export function mountRecentNoteMarkers(opts: RecentNoteMarkersOptions): RecentNoteMarkers {
  const { pane, scroller, prose } = opts;
  const reduced =
    opts.reducedMotion ??
    (() => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false);
  const pill = (edge: 'top' | 'bottom'): HTMLButtonElement => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `recent-edge ${edge}`;
    b.hidden = true;
    pane.appendChild(b);
    return b;
  };
  const top = pill('top');
  const bottom = pill('bottom');
  let firstAbove: HTMLElement | null = null;
  let firstBelow: HTMLElement | null = null;

  const jump = (el: HTMLElement | null) => {
    el?.scrollIntoView({ block: 'center', behavior: reduced() ? 'auto' : 'smooth' });
  };
  top.addEventListener('click', () => jump(firstAbove));
  bottom.addEventListener('click', () => jump(firstBelow));

  const sync = () => {
    const box = scroller.getBoundingClientRect();
    const boxTop = box.top;
    const boxBottom = box.top + scroller.clientHeight;
    let above = 0;
    let below = 0;
    firstAbove = null;
    firstBelow = null;
    for (const el of prose.querySelectorAll<HTMLElement>('.recent-note')) {
      const r = el.getBoundingClientRect();
      if (r.bottom < boxTop + EDGE_SLACK_PX) {
        above += 1;
        firstAbove ??= el;
      } else if (r.top > boxBottom - EDGE_SLACK_PX) {
        below += 1;
        firstBelow ??= el;
      }
    }
    top.hidden = above === 0;
    bottom.hidden = below === 0;
    top.textContent = `↑ ${above} new`;
    bottom.textContent = `↓ ${below} new`;
    // The pane holds the format bar above the scroller; the top pill sits
    // just inside the scroller's own top edge, whatever the bar's height.
    top.style.top = `${scroller.offsetTop + 8}px`;
  };

  scroller.addEventListener('scroll', sync, { passive: true });
  window.addEventListener('resize', sync);
  sync();
  return {
    sync,
    destroy() {
      scroller.removeEventListener('scroll', sync);
      window.removeEventListener('resize', sync);
      top.remove();
      bottom.remove();
    },
  };
}
