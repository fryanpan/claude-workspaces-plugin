/**
 * Word's balloon stacking: each balloon wants to sit at its own anchorY.
 * Sorted by anchorY (stable for ties, so equal anchors keep input order),
 * each balloon is pushed down only as far as needed to clear the previous
 * balloon's bottom edge plus `gap` — minimal displacement, never above the
 * anchor of the first (topmost-anchored) balloon.
 *
 * With a `viewport`, balloons anchored at or above `viewport.bottom` are
 * additionally lifted just enough that their bottom edge (the composer and
 * its Answer button) stays inside the fold — cascading upward through the
 * stack when neighbours are in the way, but never lifting a balloon above
 * `viewport.top` and never moving one that already sits above it. Balloons
 * anchored below the fold are off-screen content and keep anchor placement.
 * When the stack simply cannot fit, the top of it pins at `viewport.top`
 * and the remainder overflows downward as before.
 *
 * The returned array is index-aligned with `items`: result[i] is the y for
 * items[i], regardless of anchor order in the input.
 */
export interface BalloonViewport {
  /** Content-space y of the visible region's top edge. */
  top: number;
  /** Content-space y of the visible region's bottom edge. */
  bottom: number;
  /**
   * The fold itself, when the bottom edge above has been pulled up to
   * reserve room for something drawn over the column (the new-content
   * strip and the action dock). A card anchored between the two is still
   * ON screen — it must be lifted, not left at its anchor under the strip
   * — so the "off-screen, leave it alone" test reads this and the lift
   * reads `bottom`. Defaults to `bottom`, which is the unreserved case.
   */
  visibleBottom?: number;
}

export function layoutBalloons(
  items: Array<{ anchorY: number; height: number }>,
  gap: number,
  viewport?: BalloonViewport,
): number[] {
  const order = items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => a.item.anchorY - b.item.anchorY);

  const result = new Array<number>(items.length);
  let prevBottom = Number.NEGATIVE_INFINITY;

  for (const { item, index } of order) {
    const y =
      prevBottom === Number.NEGATIVE_INFINITY
        ? item.anchorY
        : Math.max(item.anchorY, prevBottom + gap);
    result[index] = y;
    prevBottom = y + item.height;
  }

  if (!viewport) return result;

  // Backward lift pass: walking up from the fold, each in-viewport balloon
  // drops to the lower of its pushed-down position and the ceiling left by
  // the balloon below it. min() means a balloon that already fits does not
  // move; the floor means a balloon is never lifted above the viewport top,
  // and one already above it stays put.
  const fold = viewport.visibleBottom ?? viewport.bottom;
  let ceiling = viewport.bottom;
  for (let i = order.length - 1; i >= 0; i--) {
    const { item, index } = order[i];
    if (item.anchorY > fold) continue;
    const y = result[index];
    const lifted = Math.min(y, ceiling - item.height);
    result[index] = Math.max(lifted, Math.min(y, viewport.top));
    ceiling = result[index] - gap;
  }

  // The lift both frees room (a balloon pushed down by a since-lifted
  // neighbour belongs back at its anchor) and, where the floor stopped it,
  // leaves overlap — one more push-down pass from each balloon's new desired
  // position settles both.
  prevBottom = Number.NEGATIVE_INFINITY;
  for (const { item, index } of order) {
    const desired = Math.min(item.anchorY, result[index]);
    const y =
      prevBottom === Number.NEGATIVE_INFINITY ? desired : Math.max(desired, prevBottom + gap);
    result[index] = y;
    prevBottom = y + item.height;
  }

  return result;
}

/** The band a strip drawn over the column covers, at each end. */
export interface StripBand {
  top: number;
  bottom: number;
}

/**
 * Where the card stack may live once the new-content strips and the action
 * dock have taken their band at each end of the column. Nothing may come to
 * rest under a strip at any scroll position (Bryan, on round 2 of the mock),
 * and the two ends need different mechanisms: the bottom is a ceiling the
 * lift pass pulls cards up to, while the top is a FLOOR under the anchors,
 * because the lift deliberately never moves a card that already sits above
 * the viewport top.
 */
export function foldWithStrips(m: {
  scrollTop: number;
  clientHeight: number;
  gap: number;
  /** The existing floor (the floating toggle's clearance). */
  minY: number;
  band: StripBand;
}): { floorY: number; viewport: BalloonViewport } {
  const fold = m.scrollTop + m.clientHeight - m.gap;
  const top = Math.max(m.minY, m.scrollTop + m.band.top);
  // With no strip over the column the floor stays what it always was: the
  // toggle's clearance. Flooring at the scroll position instead would drag
  // every card the reader has scrolled past down with the fold.
  const floorY = m.band.top > 0 ? top : m.minY;
  return {
    floorY,
    viewport: { top, bottom: fold - m.band.bottom, visibleBottom: fold },
  };
}

/** The part of the column the reader can actually see, in content space. */
export interface VisibleBand {
  top: number;
  bottom: number;
}

/** A card, with the edges of the text it marks. */
export interface CardItem {
  /** Content-space top of the marked text. */
  anchorY: number;
  /** Content-space bottom of it — equal to `anchorY` where nothing measured. */
  anchorBottom: number;
  height: number;
}

/**
 * A card is in the margin only while the text it marks is on screen.
 *
 * This is the rule the column was missing, and its absence was one bug wearing
 * two faces. `foldWithStrips` floors every anchor at `scrollTop + band.top` so
 * that nothing comes to rest under the new-content strip — correct for a card
 * whose sentence the reader is looking at, and catastrophic for one whose
 * sentence is a thousand lines up: the floor drags it to the top of the fold
 * and the stack piles every comment in the document into the visible column,
 * each beside text that is nowhere near it. Measured at 1180x820 with a
 * meeting running: four cards painted on screen, four anchors between 4141 and
 * 4226px above it.
 *
 * So the fold is applied to the cards it is about. An anchor that intersects
 * `visible` goes through `layoutBalloons` exactly as before — floored under the
 * strip, lifted off the bottom one, stacked against its neighbours. An anchor
 * that does not stays AT its anchor, and is pushed clear of `visible` when its
 * own box would otherwise reach in: a card the reader can see is a claim about
 * the text beside it, and there is no text beside it here.
 *
 * Off-screen cards take no part in the on-screen stack, which is the other
 * half of the same rule — a card being pushed down by four cards the reader
 * cannot see is displaced by nothing they can point at.
 *
 * `visible` omitted is a layout that could not be measured (happy-dom, a
 * hidden pane): every card is treated as on screen, which is what this column
 * did before the fold existed at all.
 */
export function placeCards(
  items: readonly CardItem[],
  gap: number,
  m: { floorY: number; minY: number; viewport?: BalloonViewport; visible?: VisibleBand },
): number[] {
  const visible = m.visible;
  if (!visible) {
    return layoutBalloons(
      items.map((it) => ({ anchorY: Math.max(m.floorY, it.anchorY), height: it.height })),
      gap,
      m.viewport,
    );
  }
  const onScreen = items.map((it) => it.anchorBottom > visible.top && it.anchorY < visible.bottom);
  const result = new Array<number>(items.length);

  const stacked: Array<{ anchorY: number; height: number }> = [];
  const stackedIndex: number[] = [];
  for (const [i, it] of items.entries()) {
    if (!onScreen[i]) continue;
    stacked.push({ anchorY: Math.max(m.floorY, it.anchorY), height: it.height });
    stackedIndex.push(i);
  }
  const ys = layoutBalloons(stacked, gap, m.viewport);
  for (const [n, i] of stackedIndex.entries()) result[i] = ys[n] as number;

  for (const [i, it] of items.entries()) {
    if (onScreen[i]) continue;
    const y = Math.max(m.minY, it.anchorY);
    // Clear of the band in the direction its own text lies. `min`/`max` and
    // not an assignment: a card already well outside stays where its text is.
    // Near the top of a document there is no room above the fold, so the
    // answer is negative — above the document itself, where the scroller
    // clips it. The caller must not clamp it back to zero: that put a sliver
    // of the card on screen beside text it does not mark.
    result[i] =
      it.anchorBottom <= visible.top
        ? Math.min(y, visible.top - it.height - gap)
        : Math.max(y, visible.bottom + gap);
  }
  return result;
}
