/**
 * Which files each CI client shard runs, and the order each shard starts them
 * in, decided by measured duration rather than by a hash of the path.
 *
 * WHY. Vitest's own `--shard` sorts files by a SHA-1 of their path and cuts
 * the list into equal COUNTS. File cost is nothing like equal: the 39
 * browser-launching files are 6% of the files and 70% of the time, and one of
 * them ran 99s on its own. Measured on run 43605001679 (six shards, 158 files
 * each), the shards' vitest wall clock was 71s, 105s, 124s, 152s, 156s and
 * 182s. The slowest shard is the verdict, so five runners sat idle while one
 * finished. Replaying that run's per-file times through both splits gives a
 * slowest shard of 122s for the hash at ten shards and 72s for this one.
 *
 * WHERE THE TIMES COME FROM. `scripts/vitest-durations.json`, written by
 * `bun run scripts/vitest-durations.ts <run-id>` from a CI run's own logs.
 * A committed table, not a cache: every shard of a run must compute the SAME
 * split, or a file runs twice or not at all, and only a file in the commit is
 * guaranteed to be the same for all of them. A stale table can make the split
 * uneven again; it cannot drop a test, because every file is placed in
 * exactly one shard whatever its weight. A file the table has never seen gets
 * the measured median for its kind (browser-launching or not).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DURATIONS_FILE = join(
  dirname(fileURLToPath(import.meta.url)),
  'vitest-durations.json',
);

/**
 * Seconds each file pays beyond its tests: transform, setup, import and the
 * test environment. Run 43605001679's six shards summed 600s of those across
 * 946 files.
 */
export const PER_FILE_SECONDS = 0.6;

export interface Durations {
  /** Seconds for a file the table has no row for, by kind. */
  unmeasured: { browser: number; other: number };
  /** `<project>:<repo-relative path>` → seconds of test time on CI. */
  seconds: Record<string, number>;
}

const NO_TABLE: Durations = { unmeasured: { browser: 10, other: 0.1 }, seconds: {} };

/** The committed table, or an empty one (every file then weighs its kind's default). */
export function loadDurations(path = DURATIONS_FILE): Durations {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<Durations>;
    if (!raw.unmeasured || !raw.seconds) throw new Error('missing `unmeasured` or `seconds`');
    return { unmeasured: raw.unmeasured, seconds: raw.seconds };
  } catch (err) {
    console.warn(
      `vitest-shard: no usable duration table at ${path} (${String(err)}); shards will be uneven.`,
    );
    return NO_TABLE;
  }
}

/** A file's expected cost in seconds. */
export function weightOf(durations: Durations, key: string, browser: boolean): number {
  const measured = durations.seconds[key];
  const base = measured ?? (browser ? durations.unmeasured.browser : durations.unmeasured.other);
  return base + PER_FILE_SECONDS;
}

interface Ranked<T> {
  item: T;
  key: string;
  weight: number;
}

/** Heaviest first; equal weights by key, so the order never depends on input order. */
function rank<T>(
  items: readonly T[],
  key: (t: T) => string,
  weight: (t: T) => number,
): Ranked<T>[] {
  return items
    .map((item) => ({ item, key: key(item), weight: weight(item) }))
    .sort((a, b) => b.weight - a.weight || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/**
 * The items shard `index` of `count` runs (1-based): heaviest first, each into
 * the shard with the least weight so far, the lowest-numbered on a tie.
 * Every item lands in exactly one shard, and the answer depends only on the
 * set of keys and weights.
 */
export function balancedShard<T>(
  items: readonly T[],
  key: (t: T) => string,
  weight: (t: T) => number,
  index: number,
  count: number,
): T[] {
  if (
    !Number.isInteger(count) ||
    count < 1 ||
    !Number.isInteger(index) ||
    index < 1 ||
    index > count
  ) {
    throw new Error(`shard wants 1 <= index <= count; got ${index}/${count}`);
  }
  const load: number[] = new Array(count).fill(0);
  const mine: T[] = [];
  for (const r of rank(items, key, weight)) {
    let lightest = 0;
    for (let i = 1; i < count; i++) if ((load[i] ?? 0) < (load[lightest] ?? 0)) lightest = i;
    load[lightest] = (load[lightest] ?? 0) + r.weight;
    if (lightest === index - 1) mine.push(r.item);
  }
  return mine;
}

/**
 * Heaviest first, so a long file starts beside the short ones instead of
 * after them. Vitest's default, with no results cache on a fresh runner, is
 * largest FILE first — and the 99s file was 60 lines, so it started last.
 */
export function longestFirst<T>(
  items: readonly T[],
  key: (t: T) => string,
  weight: (t: T) => number,
): T[] {
  return rank(items, key, weight).map((r) => r.item);
}
