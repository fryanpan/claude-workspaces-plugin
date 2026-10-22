import { describe, expect, it } from 'bun:test';
import type { Footprint } from '../src/memory-footprint.ts';
import {
  HEAP_TYPES_COST_MULTIPLE,
  HEAP_TYPES_EVERY_MS,
  type HeapTypeCounts,
  MEMORY_PRINT_MAX_GAP_MS,
  MemoryLog,
  type MemoryLogStats,
  RequestTally,
  printReason,
  routeFamily,
} from '../src/memory-log.ts';

function baseStats(over: Partial<MemoryLogStats> = {}): MemoryLogStats {
  return {
    rssMb: 150,
    residentDocs: 2600,
    bindings: 580,
    activeBindings: 12,
    awareness: 3,
    timers: 9,
    activations: [],
    activationsTotal: 0,
    ...over,
  };
}

/** A sampler on a hand-driven clock and footprint, collecting what it writes. */
function rig() {
  let now = 1_000_000;
  let mb = 200;
  let stats = baseStats();
  let heapBytes = 96 * 1024 * 1024;
  let types: HeapTypeCounts | null = { string: 900, Object: 400 };
  let perf = 0;
  let censusMs = 12;
  const lines: string[] = [];
  const log = new MemoryLog({
    stats: () => stats,
    readFootprint: (): Footprint => ({
      footprintMb: mb,
      peakMb: Math.max(mb, 250),
      residentMb: 150,
    }),
    now: () => now,
    write: (l) => lines.push(l),
    readHeapBytes: () => heapBytes,
    readHeapTypes: () => {
      perf += censusMs;
      return types;
    },
    perfNow: () => perf,
  });
  return {
    log,
    lines,
    advance: (ms: number) => {
      now += ms;
    },
    setMb: (v: number) => {
      mb = v;
    },
    setStats: (s: MemoryLogStats) => {
      stats = s;
    },
    setHeap: (mbHeap: number) => {
      heapBytes = mbHeap * 1024 * 1024;
    },
    setTypes: (t: HeapTypeCounts | null) => {
      types = t;
    },
    setCensusMs: (ms: number) => {
      censusMs = ms;
    },
  };
}

describe('route families', () => {
  it('collapses ids by position after a collection noun', () => {
    expect(routeFamily('GET', '/api/workspaces/w-DRa7Bg/docs/plan-harborlight/threads')).toBe(
      'GET:/api/workspaces/:id/docs/:id/threads',
    );
    expect(routeFamily('POST', '/y/riverbend')).toBe('POST:/y/:id');
  });

  it('collapses ids by shape where no collection names them', () => {
    expect(routeFamily('GET', '/app/board-3f9a.js')).toBe('GET:/app/:id');
    expect(routeFamily('GET', '/widget/Saltmarsh')).toBe('GET:/widget/:id');
    expect(routeFamily('GET', '/')).toBe('GET:/');
  });

  it('keeps one family per handler however many ids pass through it', () => {
    const tally = new RequestTally();
    for (let i = 0; i < 40; i++) tally.note('GET', `/api/workspaces/w-${i}/tasks`);
    tally.note('GET', '/api/workspaces/w-1/docs/d-9/threads');
    expect(tally.take()).toEqual({
      total: 41,
      families: [
        { family: 'GET:/api/workspaces/:id/tasks', count: 40 },
        { family: 'GET:/api/workspaces/:id/docs/:id/threads', count: 1 },
      ],
    });
    expect(tally.take()).toEqual({ total: 0, families: [] });
  });

  it('holds a bounded number of families and counts the rest as other', () => {
    const tally = new RequestTally();
    const words = 'abcdefghijklmnopqrstuvwxyz';
    for (let i = 0; i < 100; i++)
      tally.note('GET', `/x/${words[i % 26]}${words[Math.floor(i / 26)]}`);
    const { total, families } = tally.take();
    expect(total).toBe(100);
    expect(families.length).toBe(65);
    expect(families.find((f) => f.family === 'other')?.count).toBe(36);
  });
});

describe('print decision', () => {
  it('prints the first sample, a 64 MB move either way, and a five-minute gap', () => {
    expect(printReason(null, 0, 100)).toBe('first');
    expect(printReason({ atMs: 0, mb: 100 }, 30_000, 164)).toBeNull();
    expect(printReason({ atMs: 0, mb: 100 }, 30_000, 165)).toBe('delta');
    expect(printReason({ atMs: 0, mb: 500 }, 30_000, 435)).toBe('delta');
    expect(printReason({ atMs: 0, mb: 100 }, MEMORY_PRINT_MAX_GAP_MS - 1, 120)).toBeNull();
    expect(printReason({ atMs: 0, mb: 100 }, MEMORY_PRINT_MAX_GAP_MS, 120)).toBe('interval');
  });

  it('prints twelve lines over a calm hour of 30-second samples', () => {
    const r = rig();
    for (let i = 0; i < 120; i++) {
      r.log.sample();
      r.advance(30_000);
    }
    expect(r.lines.length).toBe(12);
  });

  it('catches a burst on the sample it happens and measures from the last printed line', () => {
    const r = rig();
    r.log.sample();
    r.advance(30_000);
    r.setMb(240);
    expect(r.log.sample()).toBeNull();
    r.advance(30_000);
    r.setMb(900);
    const line = r.log.sample();
    expect(line).toContain('reason=delta');
    expect(line).toContain('window=60s');
    expect(line).toContain('footprint=900MB');
  });
});

describe('the line', () => {
  it('keeps the old fields first and adds what the window did', () => {
    const r = rig();
    r.setStats(
      baseStats({ activations: [{ tag: 'routes/docs.ts:120', count: 40 }], activationsTotal: 40 }),
    );
    r.log.sample();
    r.log.requests.note('GET', '/api/workspaces/w-1/tasks');
    r.log.requests.note('GET', '/api/workspaces/w-2/tasks');
    r.log.requests.note('POST', '/api/workspaces/w-1/docs/d-1/threads');
    r.setStats(
      baseStats({
        activations: [
          { tag: 'routes/docs.ts:120', count: 45 },
          { tag: 'mcp-watch.ts:88', count: 30 },
        ],
        activationsTotal: 75,
      }),
    );
    r.setMb(400);
    r.advance(30_000);
    expect(r.log.sample()).toBe(
      '[doc-store] mem rss=150MB residentDocs=2600 bindings=580 activeBindings=12 awareness=3 ' +
        'timers=9 top=routes/docs.ts:120x45 footprint=400MB peak=400MB reason=delta window=30s ' +
        'windowTop=mcp-watch.ts:88+30 activations=+35 requests=3 ' +
        'routes=GET:/api/workspaces/:id/tasks*2,POST:/api/workspaces/:id/docs/:id/threads*1 ' +
        'heap=96MB',
    );
  });

  it('says footprint was unavailable and still prints when the reader has nothing', () => {
    const lines: string[] = [];
    const log = new MemoryLog({
      stats: () => baseStats(),
      readFootprint: () => null,
      now: () => 0,
      write: (l) => lines.push(l),
    });
    log.sample();
    expect(lines[0]).toContain(' footprint=unavailable reason=first ');
    expect(lines[0]).toContain(' routes=none');
  });

  it('never throws out of a sample when stats does', () => {
    const log = new MemoryLog({
      stats: () => {
        throw new Error('boom');
      },
      readFootprint: () => null,
      now: () => 0,
      write: () => {},
    });
    expect(log.sample()).toBeNull();
  });
});

describe('the heap', () => {
  it('prints the live heap on every line', () => {
    const r = rig();
    expect(r.log.sample()).toContain(' heap=96MB ');
    r.setHeap(1700);
    r.setMb(2200);
    r.advance(30_000);
    expect(r.log.sample()).toEndWith(' heap=1700MB');
  });

  it('takes the type census on the first line and then once per census interval', () => {
    const r = rig();
    const first = r.log.sample();
    expect(first).toEndWith(' heap=96MB heapTypes=string:900,Object:400 heapStatsMs=12');
    r.setTypes({ string: 950, Object: 380, Map: 5000, Structure: 1 });
    r.advance(MEMORY_PRINT_MAX_GAP_MS);
    expect(r.log.sample()).toEndWith(' heap=96MB');
    r.advance(HEAP_TYPES_EVERY_MS - MEMORY_PRINT_MAX_GAP_MS);
    expect(r.log.sample()).toEndWith(
      ' heap=96MB heapTypes=Map:5000+5000,string:950+50,Object:380-20,Structure:1+1 ' +
        'heapGrowth=Map:+5000,string:+50,Structure:+1 heapStatsMs=12',
    );
  });

  it('names the five commonest types and the three biggest growers', () => {
    const r = rig();
    r.setTypes({ a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 });
    expect(r.log.sample()).toContain(' heapTypes=f:6,e:5,d:4,c:3,b:2 ');
    r.setTypes({ a: 101, b: 2, c: 3, d: 4, e: 5, f: 6, g: 50 });
    r.advance(HEAP_TYPES_EVERY_MS);
    const line = r.log.sample() ?? '';
    expect(line).toContain(' heapTypes=a:101+100,g:50+50,f:6+0,e:5+0,d:4+0 ');
    expect(line).toContain(' heapGrowth=a:+100,g:+50 ');
  });

  it('waits longer after a census that blocked for longer', () => {
    const r = rig();
    r.setCensusMs(900);
    expect(r.log.sample()).toContain(' heapStatsMs=900');
    const waitMs = 900 * HEAP_TYPES_COST_MULTIPLE;
    expect(waitMs).toBeGreaterThan(HEAP_TYPES_EVERY_MS);
    r.advance(waitMs - 1);
    expect(r.log.sample()).toEndWith(' heap=96MB');
    r.advance(1);
    r.setMb(400);
    expect(r.log.sample()).toContain(' heapTypes=');
  });

  it('says none grew when nothing did', () => {
    const r = rig();
    r.log.sample();
    r.setTypes({ string: 800, Object: 400 });
    r.advance(HEAP_TYPES_EVERY_MS);
    expect(r.log.sample()).toContain(' heapGrowth=none ');
  });

  it('still prints the line when the heap readers fail', () => {
    const lines: string[] = [];
    const log = new MemoryLog({
      stats: () => baseStats(),
      readFootprint: () => null,
      now: () => 0,
      write: (l) => lines.push(l),
      readHeapBytes: () => {
        throw new Error('no heap');
      },
      readHeapTypes: () => {
        throw new Error('no census');
      },
    });
    expect(log.sample()).toEndWith(' heap=unavailable');
  });

  it('reads the real heap and census under Bun by default', () => {
    const lines: string[] = [];
    const log = new MemoryLog({
      stats: () => baseStats(),
      readFootprint: () => null,
      now: () => 0,
      write: (l) => lines.push(l),
    });
    const line = log.sample() ?? '';
    expect(line).toMatch(/ heap=\d+MB heapTypes=(\w+:\d+,){4}\w+:\d+ heapStatsMs=\d+$/);
    expect(line).toContain('Object:');
  });
});
