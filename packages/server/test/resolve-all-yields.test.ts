import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DocStore } from '../src/doc-store.ts';
import { timeSlice } from '../src/event-loop.ts';
import { SseBus } from '../src/sse.ts';
import { createWebhookDispatcher } from '../src/webhooks.ts';

/**
 * The 2026-09-16 wedge, reproduced at the seam that caused it.
 *
 * `POST …/suggestions/resolve_all` held the event loop for 114,650 ms on one
 * doc. Four supervisor health checks timed out inside that window and the
 * supervisor restarted the process; the request after it returned took 553 ms.
 * The handler was synchronous from the route down, so nothing else on the
 * machine could run while it worked.
 *
 * What these cases pin is the property that decides whether a slow request is
 * a slow request or an outage: **something else gets to run while it runs.**
 * They assert ORDER, never elapsed time — a duration assertion would pass on a
 * broken fast path and fail on a loaded runner, and the block being reproduced
 * is two minutes long, which no suite should ever pay.
 *
 * `timeSlice(0)` makes the pass yield after every proposal, so the interleave
 * is a property of the code rather than of how quickly this machine happens to
 * resolve a suggestion.
 */

function makeDocStore(dataDir: string): DocStore {
  return new DocStore({
    dataDir,
    sse: new SseBus(),
    webhooks: createWebhookDispatcher({ onLog: () => {} }),
  });
}

const author = { id: 'agent-1', name: 'Harborlight', color: '#7c5cff' };

/** One paragraph per proposal, so every suggestion lands in its own block. */
function markdownWith(words: string[]): string {
  return `# Title\n\n${words.map((w) => `Para ${w} here.`).join('\n\n')}\n`;
}

describe('resolve_all hands the event loop back while it runs', () => {
  let dataDir: string;
  let docStore: DocStore;
  const words = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'];

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'cw-resolve-yield-'));
    const path = join(dataDir, 'doc.md');
    writeFileSync(path, markdownWith(words));
    docStore = makeDocStore(dataDir);
    docStore.getOrCreate('rg1', { type: 'markdown', sourceUrl: path });
    expect(docStore.attachFile('rg1', path).ok).toBe(true);
    for (const w of words) {
      const made = docStore.createSuggestion('rg1', {
        find: w,
        replace: `${w}-done`,
        author,
      });
      expect(made.ok).toBe(true);
    }
    expect(docStore.listSuggestions('rg1')).toHaveLength(words.length);
  });

  afterEach(() => {
    // Drop the writes this store still owes before the directory goes: a
    // debounced `.ydoc` save landing after the rmSync logs an ENOENT that
    // reads like a failure and is only a teardown race. Nothing here is about
    // persistence.
    docStore.simulateCrash();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('lets work queued before it run BEFORE it finishes — the health check that timed out', async () => {
    const order: string[] = [];
    // Stands in for the supervisor's probe: a macrotask the loop can only
    // reach if the resolve-all lets go. Queued first, so if the pass never
    // yielded this would run after it and the order would be reversed.
    setImmediate(() => order.push('probe-answered'));

    const res = await docStore.resolveAllSuggestions('rg1', { action: 'accept' }, timeSlice(0));
    order.push('resolve-all-returned');

    expect(res).toEqual({ ok: true, resolved: words.length, sids: expect.any(Array) });
    expect(order).toEqual(['probe-answered', 'resolve-all-returned']);
  });

  it('answers repeatedly during the pass, not just once at a yield point', async () => {
    const answered: number[] = [];
    let ticks = 0;
    // Re-arms itself, so it counts how many separate turns the loop got back
    // while the pass ran. One yield would give 1; a pass that never let go
    // would give 0.
    const beat = (): void => {
      ticks++;
      answered.push(ticks);
      if (ticks < words.length) setImmediate(beat);
    };
    setImmediate(beat);

    await docStore.resolveAllSuggestions('rg1', { action: 'accept' }, timeSlice(0));

    expect(answered.length).toBeGreaterThan(1);
  });

  it('resolves every proposal and reports the same shape as before', async () => {
    const res = await docStore.resolveAllSuggestions('rg1', { action: 'accept' }, timeSlice(0));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.resolved).toBe(words.length);
    expect(res.sids).toHaveLength(words.length);
    expect(docStore.listSuggestions('rg1')).toHaveLength(0);
  });

  it('rejecting every proposal restores the original text', async () => {
    const res = await docStore.resolveAllSuggestions('rg1', { action: 'reject' }, timeSlice(0));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.resolved).toBe(words.length);
    expect(docStore.listSuggestions('rg1')).toHaveLength(0);
    const body = docStore.readMarkdownBody('rg1') ?? '';
    for (const w of words) expect(body).toContain(`Para ${w} here.`);
    expect(body).not.toContain('-done');
  });

  it('only one author’s proposals are resolved when authorId is given', async () => {
    const other = { id: 'agent-2', name: 'Riverbend', color: '#00a0a0' };
    const extra = docStore.createSuggestion('rg1', {
      find: 'Title',
      replace: 'Heading',
      author: other,
    });
    expect(extra.ok).toBe(true);

    const res = await docStore.resolveAllSuggestions(
      'rg1',
      { action: 'accept', authorId: other.id },
      timeSlice(0),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.resolved).toBe(1);
    // Everything agent-1 proposed is still pending.
    expect(docStore.listSuggestions('rg1')).toHaveLength(words.length);
  });

  it('a proposal resolved by somebody else mid-pass is skipped, not counted', async () => {
    const pending = docStore.listSuggestions('rg1');
    const victim = pending[0]?.sid ?? '';
    expect(victim).not.toBe('');
    // Resolve one out from under the pass before it starts — the same race a
    // yielding pass now makes reachable from another request.
    expect(docStore.acceptSuggestion('rg1', victim)).toEqual({ ok: true });

    const res = await docStore.resolveAllSuggestions('rg1', { action: 'accept' }, timeSlice(0));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.resolved).toBe(words.length - 1);
    expect(res.sids).not.toContain(victim);
  });
});
