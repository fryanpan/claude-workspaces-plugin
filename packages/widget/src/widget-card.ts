import type { FeedbackWidgetEl } from './widget.ts';

/**
 * Where the comment card stands — round 3's margin layout, on a page the
 * widget does not own.
 *
 * The mock builds its composer INTO a comment margin, at the height its
 * comment will take, joined to the element by a faint line. A host page has no
 * margin to build into and the widget may not make one (it must not move the
 * host's layout), so the card is fixed to the right edge of the viewport and
 * follows its element there: level with it while the element stops short of
 * that edge, and just below it — or above, when below has no room — when the
 * element reaches into it. Covering the element being commented on is the one
 * placement it never chooses; only an element too tall for the card to fit
 * above or below it gets covered, because then nothing on screen is clear.
 *
 * Asked again every frame from the widget's rAF loop, so the card and its
 * line keep up with a scroll, a resize, or a page that moves its own layout.
 */

/** The element each card is about. Off-DOM, like the picker's outline
 *  bookkeeping, so nothing is written onto the host page's elements. */
export const cardTarget = new WeakMap<Element, HTMLElement>();

/**
 * The width at or below which the mode opens as a PROMPT on a bottom panel
 * rather than as a card.
 *
 * A layout question, not a device one: it asks whether there is room for a
 * 280px card beside the thing being commented on. (Width cannot identify a
 * device — zoom moves it — which is why nothing here concludes anything about
 * the reader from it.)
 */
const PHONE_MAX = 1100;
export function isPhoneFace(): boolean {
  return window.innerWidth <= PHONE_MAX;
}

/** Must match `.composer` / `.saved` width in `styles.ts`. */
const CARD_W = 280;
const GAP = 12;
/** A card about the page as a whole rests here: clear of the banner. */
const REST_Y = 72;

export function placeCards(w: FeedbackWidgetEl): void {
  const lead = w.shadow.querySelector('.leader') as HTMLElement | null;
  if (!lead) return;
  const vh = window.innerHeight;
  const x = window.innerWidth - 16 - CARD_W;
  let lines = '';
  // The composer is placed first and keeps its spot; a saved card still
  // showing its tick steps below it rather than over it.
  let taken: [number, number] | null = null;
  const cards = [
    ...w.shadow.querySelectorAll<HTMLElement>('.composer:not(.quick)'),
    ...w.shadow.querySelectorAll<HTMLElement>('.saved'),
  ];
  for (const c of cards) {
    const h = c.offsetHeight;
    const t = cardTarget.get(c);
    const r = t?.isConnected ? t.getBoundingClientRect() : null;
    const beside = !r || r.right + GAP <= x;
    let y = !r
      ? REST_Y
      : beside
        ? r.top
        : r.bottom + GAP + h <= vh || r.top - GAP - h < 0
          ? r.bottom + GAP
          : r.top - GAP - h;
    y = Math.max(8, Math.min(y, vh - h - 8));
    if (taken && y < taken[1] && y + h > taken[0]) y = taken[1];
    taken ??= [y, y + h + 10];
    c.style.left = `${x}px`;
    c.style.top = `${y}px`;
    if (!r) continue;
    // The line leaves the element's own edge — a dot on it, so it lands ON
    // the thing — and meets the card on the side that faces it.
    const ex = beside ? r.right + 4 : Math.min(Math.max(x + 24, r.left), r.right);
    const ey = beside ? r.top + 10 : y > r.top ? r.bottom + 2 : r.top - 2;
    const cx = beside ? x : Math.max(ex, x + 12);
    const cy = beside ? y + 12 : y > r.top ? y : y + h;
    lines += `<polyline points="${ex},${ey} ${cx},${cy}"/><circle cx="${ex}" cy="${ey}" r="2.5"/>`;
  }
  // Rewritten only when a point moved: this runs every frame.
  if (lead.dataset.p !== lines) {
    lead.dataset.p = lines;
    lead.innerHTML = `<svg>${lines}</svg>`;
  }
}
