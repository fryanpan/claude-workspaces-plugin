import { describe, expect, it } from 'bun:test';
import { InflightRegistry, LoopLagMonitor, SLICE_BUDGET_MS, timeSlice } from '../src/event-loop.ts';

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

describe('LoopLagMonitor', () => {
  it('says nothing when ticks arrive on schedule', () => {
    const clock = fakeClock();
    const lines: string[] = [];
    const m = new LoopLagMonitor({
      periodMs: 250,
      thresholdMs: 1000,
      now: clock.now,
      log: (l) => lines.push(l),
    });
    for (let i = 0; i < 20; i++) {
      clock.advance(250);
      m.tick();
    }
    expect(lines).toEqual([]);
    expect(m.reportCount()).toBe(0);
  });

  it('reports a turn that blocked past the threshold, with the blocked duration', () => {
    const clock = fakeClock();
    const lines: string[] = [];
    const m = new LoopLagMonitor({
      periodMs: 250,
      thresholdMs: 1000,
      now: clock.now,
      stamp: () => 'STAMP',
      log: (l) => lines.push(l),
    });
    // The tick was due 250ms after construction; it arrives 14,500ms later,
    // so the loop was held for 14,250ms.
    clock.advance(14_500);
    m.tick();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('blocked 14250ms');
    expect(m.reportCount()).toBe(1);
  });

  it('stays quiet just under the threshold and reports just over it', () => {
    const clock = fakeClock();
    const lines: string[] = [];
    const m = new LoopLagMonitor({
      periodMs: 100,
      thresholdMs: 1000,
      now: clock.now,
      log: (l) => lines.push(l),
    });
    clock.advance(100 + 999);
    m.tick();
    expect(lines).toHaveLength(0);
    clock.advance(100 + 1000);
    m.tick();
    expect(lines).toHaveLength(1);
  });

  it('names the in-flight requests, oldest first, with how long each has been held', () => {
    const clock = fakeClock();
    const lines: string[] = [];
    const reg = new InflightRegistry(clock.now);
    const m = new LoopLagMonitor({
      periodMs: 250,
      thresholdMs: 1000,
      now: clock.now,
      stamp: () => 'STAMP',
      log: (l) => lines.push(l),
      inflight: () => reg.snapshot(),
    });
    reg.enter({ method: 'POST', url: 'http://x/docs/d-1/suggestions/resolve_all' });
    clock.advance(500);
    reg.enter({ method: 'GET', url: 'http://x/api/deploy' });
    clock.advance(5_000);
    m.tick();

    expect(lines).toHaveLength(1);
    const line = lines[0] ?? '';
    // Oldest first: the resolve_all started 5,500ms ago, the probe 5,000ms.
    const resolveAt = line.indexOf('/docs/d-1/suggestions/resolve_all');
    const deployAt = line.indexOf('/api/deploy');
    expect(resolveAt).toBeGreaterThanOrEqual(0);
    expect(deployAt).toBeGreaterThan(resolveAt);
    expect(line).toContain('POST /docs/d-1/suggestions/resolve_all (5500ms)');
    expect(line).toContain('GET /api/deploy (5000ms)');
  });

  it('calls out an empty in-flight set, because that points away from every handler', () => {
    const clock = fakeClock();
    const lines: string[] = [];
    const m = new LoopLagMonitor({
      periodMs: 250,
      thresholdMs: 1000,
      now: clock.now,
      log: (l) => lines.push(l),
      inflight: () => [],
    });
    clock.advance(9_000);
    m.tick();
    expect(lines[0]).toContain('nothing in flight');
  });

  it('summarises the tail rather than printing every held request', () => {
    const clock = fakeClock();
    const lines: string[] = [];
    const reg = new InflightRegistry(clock.now);
    const m = new LoopLagMonitor({
      periodMs: 250,
      thresholdMs: 1000,
      now: clock.now,
      log: (l) => lines.push(l),
      inflight: () => reg.snapshot(),
    });
    for (let i = 0; i < 9; i++) reg.enter({ method: 'GET', url: `http://x/r/${i}` });
    clock.advance(4_000);
    m.tick();
    expect(lines[0]).toContain('+6 more');
  });

  it('measures each block from the tick that observed it, so one block is reported once', () => {
    const clock = fakeClock();
    const lines: string[] = [];
    const m = new LoopLagMonitor({
      periodMs: 250,
      thresholdMs: 1000,
      now: clock.now,
      log: (l) => lines.push(l),
    });
    clock.advance(12_000);
    m.tick();
    expect(lines).toHaveLength(1);
    // The next tick is on time relative to the one that just ran. A monitor
    // that kept measuring from the ORIGINAL due time would report the same
    // block again on every tick forever.
    clock.advance(250);
    m.tick();
    expect(lines).toHaveLength(1);
  });

  it('start arms a timer that cannot hold the process open, and stop is idempotent', () => {
    const m = new LoopLagMonitor({ periodMs: 10_000, log: () => {} });
    m.start();
    m.start();
    m.stop();
    m.stop();
    expect(m.reportCount()).toBe(0);
  });
});

describe('InflightRegistry', () => {
  it('holds a request until its settle function runs', () => {
    const reg = new InflightRegistry(() => 0);
    const done = reg.enter({ method: 'GET', url: 'http://x/a' });
    expect(reg.size()).toBe(1);
    done();
    expect(reg.size()).toBe(0);
  });

  it('retires only its own entry when the same path is in flight twice', () => {
    const reg = new InflightRegistry(() => 0);
    const first = reg.enter({ method: 'GET', url: 'http://x/same' });
    reg.enter({ method: 'GET', url: 'http://x/same' });
    expect(reg.size()).toBe(2);
    first();
    expect(reg.size()).toBe(1);
  });

  it('records the pathname only, so a query string never reaches a log line', () => {
    const reg = new InflightRegistry(() => 0);
    reg.enter({ method: 'GET', url: 'http://x/workspaces/w-1/home?user=somebody' });
    expect(reg.snapshot()[0]?.path).toBe('/workspaces/w-1/home');
  });

  it('never throws on a url it cannot parse', () => {
    const reg = new InflightRegistry(() => 0);
    expect(() => reg.enter({ method: 'GET', url: 'not a url' })).not.toThrow();
    expect(reg.size()).toBe(1);
  });
});

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
