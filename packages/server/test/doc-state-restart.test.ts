/**
 * A doc saved through each storage backend reopens identical after a
 * restart, for each of the four kinds of doc: a markdown doc, a board, a
 * whiteboard and a doc holding component state.
 *
 * "Identical" is the full state vector, the whole re-encoded update byte for
 * byte, and every content root. A restart is a new DocStore over the same
 * backend: the same data dir for disk, the same instance for memory.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as Y from 'yjs';
import { DiskDocStateStore } from '../src/doc-state/disk.ts';
import { MemoryDocStateStore } from '../src/doc-state/memory.ts';
import type { DocStateStore } from '../src/doc-state/store.ts';
import { DocStore } from '../src/doc-store.ts';
import { SseBus } from '../src/sse.ts';
import { createWebhookDispatcher } from '../src/webhooks.ts';
import { DOC_KINDS, viewOf } from './doc-state-docs.ts';

const dirs: string[] = [];
const stores: DocStore[] = [];

afterEach(() => {
  for (const s of stores.splice(0)) s.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'cw-doc-state-restart-'));
  dirs.push(d);
  return d;
}

function open(dataDir: string, docState: DocStateStore): DocStore {
  const s = new DocStore({
    dataDir,
    docState,
    sse: new SseBus(),
    webhooks: createWebhookDispatcher({ onLog: () => {} }),
  });
  stores.push(s);
  return s;
}

const backends = [
  { name: 'disk', make: (dataDir: string) => new DiskDocStateStore(dataDir) },
  { name: 'memory', make: () => new MemoryDocStateStore() },
];

for (const backend of backends) {
  describe(`a doc saved through the ${backend.name} backend`, () => {
    for (const kind of DOC_KINDS) {
      it(`reopens identical after a restart: ${kind.kind}`, () => {
        const dataDir = tempDir();
        const state = backend.make(dataDir);
        const first = open(dataDir, state);
        kind.build(first);
        const live = first.get(kind.docId);
        expect(live).toBeDefined();
        // Flush first: a whiteboard's content revision is bumped on a
        // debounce, and the flush runs it, so this is the state saved.
        first.flush();
        const before = viewOf(live!.ydoc, kind);
        // Positive control: the doc really holds content in every root named.
        for (const t of kind.text) expect(before.text[t]?.length).toBeGreaterThan(0);
        expect(Object.keys(before.maps.meta as object).length).toBeGreaterThan(0);
        first.stop();
        expect(state.has(kind.docId)).toBe(true);

        const second = open(dataDir, state);
        const reopened = second.get(kind.docId);
        expect(reopened).toBeDefined();
        expect(reopened!.ydoc).not.toBe(live!.ydoc);
        const after = viewOf(reopened!.ydoc, kind);
        expect(after.stateVector).toEqual(before.stateVector);
        expect(after.update).toEqual(before.update);
        expect(after.text).toEqual(before.text);
        expect(after.maps).toEqual(before.maps);
      });
    }
  });
}

describe('the disk backend writes what the earlier code reads', () => {
  it('leaves a `.ydoc` that a plain Y.applyUpdate turns back into the same doc', () => {
    const dataDir = tempDir();
    const docStore = open(dataDir, new DiskDocStateStore(dataDir));
    for (const kind of DOC_KINDS) kind.build(docStore);
    docStore.flush();
    for (const kind of DOC_KINDS) {
      // What the pre-interface `loadFromDisk` did: read the file, apply it.
      const plain = new Y.Doc();
      Y.applyUpdate(plain, new Uint8Array(readFileSync(join(dataDir, `${kind.docId}.ydoc`))));
      const live = docStore.get(kind.docId)!;
      expect(viewOf(plain, kind)).toEqual(viewOf(live.ydoc, kind));
    }
  });
});

describe('DocStore on the memory backend', () => {
  it('writes no `.ydoc` into the data dir', () => {
    const dataDir = tempDir();
    const docStore = open(dataDir, new MemoryDocStateStore());
    for (const kind of DOC_KINDS) kind.build(docStore);
    docStore.flush();
    expect(readdirSync(dataDir).filter((f) => f.endsWith('.ydoc'))).toEqual([]);
  });

  it('archives a doc out of reach and brings it back intact', () => {
    const dataDir = tempDir();
    const state = new MemoryDocStateStore();
    const docStore = open(dataDir, state);
    const kind = DOC_KINDS[0]!;
    kind.build(docStore);
    const before = viewOf(docStore.get(kind.docId)!.ydoc, kind);
    expect(docStore.archiveDoc(kind.docId, { archivedBy: 'Alice' }).ok).toBe(true);
    expect(state.has(kind.docId)).toBe(false);
    expect(state.has(kind.docId, 'archive')).toBe(true);
    expect(docStore.get(kind.docId)).toBeUndefined();
    expect(docStore.unarchiveDoc(kind.docId, { archivedBy: 'Alice' }).ok).toBe(true);
    const after = viewOf(docStore.get(kind.docId)!.ydoc, kind);
    expect(after.text).toEqual(before.text);
    expect(after.stateVector).toEqual(before.stateVector);
  });

  it('deletes a doc so a restart does not bring it back', () => {
    const dataDir = tempDir();
    const state = new MemoryDocStateStore();
    const first = open(dataDir, state);
    const kind = DOC_KINDS[2]!;
    kind.build(first);
    first.flush();
    expect(first.deleteDoc(kind.docId).ok).toBe(true);
    expect(state.has(kind.docId)).toBe(false);
    first.stop();
    const second = open(dataDir, state);
    expect(second.get(kind.docId)).toBeUndefined();
    expect(second.docExists(kind.docId)).toBe(false);
  });

  it('lists a saved doc after a restart', () => {
    const dataDir = tempDir();
    const state = new MemoryDocStateStore();
    const first = open(dataDir, state);
    DOC_KINDS[0]!.build(first);
    first.flush();
    first.stop();
    const second = open(dataDir, state);
    expect(second.list().map((m) => m.docId)).toContain(DOC_KINDS[0]!.docId);
  });
});
