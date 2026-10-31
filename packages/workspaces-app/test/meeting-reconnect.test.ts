import { describe, expect, it } from 'vitest';
import { RECONNECT_DELAYS_MS, createReconnectPlan } from '../src/meeting-reconnect.ts';

/**
 * A meeting whose socket dropped is not a meeting that ended: how long to
 * wait between attempts and when to stop waiting.
 */

describe('the reconnect policy', () => {
  it('backs off, then holds at the cap', () => {
    const plan = createReconnectPlan({ now: () => 0 });
    const waits = [1, 2, 3, 4, 5, 6, 7].map(() => {
      const step = plan.dropped();
      return step.kind === 'retry' ? step.delayMs : -1;
    });
    // Doubling, then the last gap repeats: a server that is down is not
    // hammered, and one that comes back is found within a cap rather than a
    // minute later.
    expect(waits).toEqual([1_000, 2_000, 4_000, 8_000, 15_000, 15_000, 15_000]);
    expect(RECONNECT_DELAYS_MS[RECONNECT_DELAYS_MS.length - 1]).toBe(15_000);
  });

  it('counts the window from the FIRST drop, not the last attempt', () => {
    const clock = { at: 0 };
    const plan = createReconnectPlan({ now: () => clock.at, windowMs: 10_000 });
    expect(plan.dropped().kind).toBe('retry');
    clock.at = 9_999;
    expect(plan.dropped().kind).toBe('retry');
    clock.at = 10_000;
    // A window that restarted with every failure would never end.
    expect(plan.dropped().kind).toBe('give-up');
  });

  it('gives the whole window back once a connection lands', () => {
    const clock = { at: 0 };
    const plan = createReconnectPlan({ now: () => clock.at, windowMs: 10_000 });
    plan.dropped();
    plan.dropped();
    expect(plan.attempts()).toBe(2);
    plan.succeeded();
    expect(plan.attempts()).toBe(0);
    clock.at = 60_000;
    const step = plan.dropped();
    // A meeting that survived one outage is not partway through a deadline
    // set by the last one.
    expect(step).toEqual({ kind: 'retry', delayMs: 1_000, attempt: 1 });
  });
});
