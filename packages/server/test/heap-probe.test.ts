/**
 * The block line's GC and heap clause: a block says whether a collection ran
 * inside it and what the heap held, and the heap walk that answers the
 * second question can never run often enough, or on a heap big enough, to
 * become a block of its own.
 */
import { describe, expect, it } from 'bun:test';
import { LoopLagMonitor } from '../src/event-loop.ts';
import { HeapProbe, type HeapStatsLike, heapClause } from '../src/heap-probe.ts';
import { waitFor } from './wait-for.ts';

function fakeClock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
}

const MB = 1024 * 1024;

/** A heap of fifteen object types, so "top ten" has five to leave out. */
function fakeStats(): HeapStatsLike {
  const objectTypeCounts: Record<string, number> = {};
  for (let i = 0; i < 15; i++) objectTypeCounts[`Type${i}`] = (i + 1) * 1000;
  return { heapSize: 600 * MB, heapCapacity: 700 * MB, objectCount: 120_000, objectTypeCounts };
}

describe('HeapProbe in the block line', () => {
  it('a real block with a collection inside it names the GC, the heap and its commonest types', async () => {
    const lines: string[] = [];
    const m = new LoopLagMonitor({ periodMs: 20, thresholdMs: 100, log: (l) => lines.push(l) });
    m.start();
    try {
      // Step into a later job than the one that armed the sentinel at
      // construction, then hold the loop with a collection inside the hold.
      await new Promise((r) => setImmediate(r));
      const until = performance.now() + 250;
      Bun.gc(true);
      while (performance.now() < until) {}
      const line = await waitFor(() => lines.find((l) => l.includes('[loop] blocked')), {
        describe: 'a block line',
      });
      expect(line).toContain('a GC ran during it');
      expect(line).toMatch(/heap \d+MB of \d+MB, \S+ objects, top: \S+ \S+/);
      expect(line).toMatch(/\(walk \d+ms\)$/);
    } finally {
      m.stop();
    }
  });

  it('walks the heap at most once a minute, however many blocks arrive', () => {
    const clock = fakeClock();
    let walks = 0;
    const heap = new HeapProbe({
      now: clock.now,
      stats: () => {
        walks++;
        return fakeStats();
      },
      heapBytes: () => 100 * MB,
    });
    const lines: string[] = [];
    const m = new LoopLagMonitor({
      periodMs: 250,
      thresholdMs: 1000,
      now: clock.now,
      log: (l) => lines.push(l),
      heap,
    });
    for (const gap of [3_000, 10_000, 20_000]) {
      clock.advance(gap);
      m.tick();
    }
    expect(walks).toBe(1);
    expect(lines[1]).toContain('heap walk skipped (one walk a minute)');
    clock.advance(60_000);
    m.tick();
    expect(walks).toBe(2);
    expect(lines[3]).toContain('heap 600MB of 700MB, 120k objects');
  });

  it('skips the walk on a heap whose size predicts it would take longer than the budget', () => {
    let walks = 0;
    const heap = new HeapProbe({
      stats: () => {
        walks++;
        return fakeStats();
      },
      heapBytes: () => 2048 * MB,
    });
    const reading = heap.read(0);
    expect(walks).toBe(0);
    expect(reading).toMatchObject({ kind: 'skipped', reason: 'cost' });
    expect(heapClause(false, reading)).toContain('heap walk skipped (would take ~819ms on 2048MB)');
  });

  it('learns the walk rate from the last walk, so a slow machine stops walking a heap it cannot afford', () => {
    const clock = fakeClock();
    let walks = 0;
    const heap = new HeapProbe({
      now: clock.now,
      minIntervalMs: 0,
      stats: () => {
        walks++;
        clock.advance(280); // 280ms for 600MB: under the budget, but only just
        return fakeStats();
      },
      heapBytes: () => 650 * MB,
    });
    // 650MB at the starting rate is 260ms: walked.
    expect(heap.read(0).kind).toBe('read');
    // At the learned rate, 650MB is ~303ms: skipped.
    expect(heap.read(1).kind).toBe('skipped');
    expect(walks).toBe(1);
  });

  it('prints the ten commonest types, largest first, as counts only', () => {
    const heap = new HeapProbe({ stats: fakeStats, heapBytes: () => 10 * MB });
    const reading = heap.read(0);
    if (reading.kind !== 'read') throw new Error('expected a walk');
    expect(reading.top.map(([n]) => n)).toEqual(
      Array.from({ length: 10 }, (_, i) => `Type${14 - i}`),
    );
    expect(heapClause(true, reading)).toContain('top: Type14 15k, Type13 14k');
  });

  it('says plainly when no collection ran, which rules the collector out', () => {
    const heap = new HeapProbe({ stats: null, heapBytes: null });
    heap.arm();
    expect(heapClause(false, heap.read(0))).toBe(
      'no GC ran during it, so the time was JavaScript or the OS; heap walk skipped (not available here)',
    );
  });

  it('the sentinel reports a collection that ran since it was armed', async () => {
    const heap = new HeapProbe({ stats: null, heapBytes: null });
    expect(heap.gcSinceArm()).toBeNull();
    heap.arm();
    // A WeakRef's target lives to the end of the job that made it, as the
    // monitor's does: the next tick is a later job.
    await new Promise((r) => setImmediate(r));
    Bun.gc(true);
    expect(heap.gcSinceArm()).toBe(true);
  });
});
