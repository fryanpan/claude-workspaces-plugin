import { describe, expect, it } from 'bun:test';
import { SLICE_BUDGET_MS, timeSlice } from '../src/event-loop.ts';

/**
 * The clock is injected everywhere in this module precisely so these cases
 * cost no wall-clock time: the blocks under test are measured in seconds, and
 * a suite that waited them out would be the slowest file in the run for no
 * added confidence. Nothing here asserts on a real duration.
 */
function fakeClock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe('timeSlice', () => {
  it('does not yield while the budget is intact', async () => {
    const clock = fakeClock();
    const slice = timeSlice(50, clock.now);
    for (let i = 0; i < 100; i++) await slice.yieldIfDue();
    expect(slice.yields()).toBe(0);
  });

  it('yields once the budget is spent, and starts a fresh budget after', async () => {
    const clock = fakeClock();
    const slice = timeSlice(50, clock.now);
    clock.advance(50);
    await slice.yieldIfDue();
    expect(slice.yields()).toBe(1);
    // Budget restarts from the yield, so the next item does not yield again.
    await slice.yieldIfDue();
    expect(slice.yields()).toBe(1);
    clock.advance(50);
    await slice.yieldIfDue();
    expect(slice.yields()).toBe(2);
  });

  it('actually hands the loop back, so a pending macrotask runs before it returns', async () => {
    const clock = fakeClock();
    const slice = timeSlice(10, clock.now);
    const order: string[] = [];
    // Queued before the yield; a microtask-only "yield" would not let it run.
    setImmediate(() => order.push('timer'));
    clock.advance(10);
    await slice.yieldIfDue();
    order.push('after-yield');
    expect(order).toEqual(['timer', 'after-yield']);
  });

  it('defaults to the documented budget', async () => {
    const clock = fakeClock();
    const slice = timeSlice(undefined, clock.now);
    clock.advance(SLICE_BUDGET_MS - 1);
    await slice.yieldIfDue();
    expect(slice.yields()).toBe(0);
    clock.advance(1);
    await slice.yieldIfDue();
    expect(slice.yields()).toBe(1);
  });
});
