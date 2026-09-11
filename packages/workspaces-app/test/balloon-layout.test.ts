import { describe, expect, it } from 'vitest';
import { foldWithStrips, layoutBalloons, placeCards } from '../src/redline/balloon-layout.ts';

describe('layoutBalloons', () => {
  it('returns an empty array for an empty list', () => {
    expect(layoutBalloons([], 8)).toEqual([]);
  });

  it('places a single balloon at its own anchor', () => {
    expect(layoutBalloons([{ anchorY: 100, height: 40 }], 8)).toEqual([100]);
  });

  it('leaves non-overlapping balloons at their anchors', () => {
    const items = [
      { anchorY: 0, height: 20 },
      { anchorY: 100, height: 20 },
      { anchorY: 200, height: 20 },
    ];
    expect(layoutBalloons(items, 8)).toEqual([0, 100, 200]);
  });

  it('pushes a dense overlap chain down by height + gap each step', () => {
    // Each wants y=0, height 30, gap 10 -> stacks at 0, 40, 80.
    const items = [
      { anchorY: 0, height: 30 },
      { anchorY: 0, height: 30 },
      { anchorY: 0, height: 30 },
    ];
    expect(layoutBalloons(items, 10)).toEqual([0, 40, 80]);
  });

  it('keeps the returned array index-aligned with the input, not sorted order', () => {
    // Input given out of anchor order; output[i] must be the y for input item i.
    const items = [
      { anchorY: 100, height: 20 }, // index 0
      { anchorY: 0, height: 20 }, // index 1 (earliest anchor)
      { anchorY: 50, height: 20 }, // index 2
    ];
    const result = layoutBalloons(items, 5);
    // Sorted by anchorY: item1(0) -> 0, item2(50) -> 50, item0(100) -> 100 (no overlap, gap=5 not needed)
    expect(result[1]).toBe(0);
    expect(result[2]).toBe(50);
    expect(result[0]).toBe(100);
  });

  it('resolves an out-of-order overlap chain with minimal displacement', () => {
    // Two balloons both anchored near 0 but item 0 comes second in anchor order.
    const items = [
      { anchorY: 10, height: 20 }, // index 0, sorts second
      { anchorY: 0, height: 20 }, // index 1, sorts first
    ];
    const result = layoutBalloons(items, 5);
    // index1 (anchor 0) -> 0; index0 (anchor 10) must clear index1's bottom+gap = 25
    expect(result[1]).toBe(0);
    expect(result[0]).toBe(25);
  });

  it('treats zero-height items as needing only the gap to separate', () => {
    const items = [
      { anchorY: 0, height: 0 },
      { anchorY: 0, height: 0 },
    ];
    expect(layoutBalloons(items, 4)).toEqual([0, 4]);
  });

  it('handles negative anchorY, keeping relative order and never floating above the first anchor', () => {
    const items = [
      { anchorY: -50, height: 10 },
      { anchorY: -45, height: 10 },
    ];
    const result = layoutBalloons(items, 5);
    expect(result[0]).toBe(-50);
    expect(result[1]).toBe(-35); // -50 + 10 + 5
  });

  it('never places any balloon above the anchor of the earliest-anchored item', () => {
    const items = [
      { anchorY: 5, height: 10 },
      { anchorY: 5, height: 10 },
    ];
    const result = layoutBalloons(items, 3);
    expect(Math.min(...result)).toBeGreaterThanOrEqual(5);
  });

  it('is stable for exact ties, preserving input order among equal anchors', () => {
    const items = [
      { anchorY: 0, height: 10 }, // index 0
      { anchorY: 0, height: 10 }, // index 1
      { anchorY: 0, height: 10 }, // index 2
    ];
    const result = layoutBalloons(items, 2);
    // Stable sort on ties: index0 stays first in stacking order.
    expect(result[0]).toBe(0);
    expect(result[1]).toBe(12);
    expect(result[2]).toBe(24);
  });
});

describe('layoutBalloons — fit-to-viewport shift-up', () => {
  const vp = { top: 0, bottom: 800 };

  it('shifts a balloon up so its bottom meets the viewport bottom', () => {
    expect(layoutBalloons([{ anchorY: 600, height: 560 }], 8, vp)).toEqual([240]);
  });

  it('shifts by exactly the overflow, not more', () => {
    expect(layoutBalloons([{ anchorY: 600, height: 300 }], 8, vp)).toEqual([500]);
  });

  it('leaves a fitting balloon at its anchor', () => {
    expect(layoutBalloons([{ anchorY: 100, height: 560 }], 8, vp)).toEqual([100]);
  });

  it('cascades: the balloon above yields room for a shifted lower one', () => {
    const items = [
      { anchorY: 300, height: 300 },
      { anchorY: 620, height: 300 },
    ];
    // Lower fits at 800 - 300 = 500; upper must clear 500 - gap - height = 192.
    expect(layoutBalloons(items, 8, vp)).toEqual([192, 500]);
  });

  it('leaves balloons anchored below the viewport bottom at their anchors', () => {
    expect(layoutBalloons([{ anchorY: 900, height: 560 }], 8, vp)).toEqual([900]);
  });

  it('re-relaxes the push-down after a shift frees room above', () => {
    // Without the shift, the below-fold balloon is pushed to 600+560+8 = 1168;
    // once the first balloon lifts to 240 the second belongs back at its anchor.
    const items = [
      { anchorY: 600, height: 560 },
      { anchorY: 900, height: 100 },
    ];
    expect(layoutBalloons(items, 8, vp)).toEqual([240, 900]);
  });

  it('never lifts a balloon above the viewport top; leftover overflow pushes down', () => {
    // 500 + 8 + 500 cannot fit in an 800px viewport: the first floors at the
    // viewport top and the second keeps the gap, overflowing minimally.
    const items = [
      { anchorY: 100, height: 500 },
      { anchorY: 350, height: 500 },
    ];
    expect(layoutBalloons(items, 8, vp)).toEqual([0, 508]);
  });

  it('does not move a balloon already above the viewport top', () => {
    const scrolled = { top: 400, bottom: 1200 };
    expect(layoutBalloons([{ anchorY: 200, height: 100 }], 8, scrolled)).toEqual([200]);
  });

  it('stays index-aligned with unsorted input under a viewport', () => {
    const items = [
      { anchorY: 600, height: 560 }, // index 0, sorts second, needs the lift
      { anchorY: 100, height: 100 }, // index 1, sorts first, fits
    ];
    const result = layoutBalloons(items, 8, vp);
    expect(result[1]).toBe(100);
    expect(result[0]).toBe(240);
  });

  it('behaves exactly as before when no viewport is given', () => {
    const items = [
      { anchorY: 600, height: 560 },
      { anchorY: 900, height: 100 },
    ];
    expect(layoutBalloons(items, 8)).toEqual([600, 1168]);
  });
});

describe('layoutBalloons — the band the new-content strips reserve', () => {
  // The strips and the seated dock are drawn over the column, so the caller
  // pulls `bottom` up by what they cover and keeps the true fold in
  // `visibleBottom`. No card may come to rest in that band.
  const reserved = { top: 40, bottom: 700, visibleBottom: 800 };

  it('lifts a card anchored in the reserved band clear of the strip', () => {
    // At the anchor its bottom would be 760, under the strip that starts at
    // 700; it lifts to 700 - 200.
    expect(layoutBalloons([{ anchorY: 560, height: 200 }], 8, reserved)).toEqual([500]);
  });

  it('lifts a card anchored BELOW the reserved bottom but still on screen', () => {
    // 760 is past the reserved bottom and inside the fold: the old rule read
    // it as off-screen content and left it sitting under the strip.
    expect(layoutBalloons([{ anchorY: 760, height: 100 }], 8, reserved)).toEqual([600]);
  });

  it('still leaves a card anchored past the true fold at its anchor', () => {
    expect(layoutBalloons([{ anchorY: 900, height: 100 }], 8, reserved)).toEqual([900]);
  });
});

describe('foldWithStrips', () => {
  const m = { scrollTop: 1000, clientHeight: 800, gap: 8, minY: 0 };

  it('pulls the fit-to-fold ceiling up by the bottom strip, keeping the true fold', () => {
    const r = foldWithStrips({ ...m, band: { top: 0, bottom: 120 } });
    expect(r.viewport.bottom).toBe(1672);
    expect(r.viewport.visibleBottom).toBe(1792);
  });

  it('floors the anchors below the top strip, which the lift alone cannot do', () => {
    // The lift never moves a card already above the viewport top, so the top
    // band is reserved by raising the floor every anchor is clamped to.
    const r = foldWithStrips({ ...m, band: { top: 60, bottom: 0 } });
    expect(r.floorY).toBe(1060);
    expect(
      layoutBalloons([{ anchorY: Math.max(r.floorY, 1010), height: 100 }], 8, r.viewport),
    ).toEqual([1060]);
  });

  it('keeps the toggle clearance when it is the lower bound', () => {
    expect(foldWithStrips({ ...m, minY: 1200, band: { top: 10, bottom: 0 } }).floorY).toBe(1200);
  });

  it('reserves nothing at an empty band', () => {
    const r = foldWithStrips({ ...m, band: { top: 0, bottom: 0 } });
    expect(r.floorY).toBe(0);
    expect(r.viewport.bottom).toBe(r.viewport.visibleBottom);
  });
});

describe('placeCards', () => {
  // The reader is 4000px down a long meeting doc, watching a transcript grow
  // at the foot, and the "N above" strip covers the top 60px of the column.
  const scrollTop = 4000;
  const clientHeight = 800;
  const visible = { top: scrollTop, bottom: scrollTop + clientHeight };
  const { floorY, viewport } = foldWithStrips({
    scrollTop,
    clientHeight,
    gap: 8,
    minY: 0,
    band: { top: 60, bottom: 0 },
  });
  const at = (anchorY: number, height = 100) => ({
    anchorY,
    anchorBottom: anchorY + 20,
    height,
  });
  const place = (items: ReturnType<typeof at>[]) =>
    placeCards(items, 8, { floorY, minY: 0, viewport, visible });
  const paints = (y: number, height = 100): boolean =>
    y + height > visible.top && y < visible.bottom;

  it('leaves a card whose text is far above the fold at its own anchor', () => {
    // The floor is 4060. Before this function that is where all three landed,
    // stacked in the visible column beside nothing.
    expect(place([at(120), at(300), at(900)])).toEqual([120, 300, 900]);
  });

  it('paints nothing in the band the reader can see when no text there is marked', () => {
    for (const y of place([at(120), at(300), at(900)])) expect(paints(y)).toBe(false);
  });

  it('pushes a card whose text ends just above the fold clear of the band', () => {
    // Its anchor is off screen by 10px; its own 100px body would reach 90px
    // into the column. A card the reader can see is a claim about the text
    // beside it, and there is no text beside it here.
    const [y] = place([at(scrollTop - 30)]);
    expect(paints(y as number)).toBe(false);
    expect(y).toBe(visible.top - 108);
  });

  it('pushes a card whose text starts just below the fold clear of the band', () => {
    const [y] = place([at(visible.bottom + 5)]);
    expect(paints(y as number)).toBe(false);
    expect(y).toBe(visible.bottom + 8);
  });

  it('floors a card whose text IS on screen under the top strip, as before', () => {
    // The rule the fold exists for, unchanged: nothing comes to rest under
    // the strip. 4010 is on screen and above the 4060 floor.
    expect(place([at(4010)])).toEqual([4060]);
  });

  it('stacks on-screen cards against each other and not against off-screen ones', () => {
    // Four cards far above the fold used to push the on-screen one down the
    // column; now they take no part in its stack.
    const ys = place([at(100), at(200), at(300), at(400), at(4300)]);
    expect(ys[4]).toBe(4300);
  });

  it('treats every card as on screen when nothing could be measured', () => {
    // happy-dom, or a hidden pane: `visible` is absent and the column behaves
    // exactly as it did before the fold was a question.
    expect(placeCards([at(120), at(300)], 8, { floorY, minY: 0, viewport })).toEqual([4060, 4168]);
  });

  it('keeps the returned array index-aligned with the input', () => {
    // Mixed on- and off-screen, given out of anchor order.
    const ys = place([at(4300), at(120), at(4100)]);
    expect(ys[1]).toBe(120);
    expect(ys[0]).toBeGreaterThanOrEqual(4300);
    expect(ys[2]).toBe(4100);
  });
});
