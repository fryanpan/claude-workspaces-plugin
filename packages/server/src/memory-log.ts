import { createRequire } from 'node:module';
import { backgroundPasses, readHeap } from './event-loop.ts';
/**
 * The `[doc-store] mem` line: what this process costs, sampled often enough
 * to catch a burst, and what the server did in the window that cost it.
 *
 * It began as one line per five minutes of RSS and doc counts. On
 * 2026-09-22 prod reached a 3,437 MB footprint while that line read between
 * 114 and 881 MB RSS, so the peak was either shorter than five minutes or in
 * pages RSS does not count, and the line could not name a cause. Now:
 *
 * - it samples every 30 s and reads the footprint macOS counts
 *   (`memory-footprint.ts`), falling back to RSS where that is unavailable;
 * - it prints when the footprint moved more than 64 MB since the last
 *   printed line, or five minutes passed, so a calm hour is twelve lines and
 *   a burst is caught inside one sample;
 * - each printed line names the requests served since the previous one, by
 *   route family, and the busiest doc-store activator in that window;
 * - each printed line carries the JS heap (`heap=`), so heap growth can be
 *   told from native growth. On 2026-10-21 prod's footprint climbed
 *   0.35 GB/h with resident docs flat, and the only heap readings were on
 *   `[loop] blocked` lines, which stopped once the loop stopped blocking;
 * - every `HEAP_TYPES_EVERY_MS` a printed line also carries the heap's five
 *   commonest object types and the three that grew most since the last
 *   census. `heapStats()` walks every live cell on the main thread: measured
 *   on Bun 1.3.10 at 27 ms for 1.5 M objects (54 MB heap), 78 ms for 3.2 M
 *   (114 MB) and 187 ms for 12.4 M (417 MB). That is too much to pay every
 *   30 s, and a 2 GB heap could pay a second, so the census waits at least
 *   `HEAP_TYPES_COST_MULTIPLE` times its own last cost before it runs again,
 *   and the line prints what it cost (`heapStatsMs=`).
 *
 * The fields the old line carried come first, in the old order, so a grep
 * written against it still reads. Cost: one syscall per sample, a Map
 * increment per request, and `DocStore.stats()` only when a line prints.
 */
import { type Footprint, createFootprintReader } from './memory-footprint.ts';

export const MEMORY_SAMPLE_MS = 30_000;
export const MEMORY_PRINT_MAX_GAP_MS = 5 * 60_000;
export const MEMORY_PRINT_DELTA_MB = 64;
/** Distinct route families held per window; the rest count as `other`. */
const ROUTE_FAMILY_CAP = 64;
/** Route families named on one line, busiest first. */
const ROUTES_PRINTED = 8;
/** How often a printed line also takes the heap's object-type census. */
export const HEAP_TYPES_EVERY_MS = 10 * 60_000;
/** A census that blocked for 1 s waits 2,000 s: at most 0.05% of the loop. */
export const HEAP_TYPES_COST_MULTIPLE = 2000;
/** Object types named on a census line, commonest first. */
const HEAP_TYPES_PRINTED = 5;
/** Types named as the census's biggest growers. */
const HEAP_GROWERS_PRINTED = 3;

/** Live objects by type, as `bun:jsc` `heapStats().objectTypeCounts` counts them. */
export type HeapTypeCounts = Record<string, number>;

/**
 * The census itself. Resolved lazily and only under Bun, as `readHeap` is;
 * elsewhere there is no census and the line says so.
 */
let heapTypes: (() => HeapTypeCounts | null) | undefined;
function readHeapTypes(): HeapTypeCounts | null {
  if (!heapTypes) {
    if (typeof (globalThis as { Bun?: unknown }).Bun === 'undefined') {
      heapTypes = () => null;
    } else {
      const jsc = createRequire(import.meta.url)('bun:jsc') as {
        heapStats: () => { objectTypeCounts: HeapTypeCounts };
      };
      heapTypes = () => jsc.heapStats().objectTypeCounts;
    }
  }
  return heapTypes();
}

/** A census and what it cost, as the line prints it. */
export interface HeapCensus {
  counts: HeapTypeCounts;
  /** The census before this one, or null for the first. */
  previous: HeapTypeCounts | null;
  costMs: number;
}

/** `heapTypes=`, `heapGrowth=` and `heapStatsMs=`; no value holds a space. */
export function formatHeapCensus(c: HeapCensus): string {
  const delta = (type: string): number => (c.counts[type] ?? 0) - (c.previous?.[type] ?? 0);
  const signed = (n: number): string => (n >= 0 ? `+${n}` : `${n}`);
  const common = Object.entries(c.counts)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, HEAP_TYPES_PRINTED)
    .map(([type, n]) => `${type}:${n}${c.previous ? signed(delta(type)) : ''}`)
    .join(',');
  let out = `heapTypes=${common || 'none'}`;
  if (c.previous) {
    const grew = Object.keys(c.counts)
      .map((type) => ({ type, d: delta(type) }))
      .filter((g) => g.d > 0)
      .sort((a, b) => b.d - a.d || (a.type < b.type ? -1 : 1))
      .slice(0, HEAP_GROWERS_PRINTED)
      .map((g) => `${g.type}:+${g.d}`)
      .join(',');
    out += ` heapGrowth=${grew || 'none'}`;
  }
  return `${out} heapStatsMs=${Math.round(c.costMs)}`;
}

/**
 * Segments that name a collection, so the segment after one is an id:
 * `/api/workspaces/w-1/docs/d-2/threads` → `/api/workspaces/:id/docs/:id/threads`.
 */
const COLLECTIONS = new Set([
  'workspaces',
  'docs',
  'tasks',
  'threads',
  'attachments',
  'agents',
  'agent_anchors',
  'dispatches',
  'meetings',
  'goals',
  'members',
  'mockups',
  'mockup',
  'review-items',
  'suggestions',
  'events',
  'comment-queue',
  'chat-audit',
  'voice-feedback',
  'voice-queue',
  'review',
  'y',
  's',
  'share',
  'projects',
  'mounts',
  'repos',
  'recall',
  'answer',
  'withdraw',
]);

/** A segment that reads as a word rather than an id. */
const LITERAL = /^[a-z][a-z_:-]{0,31}$/;

/**
 * One label for every request that reached the same handler. Ids collapse to
 * `:id` by position (after a collection noun) and by shape (anything with a
 * digit, a capital, a dot or an escape), so a label never carries a doc id, a
 * file name or a person's name, and the set of labels stays small.
 */
export function routeFamily(method: string, pathname: string): string {
  const out: string[] = [];
  let afterCollection = false;
  for (const seg of pathname.split('/')) {
    if (seg === '') continue;
    const isId: boolean = afterCollection || !LITERAL.test(seg);
    out.push(isId ? ':id' : seg);
    afterCollection = !isId && COLLECTIONS.has(seg);
  }
  return `${method}:/${out.join('/')}`;
}

/** Requests counted by route family since the last `take()`. */
export class RequestTally {
  private counts = new Map<string, number>();
  private total = 0;

  note(method: string, pathname: string): void {
    this.total++;
    let family = routeFamily(method, pathname);
    if (!this.counts.has(family) && this.counts.size >= ROUTE_FAMILY_CAP) family = 'other';
    this.counts.set(family, (this.counts.get(family) ?? 0) + 1);
  }

  /** The window's counts, busiest first, and reset for the next window. */
  take(): { total: number; families: { family: string; count: number }[] } {
    const families = [...this.counts.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .map(([family, count]) => ({ family, count }));
    const total = this.total;
    this.counts = new Map();
    this.total = 0;
    return { total, families };
  }
}

/** The part of `DocStore.stats()` the line prints. */
export interface MemoryLogStats {
  rssMb: number;
  residentDocs: number;
  bindings: number;
  activeBindings: number;
  awareness: number;
  timers: number;
  activations: { tag: string; count: number }[];
  activationsTotal: number;
}

export type PrintReason = 'first' | 'delta' | 'interval';

/**
 * Whether this sample prints. The first always does; after that, a move of
 * more than `MEMORY_PRINT_DELTA_MB` in either direction, or
 * `MEMORY_PRINT_MAX_GAP_MS` since the last printed line.
 */
export function printReason(
  last: { atMs: number; mb: number } | null,
  nowMs: number,
  mb: number,
): PrintReason | null {
  if (last === null) return 'first';
  if (Math.abs(mb - last.mb) > MEMORY_PRINT_DELTA_MB) return 'delta';
  if (nowMs - last.atMs >= MEMORY_PRINT_MAX_GAP_MS) return 'interval';
  return null;
}

export interface MemoryLineInput {
  stats: MemoryLogStats;
  footprint: Footprint | null;
  reason: PrintReason;
  windowMs: number;
  /** The activator that promoted the most bindings in this window, if any. */
  windowTop: { tag: string; count: number } | null;
  activationsDelta: number;
  requests: { total: number; families: { family: string; count: number }[] };
  /** The live JS heap, if it could be read. */
  heapMb: number | null;
  /** Present on the lines that took a census. */
  census: HeapCensus | null;
}

/** The line itself. Space-separated `key=value`; no value holds a space. */
export function formatMemoryLine(i: MemoryLineInput): string {
  const s = i.stats;
  const top = s.activations[0];
  const fp = i.footprint;
  const shown = i.requests.families.slice(0, ROUTES_PRINTED);
  const hidden = i.requests.families.length - shown.length;
  const routes = shown.map((f) => `${f.family}*${f.count}`).join(',') || 'none';
  return (
    `[doc-store] mem rss=${s.rssMb}MB residentDocs=${s.residentDocs} bindings=${s.bindings} ` +
    `activeBindings=${s.activeBindings} awareness=${s.awareness} timers=${s.timers} ` +
    `top=${top?.tag ?? 'none'}x${top?.count ?? 0} ` +
    (fp ? `footprint=${fp.footprintMb}MB peak=${fp.peakMb}MB ` : 'footprint=unavailable ') +
    `reason=${i.reason} window=${Math.round(i.windowMs / 1000)}s ` +
    `windowTop=${i.windowTop ? `${i.windowTop.tag}+${i.windowTop.count}` : 'none'} ` +
    `activations=+${i.activationsDelta} requests=${i.requests.total} ` +
    `routes=${routes}${hidden > 0 ? `,+${hidden}more` : ''} ` +
    `heap=${i.heapMb === null ? 'unavailable' : `${i.heapMb}MB`}` +
    (i.census ? ` ${formatHeapCensus(i.census)}` : '')
  );
}

export interface MemoryLogOptions {
  stats: () => MemoryLogStats;
  readFootprint?: () => Footprint | null;
  now?: () => number;
  write?: (line: string) => void;
  sampleMs?: number;
  /** The live JS heap in bytes; `bun:jsc` `heapSize` by default. */
  readHeapBytes?: () => number;
  /** The object-type census; `bun:jsc` `heapStats` by default. */
  readHeapTypes?: () => HeapTypeCounts | null;
  /** The clock the census cost is measured on; `performance.now` by default. */
  perfNow?: () => number;
}

/**
 * The sampler. `sample()` is the whole decision and is what tests drive;
 * `start()` only puts it on an unref'd interval.
 */
export class MemoryLog {
  readonly requests = new RequestTally();
  private readonly readFootprint: () => Footprint | null;
  private readonly now: () => number;
  private readonly write: (line: string) => void;
  private readonly sampleMs: number;
  private readonly readHeapBytes: () => number;
  private readonly readHeapTypes: () => HeapTypeCounts | null;
  private readonly perfNow: () => number;
  private lastCensus: { dueMs: number; counts: HeapTypeCounts } | null = null;
  private last: { atMs: number; mb: number } | null = null;
  private lastActivations = new Map<string, number>();
  private lastActivationsTotal = 0;
  private startedAtMs: number;
  private ticker: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly opts: MemoryLogOptions) {
    this.readFootprint = opts.readFootprint ?? createFootprintReader();
    this.now = opts.now ?? Date.now;
    this.write = opts.write ?? ((line) => console.error(line));
    this.sampleMs = opts.sampleMs ?? MEMORY_SAMPLE_MS;
    this.readHeapBytes = opts.readHeapBytes ?? readHeap;
    this.readHeapTypes = opts.readHeapTypes ?? readHeapTypes;
    this.perfNow = opts.perfNow ?? (() => performance.now());
    this.startedAtMs = this.now();
  }

  get running(): boolean {
    return this.ticker !== null;
  }

  start(): void {
    if (this.ticker) return;
    const timer = setInterval(
      () => backgroundPasses.run('memory-sample', () => this.sample()),
      this.sampleMs,
    );
    timer.unref?.();
    this.ticker = timer;
  }

  stop(): void {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
  }

  /** Take one sample; returns the line it printed, or null. Never throws. */
  sample(): string | null {
    try {
      const nowMs = this.now();
      const footprint = this.readFootprint();
      const mb = footprint?.footprintMb ?? Math.round(process.memoryUsage().rss / 1024 / 1024);
      const reason = printReason(this.last, nowMs, mb);
      if (reason === null) return null;
      const stats = this.opts.stats();
      const line = formatMemoryLine({
        stats,
        footprint,
        reason,
        windowMs: nowMs - (this.last?.atMs ?? this.startedAtMs),
        windowTop: this.takeWindowTop(stats),
        activationsDelta: Math.max(0, stats.activationsTotal - this.lastActivationsTotal),
        requests: this.requests.take(),
        heapMb: this.heapMb(),
        census: this.takeCensus(nowMs),
      });
      this.lastActivationsTotal = stats.activationsTotal;
      this.last = { atMs: nowMs, mb };
      this.write(line);
      return line;
    } catch {
      return null;
    }
  }

  private heapMb(): number | null {
    try {
      return Math.round(this.readHeapBytes() / 1024 / 1024);
    } catch {
      return null;
    }
  }

  /** A census on the first line and then once it falls due, else null. */
  private takeCensus(nowMs: number): HeapCensus | null {
    if (this.lastCensus && nowMs < this.lastCensus.dueMs) return null;
    let counts: HeapTypeCounts | null;
    const t0 = this.perfNow();
    try {
      counts = this.readHeapTypes();
    } catch {
      counts = null;
    }
    const costMs = this.perfNow() - t0;
    if (counts === null) return null;
    const previous = this.lastCensus?.counts ?? null;
    const waitMs = Math.max(HEAP_TYPES_EVERY_MS, costMs * HEAP_TYPES_COST_MULTIPLE);
    this.lastCensus = { dueMs: nowMs + waitMs, counts };
    return { counts, previous, costMs };
  }

  /** The reported tag whose since-boot count grew most since the last line. */
  private takeWindowTop(stats: MemoryLogStats): { tag: string; count: number } | null {
    let best: { tag: string; count: number } | null = null;
    const next = new Map<string, number>();
    for (const { tag, count } of stats.activations) {
      next.set(tag, count);
      const delta = count - (this.lastActivations.get(tag) ?? 0);
      if (delta > 0 && (best === null || delta > best.count)) best = { tag, count: delta };
    }
    this.lastActivations = next;
    return best;
  }
}
