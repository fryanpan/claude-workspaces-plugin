import { pageKey } from './comment-view-model.ts';
import { isInOwnChrome } from './widget-picker.ts';

/**
 * A round badge on each link that goes to another page with open comments,
 * holding how many (the owner, 2026-10-29: "I was expecting the badges here
 * to show the number of comments on that page"). The page the reader is on
 * gets none: its pins are already in front of them.
 *
 * Links are the page's own `<a href>`s, read where they are on screen, so a
 * mock's nav that moves between `#book` and `#pay` and an app's that moves
 * between paths both qualify. A page the mock moves to without an address
 * has no link the widget can name, and gets no badge. The badges are drawn
 * in a fixed layer of the widget's own, never inside the page's markup, so a
 * mock's script and a round swap see a page the widget has not touched.
 */

/** The page a link on this page goes to, or null for anywhere else. */
export function linkPage(a: HTMLAnchorElement): string | null {
  const raw = a.getAttribute('href');
  if (!raw || /^(javascript|mailto|tel):/i.test(raw)) return null;
  let u: URL;
  try {
    u = new URL(raw, location.href);
  } catch {
    return null;
  }
  if (u.origin !== location.origin) return null;
  return pageKey({ url: u.pathname + u.search + u.hash });
}

/** The page's own links, by the page each goes to, in the page's order. */
export function pageLinks(): Map<string, HTMLAnchorElement[]> {
  const out = new Map<string, HTMLAnchorElement[]>();
  for (const a of document.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    if (isInOwnChrome(a)) continue;
    const k = linkPage(a);
    if (k === null) continue;
    const list = out.get(k) ?? [];
    list.push(a);
    out.set(k, list);
  }
  return out;
}

export interface Badges {
  draw(counts: Map<string, number>, here: string): void;
  stop(): void;
}

export function mountBadges(layer: HTMLElement): Badges {
  let counts = new Map<string, number>();
  let here = '';
  let queued = 0;
  const place = (): void => {
    queued = 0;
    layer.innerHTML = '';
    for (const [key, links] of pageLinks()) {
      const n = key === here ? 0 : (counts.get(key) ?? 0);
      if (!n) continue;
      for (const a of links) {
        const r = a.getBoundingClientRect();
        if (!(r.width || r.height)) continue;
        const b = document.createElement('span');
        b.className = 'cw-link-badge';
        b.dataset.page = key;
        b.setAttribute('aria-hidden', 'true');
        b.textContent = n > 99 ? '99+' : String(n);
        b.style.left = `${Math.round(r.right - 10)}px`;
        b.style.top = `${Math.round(r.top - 8)}px`;
        layer.appendChild(b);
      }
    }
  };
  const soon = (): void => {
    queued ||= requestAnimationFrame(place);
  };
  addEventListener('resize', soon);
  addEventListener('scroll', soon, { capture: true, passive: true });
  return {
    draw(c, h) {
      counts = c;
      here = h;
      place();
    },
    stop() {
      removeEventListener('resize', soon);
      removeEventListener('scroll', soon, true);
    },
  };
}
