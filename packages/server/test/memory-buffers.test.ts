/**
 * The memory line's buffer counters: where bytes sit when the heap grows in
 * buffers rather than objects. Each counter is driven through the object
 * that owns it — the sampler, the SSE bus, the doc store — and the line is
 * checked to carry ids and byte counts, never a byte of a payload.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DocStore } from '../src/doc-store.ts';
import { type BufferCounters, MemoryLog } from '../src/memory-log.ts';
import { REPLAY_MAX_AGE_MS, SseBus } from '../src/sse.ts';
import { createWebhookDispatcher } from '../src/webhooks.ts';

const stats = () => ({
  rssMb: 100,
  residentDocs: 1,
  bindings: 0,
  activeBindings: 0,
  awareness: 0,
  timers: 0,
  activations: [],
  activationsTotal: 0,
});

function sampleWith(readBuffers: () => BufferCounters): string | null {
  const log = new MemoryLog({
    stats,
    readFootprint: () => null,
    write: () => {},
    readHeapBytes: () => 0,
    readHeapTypes: () => null,
    readBuffers,
  });
  return log.sample();
}

describe('the buffer fields on the memory line', () => {
  it('prints the process totals, the fullest socket and the fullest replay channel', () => {
    const line = sampleWith(() => ({
      arrayBuffersBytes: 300 * 1024 * 1024,
      externalBytes: 12 * 1024 * 1024,
      sockets: { sumBytes: 5000, maxBytes: 4096, maxDocId: 'harborlight' },
      largestReplay: { channel: 'riverbend', bytes: 81920 },
    }));
    expect(line).toContain(
      'arrayBuffers=300MB external=12MB wsBuffered=5000B wsBufferedMax=4096B@harborlight ' +
        'replayMax=81920B@riverbend',
    );
  });

  it('says none when no socket has anything queued and no channel holds a frame', () => {
    const line = sampleWith(() => ({
      arrayBuffersBytes: 0,
      externalBytes: 0,
      sockets: { sumBytes: 0, maxBytes: 0, maxDocId: null },
      largestReplay: null,
    }));
    expect(line).toContain('wsBuffered=0B wsBufferedMax=none replayMax=none');
  });

  it('still prints the line, marked unavailable, when the counters throw', () => {
    const line = sampleWith(() => {
      throw new Error('no counters');
    });
    expect(line).toContain('[doc-store] mem rss=');
    expect(line).toContain('buffers=unavailable');
  });
});

describe('SseBus.largestReplay', () => {
  it('names the channel holding the most bytes, and null when nothing is buffered', () => {
    let now = 1_000_000;
    const bus = new SseBus(() => now);
    expect(bus.largestReplay()).toBeNull();

    bus.broadcast('d-small', { event: 'thread.created', body: 'x'.repeat(100) } as never);
    bus.broadcast('d-big', { event: 'thread.created', body: 'y'.repeat(5000) } as never);
    bus.broadcast('d-big', { event: 'thread.created', body: 'y'.repeat(5000) } as never);
    const best = bus.largestReplay();
    expect(best?.channel).toBe('d-big');
    expect(best?.bytes).toBeGreaterThan(10_000);

    // Aged out of the buffer, the bytes are gone from the count too.
    now += REPLAY_MAX_AGE_MS + 61_000;
    bus.broadcast('d-small', { event: 'thread.created', body: 'z' } as never);
    expect(bus.largestReplay()?.channel).toBe('d-small');
  });
});

describe('DocStore.bufferCounters', () => {
  let dataDir: string;
  let store: DocStore;
  let sse: SseBus;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'mem-buffers-'));
    sse = new SseBus();
    store = new DocStore({
      dataDir,
      sse,
      webhooks: createWebhookDispatcher({ onLog: () => {} }),
    });
  });
  afterEach(() => {
    store.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  /** A socket that reports `queued` bytes waiting to be sent. */
  const socket = (queued: number) => ({ data: {}, getBufferedAmount: () => queued });
  const conns = (docId: string) => (store.peek(docId) as unknown as { conns: Set<unknown> }).conns;

  it('sums what every open doc socket has queued and names the doc of the fullest', () => {
    store.getOrCreate('harborlight', { type: 'markdown', title: 'a' });
    store.getOrCreate('saltmarsh', { type: 'markdown', title: 'b' });
    conns('harborlight').add(socket(1000));
    conns('saltmarsh').add(socket(250_000));
    conns('saltmarsh').add(socket(50));
    sse.broadcast('saltmarsh', { event: 'thread.created', body: 'secret words' } as never);

    const c = store.bufferCounters();
    expect(c.sockets).toEqual({ sumBytes: 251_050, maxBytes: 250_000, maxDocId: 'saltmarsh' });
    expect(c.largestReplay?.channel).toBe('saltmarsh');
    expect(c.arrayBuffersBytes).toBeGreaterThanOrEqual(0);
    expect(c.externalBytes).toBeGreaterThanOrEqual(0);
    // Ids and counts only: the buffered payload's words never reach the counters.
    expect(JSON.stringify(c)).not.toContain('secret words');
  });

  it('names no doc when nothing is queued', () => {
    store.getOrCreate('riverbend', { type: 'markdown', title: 'c' });
    conns('riverbend').add(socket(0));
    expect(store.bufferCounters().sockets).toEqual({ sumBytes: 0, maxBytes: 0, maxDocId: null });
  });
});
