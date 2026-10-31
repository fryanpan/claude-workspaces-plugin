/**
 * What the heap looked like when the loop came back from a block, so the
 * `[loop] blocked` line can say whether a garbage collection was involved and
 * what the heap was full of.
 *
 * On 31 October prod's loop blocked eight times in one minute for 2.3–3.3 s
 * each, with 1.9–2.7 s of CPU inside every block and no page-ins. That rules
 * out swapping and leaves two causes, our JavaScript or the collector, and the
 * line could not tell them apart. A large-board fixture reproduced none of it
 * (no handler held the loop for more than 25 ms), so the next block in prod
 * has to name its own cause.
 *
 * Two readings, because JavaScriptCore exposes no GC timings to JavaScript:
 * `bun:jsc` has no collection count, no pause duration, and Bun's
 * `PerformanceObserver` offers no `gc` entries. So:
 *
 *   - **Did a collection run during the block?** A sentinel: every on-time
 *     tick drops a fresh object and keeps only a `WeakRef` to it. Only the
 *     collector clears a `WeakRef`, so finding it cleared at the next tick
 *     means at least one collection ran in between. It cannot say how long
 *     the collection took, and a busy block that allocates will trigger
 *     small ones, so "ran" is weak evidence. "None ran" is strong: the time
 *     was spent in JavaScript (or the OS, which the CPU figure separates).
 *   - **What is the heap made of?** `heapStats()`: size, capacity, object
 *     count, and the ten commonest object types, as counts only. It walks the
 *     whole heap, and that costs time: measured at 18 ms on a 50 MB heap,
 *     80 ms on 200 MB and 200–225 ms on 600 MB (10.7 million objects). So it
 *     runs at most once a minute, and not at all when the last measured rate
 *     says it would take longer than {@link HEAP_STATS_BUDGET_MS}.
 */

import { createRequire } from 'node:module';

/** The subset of `bun:jsc`'s `heapStats()` this module reads. */
export interface HeapStatsLike {
  heapSize: number;
  heapCapacity: number;
  objectCount: number;
  objectTypeCounts: Record<string, number>;
}

export type HeapReading =
  | {
      kind: 'read';
      heapMb: number;
      capacityMb: number;
      objects: number;
      /** The ten commonest object types, largest first. Names and counts only. */
      top: Array<[string, number]>;
      /** How long `heapStats()` itself took. */
      tookMs: number;
    }
  | {
      kind: 'skipped';
      reason: 'rate' | 'cost' | 'unavailable';
      predictedMs?: number;
      heapMb?: number;
    };

/** At most one heap walk per this window. */
export const HEAP_STATS_MIN_INTERVAL_MS = 60_000;
/** A heap walk predicted to take longer than this is skipped. */
export const HEAP_STATS_BUDGET_MS = 300;
/** The walk's cost per heap megabyte before any walk has been measured here.
 *  Measured at 0.33–0.37 ms/MB on this Mac; rounded up. */
const INITIAL_MS_PER_MB = 0.4;
const TOP_TYPES = 10;

export interface HeapProbeOptions {
  /** Monotonic clock, for the timing of the walk itself. */
  now?: () => number;
  minIntervalMs?: number;
  budgetMs?: number;
  /** Injected in tests; defaults to `bun:jsc` under Bun and nothing elsewhere. */
  stats?: (() => HeapStatsLike) | null;
  heapBytes?: (() => number) | null;
}

type Jsc = { heapStats: () => HeapStatsLike; heapSize: () => number };

/** `bun:jsc` under Bun; null on Node, where the client suites import this. */
function loadJsc(): Jsc | null {
  if (typeof (globalThis as { Bun?: unknown }).Bun === 'undefined') return null;
  return createRequire(import.meta.url)('bun:jsc') as Jsc;
}

export class HeapProbe {
  private readonly now: () => number;
  private readonly minIntervalMs: number;
  private readonly budgetMs: number;
  private readonly stats: (() => HeapStatsLike) | null;
  private readonly heapBytes: (() => number) | null;
  private sentinel: WeakRef<object> | null = null;
  private lastReadAt: number | null = null;
  private msPerMb = INITIAL_MS_PER_MB;

  constructor(opts: HeapProbeOptions = {}) {
    this.now = opts.now ?? (() => performance.now());
    this.minIntervalMs = opts.minIntervalMs ?? HEAP_STATS_MIN_INTERVAL_MS;
    this.budgetMs = opts.budgetMs ?? HEAP_STATS_BUDGET_MS;
    const jsc = opts.stats === undefined || opts.heapBytes === undefined ? loadJsc() : null;
    this.stats = opts.stats === undefined ? (jsc?.heapStats ?? null) : opts.stats;
    this.heapBytes = opts.heapBytes === undefined ? (jsc?.heapSize ?? null) : opts.heapBytes;
  }

  /** Drop a fresh sentinel. Called on every tick, so the next tick asks
   *  about exactly the interval between them. */
  arm(): void {
    this.sentinel = new WeakRef({});
  }

  /** Whether a collection cleared the sentinel since `arm`. Null before the
   *  first `arm`, when there is no interval to ask about. */
  gcSinceArm(): boolean | null {
    if (!this.sentinel) return null;
    return this.sentinel.deref() === undefined;
  }

  /** One heap walk, unless the window or the predicted cost forbids it. */
  read(at: number): HeapReading {
    if (!this.stats) return { kind: 'skipped', reason: 'unavailable' };
    if (this.lastReadAt !== null && at - this.lastReadAt < this.minIntervalMs) {
      return { kind: 'skipped', reason: 'rate' };
    }
    const heapMb = this.heapBytes ? this.heapBytes() / 1024 / 1024 : 0;
    const predictedMs = heapMb * this.msPerMb;
    if (predictedMs > this.budgetMs) {
      return { kind: 'skipped', reason: 'cost', predictedMs, heapMb };
    }
    this.lastReadAt = at;
    const start = this.now();
    const s = this.stats();
    const tookMs = this.now() - start;
    const statsMb = s.heapSize / 1024 / 1024;
    // Learn the rate from this walk, so the next prediction is this
    // machine's, not the constant's.
    if (statsMb > 1 && tookMs > 0) this.msPerMb = tookMs / statsMb;
    const top = Object.entries(s.objectTypeCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, TOP_TYPES);
    return {
      kind: 'read',
      heapMb: statsMb,
      capacityMb: s.heapCapacity / 1024 / 1024,
      objects: s.objectCount,
      top,
      tookMs,
    };
  }
}

/** A count as a reader takes it in: 10.7M, 312k, 840. */
function shortCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

/** The block line's GC and heap clause. */
export function heapClause(gcRan: boolean | null, reading: HeapReading): string {
  const gc =
    gcRan === null
      ? 'gc unknown'
      : gcRan
        ? 'a GC ran during it'
        : 'no GC ran during it, so the time was JavaScript or the OS';
  if (reading.kind === 'skipped') {
    const why =
      reading.reason === 'rate'
        ? 'one walk a minute'
        : reading.reason === 'cost'
          ? `would take ~${Math.round(reading.predictedMs ?? 0)}ms on ${Math.round(reading.heapMb ?? 0)}MB`
          : 'not available here';
    return `${gc}; heap walk skipped (${why})`;
  }
  const top = reading.top.map(([name, n]) => `${name} ${shortCount(n)}`).join(', ');
  return (
    `${gc}; heap ${Math.round(reading.heapMb)}MB of ${Math.round(reading.capacityMb)}MB, ` +
    `${shortCount(reading.objects)} objects, top: ${top} (walk ${Math.round(reading.tookMs)}ms)`
  );
}
