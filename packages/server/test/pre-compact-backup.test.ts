/**
 * The pre-compaction backup, driven rather than inspected.
 *
 * Two properties are the whole reason the file exists, and both are asserted
 * by doing the thing and looking at the disk: the backup is complete before a
 * compacted `.ydoc` can be saved over the original, and a second compaction
 * cannot replace it with already-compacted bytes.
 *
 * The second one is the dangerous one. A backup that overwrites itself looks
 * exactly like a backup that works — same file, same name, right timestamp —
 * right up until someone needs the pre-compaction bytes and finds a copy of
 * the compacted ones.
 */
import { describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as Y from 'yjs';
import { COMPACT_FLOOR_BYTES, compactBoardState } from '../src/board-doc-compaction.ts';
import { DocStore } from '../src/doc-store.ts';
import { type WriteFn, preCompactPath, writePreCompactBackup } from '../src/pre-compact-backup.ts';
import { SseBus } from '../src/sse.ts';
import { createWebhookDispatcher } from '../src/webhooks.ts';

/** Byte-for-byte, without tripping over `Uint8Array<ArrayBufferLike>` vs
 *  `<ArrayBuffer>`. Reports the length too, so a failure says how far off. */
function sameBytes(actual: Uint8Array, expected: Uint8Array): void {
  expect(actual.byteLength).toBe(expected.byteLength);
  expect(Buffer.compare(Buffer.from(actual), Buffer.from(expected))).toBe(0);
}

function dir(): string {
  return mkdtempSync(join(tmpdir(), 'cw-precompact-'));
}

/** A board doc big and churned enough that compaction actually takes it —
 *  one transaction per row, which is what fragments the delete set. */
function churnedBoardBytes(): Uint8Array {
  const doc = new Y.Doc();
  const tasks = doc.getMap('tasks');
  doc.getMap('workspace').set('name', 'harbor-relay');
  for (let pass = 0; pass < 40; pass++) {
    for (let i = 0; i < 300; i++) {
      doc.transact(() => {
        tasks.set(`t-${i}`, { id: `t-${i}`, title: `row ${i}`, pass, blurb: 'x'.repeat(400) });
      });
    }
  }
  return Y.encodeStateAsUpdate(doc);
}

describe('the pre-compaction backup', () => {
  it('holds the original bytes, whole, once written', () => {
    const d = dir();
    const path = join(d, 'ws:w-test.ydoc');
    const bytes = churnedBoardBytes();
    expect(writePreCompactBackup(path, bytes)).toBe('written');
    // Complete at return: the size on disk is the size handed in. This is
    // what a save arriving immediately afterwards would find.
    expect(statSync(preCompactPath(path)).size).toBe(bytes.byteLength);
    sameBytes(new Uint8Array(readFileSync(preCompactPath(path))), bytes);
  });

  it('writes every byte even when the syscall keeps coming up short', () => {
    const d = dir();
    const path = join(d, 'ws:w-test.ydoc');
    const bytes = churnedBoardBytes();
    // A filesystem that never writes more than 4 KB at a time. Real ones do
    // not do this on demand, which is why the seam exists at all.
    let calls = 0;
    const shortWrite: WriteFn = (fd, buf, offset, length) => {
      calls++;
      return writeSync(fd, buf, offset, Math.min(length, 4096));
    };

    expect(writePreCompactBackup(path, bytes, shortWrite)).toBe('written');
    // The control on the fixture: if one call had satisfied the whole buffer
    // the loop would never have been exercised and this would pass vacuously.
    expect(calls).toBeGreaterThan(1);
    sameBytes(new Uint8Array(readFileSync(preCompactPath(path))), bytes);
  });

  it('leaves no truncated file behind when the write cannot finish', () => {
    const d = dir();
    const path = join(d, 'ws:w-test.ydoc');
    const bytes = churnedBoardBytes();
    // Writes the first chunk, then reports zero forever — a write that
    // cannot make progress rather than one that is merely short.
    let done = false;
    const stalls: WriteFn = (fd, buf, offset, length) => {
      if (done) return 0;
      done = true;
      return writeSync(fd, buf, offset, Math.min(length, 4096));
    };

    expect(writePreCompactBackup(path, bytes, stalls)).toBe('failed');
    // Nothing is left claiming to be the backup, so a later attempt can still
    // write a real one rather than being refused by `wx` forever.
    expect(existsSync(preCompactPath(path))).toBe(false);
  });

  it('refuses to overwrite, so a second compaction cannot eat the only copy', () => {
    const d = dir();
    const path = join(d, 'ws:w-test.ydoc');
    const original = churnedBoardBytes();
    const compacted = compactBoardState(original).update;
    // The guard is only meaningful if these differ — a positive control, so
    // this cannot pass by the two being the same bytes.
    expect(compacted.byteLength).toBeLessThan(original.byteLength);

    expect(writePreCompactBackup(path, original)).toBe('written');
    // A later restart compacts again and offers the already-compacted bytes.
    expect(writePreCompactBackup(path, compacted)).toBe('exists');
    // The pre-compaction bytes are still what is on disk.
    sameBytes(new Uint8Array(readFileSync(preCompactPath(path))), original);
  });

  it('is on disk before a compacted doc is ever saved over the original', () => {
    const d = dir();
    const docId = 'ws:w-test';
    const path = join(d, `${docId}.ydoc`);
    const original = churnedBoardBytes();
    expect(original.byteLength).toBeGreaterThan(COMPACT_FLOOR_BYTES);
    writeFileSync(path, original);

    // Loading the doc is what compacts it. Nothing has saved yet — saves are
    // debounced — so this is the window a crash would land in.
    const store = new DocStore({
      dataDir: d,
      sse: new SseBus(),
      webhooks: createWebhookDispatcher({ onLog: () => {} }),
    });
    store.get(docId);

    // Whatever has happened to the `.ydoc` by now — the store may already
    // have saved the rebuild over it — the pre-compaction bytes are on disk
    // and complete. Paired with the next test (a doc whose backup cannot be
    // written is never compacted), that is the ordering guarantee: a
    // compacted state only ever exists once its predecessor was kept.
    sameBytes(new Uint8Array(readFileSync(preCompactPath(path))), original);
  });

  it('leaves the doc uncompacted rather than compacting with no backup', () => {
    const d = dir();
    const docId = 'ws:w-test';
    const path = join(d, `${docId}.ydoc`);
    const original = churnedBoardBytes();
    writeFileSync(path, original);
    // A zero-length file where the backup wants to be — what a crash
    // mid-write would leave. `EEXIST` alone would call that "already kept".
    writeFileSync(preCompactPath(path), new Uint8Array(0));

    const store = new DocStore({
      dataDir: d,
      sse: new SseBus(),
      webhooks: createWebhookDispatcher({ onLog: () => {} }),
    });
    const doc = store.get(docId);

    // The live doc carries the full original state — every row is still there
    // — rather than a rebuild whose predecessor was never kept.
    const rebuilt = new Y.Doc();
    Y.applyUpdate(rebuilt, original);
    expect(doc?.ydoc.getMap('tasks').size).toBe(rebuilt.getMap('tasks').size);
    // Sized like the original and nothing like a rebuild. Not an equality:
    // opening a store writes an index row or two, so the doc is a few dozen
    // bytes off `original` while still carrying all of its history.
    const compactedSize = compactBoardState(original).update.byteLength;
    expect(Y.encodeStateAsUpdate(doc!.ydoc).byteLength).toBeGreaterThan(compactedSize);
    expect(Y.encodeStateAsUpdate(doc!.ydoc).byteLength).toBeGreaterThanOrEqual(original.byteLength);
  });
});

/**
 * WHICH docs the store compacts, isolated from WHETHER they are compactable.
 *
 * Every doc here is byte-identical and every one would be compacted on its
 * merits — same maps, same churn, same size. Only the id differs. That is
 * deliberate: if these fixtures held prose the shape guard inside
 * `compactBoardState` would refuse them and the test would pass without the
 * id gate existing at all. Naming the same bytes three ways is what makes
 * this a test of the gate rather than of the guard behind it.
 */
describe('only a board doc is compacted', () => {
  const bytes = churnedBoardBytes();

  function loadAs(docId: string): { size: number; backedUp: boolean; rows: number } {
    const d = dir();
    const path = join(d, `${docId}.ydoc`);
    writeFileSync(path, bytes);
    const store = new DocStore({
      dataDir: d,
      sse: new SseBus(),
      webhooks: createWebhookDispatcher({ onLog: () => {} }),
    });
    const doc = store.get(docId);
    return {
      size: Y.encodeStateAsUpdate(doc!.ydoc).byteLength,
      backedUp: existsSync(preCompactPath(path)),
      rows: doc!.ydoc.getMap('tasks').size,
    };
  }

  const expectedRows = (() => {
    const d = new Y.Doc();
    Y.applyUpdate(d, bytes);
    return d.getMap('tasks').size;
  })();

  it('compacts a ws: doc — the positive control the rest is measured against', () => {
    const board = loadAs('ws:w-test');
    expect(board.size).toBeLessThan(bytes.byteLength);
    expect(board.backedUp).toBe(true);
    expect(board.rows).toBe(expectedRows);
  });

  for (const docId of ['task:t-body', 'd-bound', 'meeting-notes-2026-01-01']) {
    it(`leaves ${docId.split(/[:-]/)[0]} docs alone, same bytes and all`, () => {
      const other = loadAs(docId);
      // Not rebuilt: it still carries the history a board doc would have shed.
      expect(other.size).toBeGreaterThanOrEqual(bytes.byteLength);
      // And nothing was written beside it — the backup only exists for docs
      // this actually compacts.
      expect(other.backedUp).toBe(false);
      expect(other.rows).toBe(expectedRows);
    });
  }
});
