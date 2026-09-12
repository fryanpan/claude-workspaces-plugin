/**
 * WHERE a comment card lives — how much ROOM there is beside the prose, and
 * nothing else.
 *
 * The card itself is one component (`doc/thread-card.ts`); this module owns
 * only the question of where copies of it are placed:
 *
 *  - `inline`  — cards sit in the document flow, under the phrase they are
 *                about, where a GitHub PR comment sits. One column, so the
 *                prose keeps the full width. The badge in the top bar still
 *                raises the whole list as a sheet over the doc on a phone;
 *                that is the drawer's own shape and not a placement.
 *  - `balloon` — nothing sits in the flow; each card rides in the right
 *                margin beside its phrase. Needs a margin to ride in, so it
 *                is the placement only above `BALLOON_ROOM_QUERY`.
 *
 * There was a top-bar control that stored a per-device override of this, and
 * it is gone: it was the last button in a bar that had to fit a phone, and
 * the thing it switched — the prose running full width or narrowed to leave a
 * margin — is a question about the window rather than about the reader. What
 * survives is the half that was always doing the work: the width picks the
 * placement, at every width, with nothing stored.
 *
 * Width still cannot say what HARDWARE this is (docs/process/learnings.md,
 * "Width cannot identify a device, because page zoom moves it" — a 1366px
 * iPad at 85% zoom reports 1607px). It does not have to. It is being asked
 * how much room there is for a 260px column, which is exactly the question it
 * can answer.
 *
 * The result is published as `data-cards` on `<body>` so the stylesheet can
 * key off it, and `onPlacementChange` re-publishes it when the window crosses
 * the boundary.
 */

/** Where the comment cards go. */
export type CardPlacement = 'inline' | 'balloon';

/** Enough width for the 260px margin column beside the prose. */
export const BALLOON_ROOM_QUERY = '(min-width: 1101px)';

/**
 * The placement, given how much room there is.
 *
 * Pure, so the policy is checkable without a DOM.
 */
export function resolvePlacement(roomForMargin: boolean): CardPlacement {
  return roomForMargin ? 'balloon' : 'inline';
}

function media(query: string): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(query).matches;
}

/** Is there room beside the prose for a margin column? */
export function roomForMargin(): boolean {
  return media(BALLOON_ROOM_QUERY);
}

/** Where the cards go at this width. */
export function cardPlacement(): CardPlacement {
  return resolvePlacement(roomForMargin());
}

/**
 * Do inline cards render? The question `mobile-review.ts` asks before it
 * builds any.
 */
export function inlineCardsVisible(): boolean {
  return cardPlacement() === 'inline';
}

/**
 * Does the balloon margin render?
 *
 * The two predicates are exhaustive and non-overlapping: exactly one of the
 * surfaces carries the cards at any width, which is what stops a reader
 * getting both at once or neither.
 */
export function balloonMarginVisible(): boolean {
  return cardPlacement() === 'balloon';
}

/**
 * Publish the placement to the stylesheet. Every rule that used to sit in a
 * `(max-width: 1100px)` block sits under `body[data-cards=…]`, so this
 * attribute is what actually moves the cards.
 */
export function applyPlacement(placement: CardPlacement = cardPlacement()): void {
  if (typeof document === 'undefined' || !document.body) return;
  document.body.dataset.cards = placement;
}

/**
 * Run `handler` whenever the comment surface in force changes.
 *
 * `listen` is the caller's own scoped binder, so the subscription is torn
 * down with whatever mounted it.
 */
export function onPlacementChange(
  listen: (target: EventTarget, type: string, fn: () => void) => void,
  handler: () => void,
): void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
  listen(window.matchMedia(BALLOON_ROOM_QUERY), 'change', handler);
}
