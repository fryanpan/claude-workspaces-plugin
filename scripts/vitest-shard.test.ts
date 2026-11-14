/**
 * The duration-balanced shard split: every file in exactly one shard, the
 * shards close to even, and the same answer whatever order the files arrive in.
 *
 * audit: no-text — the weights are given inline; nothing here reads a source file.
 */
import { describe, expect, it } from 'vitest';
import {
  type Durations,
  PER_FILE_SECONDS,
  balancedShard,
  longestFirst,
  weightOf,
} from './vitest-shard.ts';

const id = (s: string) => s;

/** Every shard of `count`, as lists of names. */
function allShards(names: string[], weight: (n: string) => number, count: number): string[][] {
  return Array.from({ length: count }, (_, i) => balancedShard(names, id, weight, i + 1, count));
}

describe('balancedShard', () => {
  const names = Array.from({ length: 200 }, (_, i) => `f${i}`);
  // A long tail, the shape the client suite has: a few files cost most.
  const weight = (n: string) => {
    const i = Number(n.slice(1));
    return i % 17 === 0 ? 40 + (i % 5) : 0.5 + (i % 3);
  };

  it.each([1, 2, 6, 10, 12])('puts every file in exactly one of %i shards', (count) => {
    const shards = allShards(names, weight, count);
    const placed = shards.flat();
    expect(placed).toHaveLength(names.length);
    expect(new Set(placed)).toEqual(new Set(names));
  });

  it('gives the same split whatever order the files arrive in', () => {
    const reversed = [...names].reverse();
    for (let i = 1; i <= 10; i++) {
      expect(balancedShard(reversed, id, weight, i, 10).sort()).toEqual(
        balancedShard(names, id, weight, i, 10).sort(),
      );
    }
  });

  it('balances by weight, where equal counts would not', () => {
    // Five 50s files and ninety-five 1s files over ten shards. By weight, the
    // light files fill the five shards with no heavy one and nothing passes
    // 50. Any split by count puts ten files in each shard, so a shard holding
    // a heavy file also holds nine light ones: 59.
    const files = Array.from({ length: 100 }, (_, i) => `g${String(i).padStart(3, '0')}`);
    const w = (n: string) => (Number(n.slice(1)) < 5 ? 50 : 1);
    const loads = allShards(files, w, 10).map((s) => s.reduce((t, n) => t + w(n), 0));
    expect(Math.max(...loads)).toBe(50);
  });

  it('refuses a shard outside 1..count', () => {
    expect(() => balancedShard(names, id, weight, 0, 4)).toThrow();
    expect(() => balancedShard(names, id, weight, 5, 4)).toThrow();
  });
});

describe('longestFirst', () => {
  it('orders by weight, then by name, and keeps every item', () => {
    const w: Record<string, number> = { a: 1, b: 9, c: 9, d: 3 };
    expect(longestFirst(['a', 'c', 'd', 'b'], id, (n) => w[n] ?? 0)).toEqual(['b', 'c', 'd', 'a']);
  });
});

describe('weightOf', () => {
  const table: Durations = {
    unmeasured: { browser: 12, other: 0.2 },
    seconds: { 'dom:a.test.ts': 30 },
  };

  it('uses the measured time when the table has the file', () => {
    expect(weightOf(table, 'dom:a.test.ts', false)).toBe(30 + PER_FILE_SECONDS);
  });

  it('falls back to the median of its kind when it does not', () => {
    expect(weightOf(table, 'dom:new.test.ts', true)).toBe(12 + PER_FILE_SECONDS);
    expect(weightOf(table, 'node:new.test.ts', false)).toBe(0.2 + PER_FILE_SECONDS);
  });
});
