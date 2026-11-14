/**
 * The DocStateStore contract, run against both backends: disk (the `.ydoc`
 * files every earlier server wrote) and memory. A later backend joins the
 * `backends` table and has to pass the same cases.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as Y from 'yjs';
import { DiskDocStateStore } from '../src/doc-state/disk.ts';
import { MemoryDocStateStore } from '../src/doc-state/memory.ts';
import type { DocStateStore } from '../src/doc-state/store.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'cw-doc-state-'));
  dirs.push(d);
  return d;
}

const backends: { name: string; make: () => DocStateStore }[] = [
  { name: 'disk', make: () => new DiskDocStateStore(tempDir()) },
  { name: 'memory', make: () => new MemoryDocStateStore() },
];

function stateOf(text: string): Uint8Array {
  const doc = new Y.Doc();
  doc.getText('content').insert(0, text);
  return Y.encodeStateAsUpdate(doc);
}

function textOf(state: Uint8Array | null): string {
  const doc = new Y.Doc();
  if (state) Y.applyUpdate(doc, state);
  return doc.getText('content').toString();
}

for (const { name, make } of backends) {
  describe(`DocStateStore contract: ${name}`, () => {
    it('answers nothing for a doc that was never written', () => {
      const store = make();
      expect(store.has('riverbend')).toBe(false);
      expect(store.read('riverbend')).toBeNull();
      expect(store.savedAt('riverbend')).toBeUndefined();
      expect(store.list()).toEqual([]);
    });

    it('reads back exactly the bytes written, and the last write wins', () => {
      const store = make();
      const first = stateOf('Harborlight');
      store.write('harborlight', first);
      expect(store.read('harborlight')).toEqual(first);
      const second = stateOf('Harborlight, again');
      store.write('harborlight', second);
      expect(store.has('harborlight')).toBe(true);
      expect(textOf(store.read('harborlight'))).toBe('Harborlight, again');
      expect(store.savedAt('harborlight')).toBeNumber();
      expect(store.list()).toEqual(['harborlight']);
    });

    it('keeps what was written when the caller reuses its buffer', () => {
      const store = make();
      const bytes = stateOf('Saltmarsh');
      const copy = bytes.slice();
      store.write('saltmarsh', bytes);
      bytes.fill(0);
      expect(store.read('saltmarsh')).toEqual(copy);
    });

    it('moves state to the archive and back, out of the live list', () => {
      const store = make();
      store.write('riverbend', stateOf('Riverbend'));
      expect(store.move('riverbend', 'live', 'archive')).toBe(true);
      expect(store.has('riverbend')).toBe(false);
      expect(store.has('riverbend', 'archive')).toBe(true);
      expect(store.list()).toEqual([]);
      expect(store.move('riverbend', 'archive', 'live')).toBe(true);
      expect(textOf(store.read('riverbend'))).toBe('Riverbend');
      // Moving a doc that has no state is not a failure.
      expect(store.move('nothing-here', 'live', 'archive')).toBe(true);
    });

    it('stages a delete invisibly, and either restores it or drops it', () => {
      const store = make();
      store.write('alice', stateOf('Alice'));
      store.write('bob', stateOf('Bob'));
      expect(store.stageDelete('alice')).toBe(true);
      expect(store.has('alice')).toBe(false);
      expect(store.read('alice')).toBeNull();
      expect(store.list()).toEqual(['bob']);
      store.unstageDelete('alice');
      expect(textOf(store.read('alice'))).toBe('Alice');

      expect(store.stageDelete('bob')).toBe(true);
      store.dropStaged('bob');
      store.unstageDelete('bob');
      expect(store.has('bob')).toBe(false);
      expect(store.list()).toEqual(['alice']);
    });

    it('removes live state on purpose', () => {
      const store = make();
      store.write('harborlight', stateOf('Harborlight'));
      expect(store.remove('harborlight')).toBe(true);
      expect(store.has('harborlight')).toBe(false);
      expect(store.remove('harborlight')).toBe(true);
    });

    it('keeps the pre-compaction copy once, and never replaces it', () => {
      const store = make();
      const original = stateOf('before compaction');
      expect(store.keepBeforeCompaction('ws:harborlight', original)).toBe('written');
      expect(store.keepBeforeCompaction('ws:harborlight', stateOf('later'))).toBe('exists');
      // The copy is not live state.
      expect(store.has('ws:harborlight')).toBe(false);
      expect(store.list()).toEqual([]);
      expect(store.keptCopyLabel('ws:harborlight')).toContain('ws:harborlight');
    });
  });
}

describe('DiskDocStateStore keeps the file format every earlier server wrote', () => {
  it('is `<dataDir>/<docId>.ydoc` holding exactly the update it was handed', () => {
    const dataDir = tempDir();
    const store = new DiskDocStateStore(dataDir);
    const bytes = stateOf('Harborlight');
    store.write('harborlight', bytes);
    const path = join(dataDir, 'harborlight.ydoc');
    expect(store.pathOf('harborlight')).toBe(path);
    expect(new Uint8Array(readFileSync(path))).toEqual(bytes);
  });

  it('reads a `.ydoc` some other writer put in the data dir', () => {
    const dataDir = tempDir();
    writeFileSync(join(dataDir, 'riverbend.ydoc'), stateOf('Riverbend'));
    const store = new DiskDocStateStore(dataDir);
    expect(store.list()).toEqual(['riverbend']);
    expect(textOf(store.read('riverbend'))).toBe('Riverbend');
  });

  it('archives into `_archive/` and stages a delete as `.deleting`, as before', () => {
    const dataDir = tempDir();
    const store = new DiskDocStateStore(dataDir);
    store.write('alice', stateOf('Alice'));
    store.move('alice', 'live', 'archive');
    expect(existsSync(join(dataDir, '_archive', 'alice.ydoc'))).toBe(true);
    store.move('alice', 'archive', 'live');
    store.stageDelete('alice');
    expect(existsSync(join(dataDir, 'alice.ydoc.deleting'))).toBe(true);
    store.keepBeforeCompaction('bob', stateOf('Bob'));
    expect(existsSync(join(dataDir, 'bob.ydoc.pre-compact'))).toBe(true);
    expect(store.list()).toEqual([]);
  });
});

describe('MemoryDocStateStore', () => {
  it('stamps savedAt from its clock', () => {
    let now = 1_000;
    const store = new MemoryDocStateStore(() => now);
    store.write('harborlight', stateOf('one'));
    expect(store.savedAt('harborlight')).toBe(1_000);
    now = 2_500;
    store.write('harborlight', stateOf('two'));
    expect(store.savedAt('harborlight')).toBe(2_500);
  });

  it('hands back the kept pre-compaction copy', () => {
    const store = new MemoryDocStateStore();
    const original = stateOf('Saltmarsh');
    store.keepBeforeCompaction('ws:saltmarsh', original);
    expect(store.keptCopy('ws:saltmarsh')).toEqual(original);
  });
});
