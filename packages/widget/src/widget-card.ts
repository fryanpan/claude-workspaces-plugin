import type { ElementAnchor } from '@claude-workspaces/core';
import { draftKey, writeDraft } from './draft-store.ts';
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

/** The anchor each composer will post with. */
export const cardAnchor = new WeakMap<Element, ElementAnchor>();

/** Words typed and not posted, by the element they are about, kept when the
 *  mode closes over them. */
export const drafts = new WeakMap<HTMLElement, string>();
export function keepDraft(el: FeedbackWidgetEl): void {
  const c = el.shadow.querySelector('.composer');
  const t = c && cardTarget.get(c);
  const v = c?.querySelector('textarea')?.value;
  if (t && v) {
    drafts.set(t, v);
    saveDraft(el, false);
  }
}

/** A comment as it waits out a reload (`draft-store.ts`): its words, its
 *  anchor, and whether its composer was open. One per page — the latest. */
export interface CommentDraft {
  t: string;
  a: ElementAnchor;
  o: boolean;
}

/** Write the open composer's draft as it is typed, or forget it when the
 *  field is empty. Nothing is written while it posts (`postingDraft`). */
export function saveDraft(el: FeedbackWidgetEl, open: boolean): void {
  const c = el.shadow.querySelector('.composer');
  const a = c && !c.hasAttribute('data-posting') && cardAnchor.get(c);
  const t = c?.querySelector('textarea')?.value;
  if (a) writeDraft(draftKey('comment', el.opts.docId), t ? { t, a, o: open } : null);
}

/** Sent or cancelled: nothing comes back on the next load. */
export function dropDraft(el: FeedbackWidgetEl): void {
  writeDraft(draftKey('comment', el.opts.docId), null);
}

/** A post on its way holds no draft, so a reload mid-post cannot bring the
 *  comment back to be posted twice; a post that fails writes it again. */
export function postingDraft(el: FeedbackWidgetEl, composer: HTMLElement, on: boolean): void {
  composer.toggleAttribute('data-posting', on);
  if (on) dropDraft(el);
  else saveDraft(el, true);
}

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

/**
 * Where a thread's pin stands across: over the element's top right corner, or
 * just past its words when they end well short of that — a heading's pin sits
 * after the heading, not in the far corner of the page.
 */
export function pinX(el: Element, r: DOMRect): number {
  const range = document.createRange();
  range.selectNodeContents(el);
  const words = range.getBoundingClientRect?.();
  return words?.width && r.right - words.right > 40 ? words.right + 14 : r.right - 6;
}

/** Must match `.composer` / `.saved` width in `styles.ts`. */
const CARD_W = 280;
const GAP = 12;
/** A card whose element has left the page stands here: clear of the banner. */
const REST_Y = 72;

export function placeCards(w: FeedbackWidgetEl): void {
  const lead = w.shadow.querySelector('.leader') as HTMLElement | null;
  if (!lead) return;
  // The part of the page actually on screen: above an iPad's keyboard, and
  // inside a pinch-zoom, on both axes. The window's size knows about neither.
  const vv = window.visualViewport;
  const screenTop = (vv?.offsetTop ?? 0) + 8;
  const screenBot = (vv ? vv.offsetTop + vv.height : innerHeight) - 8;
  const x = (vv ? vv.offsetLeft + vv.width : window.innerWidth) - 16 - CARD_W;
  let top = screenTop;
  let bot = screenBot;
  // The mode's own buttons in the card's column — Done, the FAB's X, the list,
  // the mic — stay uncovered: the card's room ends where they start.
  for (const o of w.shadow.querySelectorAll('.fab, .fab-list, .fab-mic, .picker-banner')) {
    const b = o.getBoundingClientRect();
    if (b.width && b.right > x && b.left < x + CARD_W) {
      if (b.top > (top + bot) / 2) bot = Math.min(bot, b.top - 8);
      else top = Math.max(top, b.bottom + 8);
    }
  }
  let lines = '';
  // The composer is placed first and keeps its spot; a saved card still
  // showing its tick steps past every card already placed rather than over
  // one — two posts in quick succession stack. Down from the top half of the
  // screen, and UP from the bottom half: a stack pushed down there ran off the
  // bottom and was clamped back onto the card it had stepped past.
  const taken: Array<[number, number]> = [];
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
        : r.bottom + GAP + h <= bot || r.top - GAP - h < top
          ? r.bottom + GAP
          : r.top - GAP - h;
    y = Math.max(top, Math.min(y, bot - h));
    const up = 2 * y + h > top + bot;
    for (let moved = true; moved; ) {
      moved = false;
      for (const [a, b] of taken) {
        if (y < b && y + h > a) {
          y = up ? a - h - 10 : b;
          moved = true;
        }
      }
    }
    y = Math.max(top, Math.min(y, bot - h));
    taken.push([y, y + h + 10]);
    c.style.left = `${x}px`;
    c.style.top = `${y}px`;
    if (!r) continue;
    // The line leaves the element's own edge — a dot on it, so it lands ON
    // the thing — and meets the card on the side that faces it. That edge is
    // held to the screen: an element taller than it, or scrolled partly off
    // it, sent the line out past its edge. The screen, not the card's room:
    // held there, the dot for an element below the FAB's top sat above it.
    const ex = Math.max(
      (vv?.offsetLeft ?? 0) + 8,
      Math.min(beside ? r.right + 4 : Math.min(Math.max(x + 24, r.left), r.right), x + CARD_W + 8),
    );
    const ey = Math.max(
      screenTop,
      Math.min(beside ? r.top + 10 : y > r.top ? r.bottom + 2 : r.top - 2, screenBot),
    );
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
