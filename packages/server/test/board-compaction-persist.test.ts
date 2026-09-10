import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
/**
 * Compaction has to REACH DISK, or it is work the server redoes forever.
 *
 * A board doc is compacted inside `loadFromDisk`, which runs before the
 * doc's update listener is wired — so the rebuild fires no update event and
 * schedules no save. When something else changes the doc soon after (the task
 * projection reasserting a row whose JSON actually differs) a save is
 * scheduled anyway and the compacted bytes ride along, which is why this went
 * unnoticed. When nothing else changes — a quiet board, or a projection that
 * finds every value identical — the compacted state never lands, and the next
 * restart reads the same historical bytes, decodes them, writes the backup
 * that is already there, and rebuilds again. Forever, once per boot, for the
 * price of decoding a multi-megabyte CRDT.
 *
 * Both halves are asserted here, because the second is what makes the first
 * worth having: the state lands, and the boot after it has nothing left to do.
 */
import { initDocMeta } from '@claude-workspaces/core';
import * as Y from 'yjs';
import { COMPACT_FLOOR_BYTES, compactBoardState } from '../src/board-doc-compaction.ts';
import { DocStore } from '../src/doc-store.ts';
import { SseBus } from '../src/sse.ts';
import { createWebhookDispatcher } from '../src/webhooks.ts';
import { waitFor } from './wait-for.ts';

function dir(): string {
  return mkdtempSync(join(tmpdir(), 'cw-compact-persist-'));
}

/**
 * A board doc with a past worth shedding — one transaction per row, which is
 * what fragments the delete set the way months of real board writes do.
 *
 * It carries its `meta` map, and that is not decoration: the store treats a
 * doc whose `meta` has no `docId` as BRAND NEW and force-saves it on the spot,
 * which persists the compaction for a reason a real board doc never gets. A
 * fixture without it tests the creation path wearing a board doc's name.
 */
function churnedBoardBytes(docId: string): Uint8Array {
  const doc = new Y.Doc();
  const tasks = doc.getMap('tasks');
  doc.getMap('workspace').set('name', 'harbor-relay');
  initDocMeta(doc, { docId, type: 'workspace', createdAt: Date.now(), title: 'harbor-relay' });
  for (let pass = 0; pass < 40; pass++) {
    for (let i = 0; i < 300; i++) {
      doc.transact(() => {
        tasks.set(`t-${i}`, { id: `t-${i}`, title: `row ${i}`, pass, blurb: 'x'.repeat(400) });
      });
    }
  }
  return Y.encodeStateAsUpdate(doc);
}

/**
 * The board's `.ydoc` AND its index row.
 *
 * The row matters: a data dir with a `.ydoc` and no index row sends the store
 * down its startup backfill, which hydrates the doc, writes the row and
 * evicts it — and that eviction flushes the compaction to disk for reasons
 * that have nothing to do with the path a real boot takes. A real corpus has
 * the row, so a fixture without one tests the wrong boot and passes.
 */
function seedBoard(dataDir: string, docId: string, bytes: Uint8Array): string {
  const path = join(dataDir, `${docId}.ydoc`);
  writeFileSync(path, bytes);
  writeFileSync(
    join(dataDir, `${docId}.index.json`),
    JSON.stringify({
      v: 1,
      meta: { docId, type: 'workspace', createdAt: Date.now(), title: 'harbor-relay' },
      threads: { open: 0, total: 0 },
    }),
  );
  return path;
}

function store(dataDir: string): DocStore {
  return new DocStore({
    dataDir,
    sse: new SseBus(),
    webhooks: createWebhookDispatcher({ onLog: () => {} }),
  });
}

describe('a compacted board doc is persisted', () => {
  it('reaches disk when the compaction is the only thing that changed', async () => {
    const d = dir();
    const docId = 'ws:w-test';
    const path = join(d, `${docId}.ydoc`);
    const original = churnedBoardBytes(docId);
    expect(original.byteLength).toBeGreaterThan(COMPACT_FLOOR_BYTES);
    seedBoard(d, docId, original);

    // A bare store: no task projection, nothing else touching the doc. That
    // absence is the whole test — with any other write in flight a save gets
    // scheduled for its own reasons and carries the rebuild with it.
    store(d).get(docId);

    await waitFor(() => statSync(path).size < original.byteLength, {
      describe: 'the compacted board doc to be written over the historical one',
    });
    // Not merely smaller: what landed is a doc with no past left in it.
    expect(compactBoardState(new Uint8Array(readFileSync(path))).compacted).toBe(false);
  });

  it('leaves the next boot nothing to compact', async () => {
    const d = dir();
    const docId = 'ws:w-test';
    const path = join(d, `${docId}.ydoc`);
    const original = churnedBoardBytes(docId);
    seedBoard(d, docId, original);
    store(d).get(docId);
    await waitFor(() => statSync(path).size < original.byteLength, {
      describe: 'the first boot to persist its compacted state',
    });

    // The positive control on the second boot: what it is about to read is
    // the COMPACTED file, not the historical one. Without this the assertion
    // below would also pass if the first boot had persisted nothing and the
    // second had simply been handed an already-small doc.
    const onDisk = new Uint8Array(readFileSync(path));
    expect(onDisk.byteLength).toBeLessThan(original.byteLength);
    expect(compactBoardState(onDisk).compacted).toBe(false);

    // The second boot, on the same directory.
    const second = store(d).get(docId);
    expect(second).not.toBeNull();
    // Same board, and no rebuild: a doc that had been decoded and compacted
    // again would carry a fresh set of clientIDs. These are the ones that
    // were on disk.
    const fromDisk = new Y.Doc();
    Y.applyUpdate(fromDisk, onDisk);
    expect(second?.ydoc.getMap('tasks').size).toBe(fromDisk.getMap('tasks').size);
    expect([...Y.decodeStateVector(Y.encodeStateVector(second!.ydoc)).keys()].sort()).toEqual(
      [...Y.decodeStateVector(Y.encodeStateVector(fromDisk)).keys()].sort(),
    );
  });
});
