/**
 * Why each resident doc is still in memory, as `DocStore.stats()` reports it
 * and the `[doc-store] mem` line prints it.
 *
 * The resident count alone said 4,254 and nothing about which rule held
 * them. Each doc is counted once, under the first reason that keeps it: a
 * hold the sweep never overrides (a socket, a recording, a wedge, a write in
 * flight, a person's fresh edit), then the window it is still inside, and
 * `past-window` for a doc the next sweep will release.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DocStore } from '../src/doc-store.ts';
import { SseBus } from '../src/sse.ts';
import { createWebhookDispatcher } from '../src/webhooks.ts';

const DAY = 24 * 60 * 60 * 1000;

describe('resident docs by what holds them', () => {
  let dataDir: string;
  let docStore: DocStore;
  let clock: number;
  let recording: Set<string>;

  beforeEach(() => {
    clock = Date.now();
    recording = new Set();
    dataDir = mkdtempSync(join(tmpdir(), 'resident-by-'));
    docStore = new DocStore({
      dataDir,
      sse: new SseBus(),
      webhooks: createWebhookDispatcher({ onLog: () => {} }),
      now: () => clock,
      isRecording: (docId) => recording.has(docId),
    });
  });
  afterEach(() => {
    docStore.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  function make(docId: string): void {
    docStore.getOrCreate(docId, { type: 'markdown', title: docId });
    expect(docStore.docEdits.setDocContent(docId, `# ${docId}\n\nfirst line\n`).ok).toBe(true);
  }

  it('counts every resident doc once, under the first reason that keeps it', async () => {
    for (const id of [
      'harborlight-open',
      'riverbend-recording',
      'saltmarsh-pending',
      'alice-edited',
      'bob-person',
      'harborlight-fresh',
      'riverbend-idle',
    ]) {
      make(id);
    }
    docStore.flush();
    docStore.notePersonLeft('bob-person');
    clock += 2 * DAY;

    (docStore.peek('harborlight-open') as { conns: Set<unknown> }).conns.add({ data: {} });
    recording.add('riverbend-recording');
    expect(
      docStore.docEdits.findAndReplace('saltmarsh-pending', {
        find: 'first line',
        replace: 'typed',
      }).ok,
    ).toBe(true);
    (docStore.peek('alice-edited') as { lastHumanEditAt?: number }).lastHumanEditAt = clock;
    expect(docStore.get('harborlight-fresh')).toBeDefined();

    const stats = docStore.stats();
    expect(stats.residentBy).toEqual({
      connected: 1,
      recording: 1,
      'sync-error': 0,
      'pending-write': 1,
      'human-edit': 1,
      'short-window': 1,
      'person-window': 1,
      'past-window': 1,
    });
    const total = Object.values(stats.residentBy).reduce((a, b) => a + b, 0);
    expect(total).toBe(stats.residentDocs);

    // Control: `past-window` is what the sweep takes, and only that.
    (docStore.peek('harborlight-open') as { conns: Set<unknown> }).conns.clear();
    expect(await docStore.evictIdleDocs()).toEqual(['harborlight-open', 'riverbend-idle']);
  });
});
