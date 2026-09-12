import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BALLOON_ROOM_QUERY,
  applyPlacement,
  balloonMarginVisible,
  cardPlacement,
  inlineCardsVisible,
  resolvePlacement,
} from '../src/card-placement.ts';
import { PHONE, setViewport } from './css-harness.ts';

/**
 * Where comment cards live is a question about ROOM: is there a window wide
 * enough for a 260px column beside the prose, and if not, is there enough for
 * the cards to sit in the flow at all?
 *
 * There used to be a control in the top bar storing a per-device override,
 * and these cases used to be about that override surviving a zoom. The
 * control went with the rest of the bar's furniture; what is left is the
 * width policy, driven here rather than read off a selector.
 */

afterEach(() => {
  document.body.removeAttribute('data-cards');
  setViewport({ width: 1024, height: 768 });
});

describe('resolvePlacement', () => {
  it('puts the cards in the margin when there is room and in the flow when there is not', () => {
    expect(resolvePlacement(true)).toBe('balloon');
    expect(resolvePlacement(false)).toBe('inline');
  });
});

describe('the two surface predicates', () => {
  function widthIs(width: number): void {
    setViewport({ width, height: 820 });
  }

  it('at 1180: balloons, no inline cards', () => {
    widthIs(1180);
    expect(cardPlacement()).toBe('balloon');
    expect(balloonMarginVisible()).toBe(true);
    expect(inlineCardsVisible()).toBe(false);
  });

  it('at 430: inline cards, no margin', () => {
    widthIs(430);
    expect(cardPlacement()).toBe('inline');
    expect(inlineCardsVisible()).toBe(true);
    expect(balloonMarginVisible()).toBe(false);
  });

  it('on a phone the cards are in the flow, not in a squeezed margin', () => {
    setViewport(PHONE);
    expect(balloonMarginVisible()).toBe(false);
    expect(inlineCardsVisible()).toBe(true);
  });

  it('exactly one surface carries the cards at every width', () => {
    // Neither surface and both surfaces are each a way to lose the comments;
    // 1100 and 1101 are the two sides of the only boundary there is.
    expect(BALLOON_ROOM_QUERY).toBe('(min-width: 1101px)');
    for (const width of [430, 900, 1000, 1100, 1101, 1180, 3840]) {
      widthIs(width);
      expect(balloonMarginVisible()).toBe(!inlineCardsVisible());
      expect(cardPlacement()).toBe(width >= 1101 ? 'balloon' : 'inline');
    }
  });
});

describe('publishing the surface to the stylesheet', () => {
  beforeEach(() => {
    setViewport({ width: 1180, height: 820 });
  });

  it('applyPlacement with no argument publishes the surface in force', () => {
    applyPlacement();
    expect(document.body.dataset.cards).toBe('balloon');
  });

  it('publishes `inline` on a phone, where there is no margin to publish', () => {
    setViewport(PHONE);
    applyPlacement();
    expect(document.body.dataset.cards).toBe('inline');
  });
});
