import { describe, expect, it } from 'bun:test';
import type { Footprint } from '../src/memory-footprint.ts';
import {
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
        'routes=GET:/api/workspaces/:id/tasks*2,POST:/api/workspaces/:id/docs/:id/threads*1',
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
