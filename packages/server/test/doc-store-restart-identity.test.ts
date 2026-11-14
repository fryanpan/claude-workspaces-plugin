/**
 * A doc saved through the disk store reopens IDENTICAL after a restart:
 * the same Yjs state vector, the same text, the same whole-doc JSON.
 *
 * Step 1 of the collaboration-core plan keeps this store as a storage
 * backend, so "it reopens the same" has to be a fact, not an assumption.
 * The board-doc restart test (`board-compaction-persist.test.ts`) compares
 * only the state vector's client ids, and only for a board doc that the
 * load path compacts; this compares the full vector, byte for byte, for a
 * plain doc carrying edits from two clients, including deletes.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as Y from 'yjs';
import { DocStore } from '../src/doc-store.ts';
import { SseBus } from '../src/sse.ts';
import { createWebhookDispatcher } from '../src/webhooks.ts';

const dirs: string[] = [];
const stores: DocStore[] = [];

function store(dataDir: string): DocStore {
  const s = new DocStore({
    dataDir,
    sse: new SseBus(),
    webhooks: createWebhookDispatcher({ onLog: () => {} }),
  });
  stores.push(s);
  return s;
}

afterEach(() => {
  for (const s of stores.splice(0)) s.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('the disk store across a restart', () => {
  it('reopens a doc with the same state vector, text and contents', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'cw-restart-identity-'));
    dirs.push(dataDir);
    const docId = 'harborlight-notes';

    const first = store(dataDir);
    const live = first.getOrCreate(docId, { type: 'markdown', title: 'Harborlight notes' });
    const text = live.ydoc.getText('content');
    live.ydoc.transact(() => text.insert(0, '# Harborlight\n\nRiverbend opens at nine.\n'));
    live.ydoc.transact(() => text.delete(text.toString().indexOf('nine'), 4));
    live.ydoc.transact(() => text.insert(text.toString().indexOf('.\n'), 'ten'));

    // A second client's edits, arriving as a peer's update would: the state
    // vector then names two clients, so equality below is not one counter.
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(live.ydoc));
    const peerText = peer.getText('content');
    peerText.insert(peerText.length, '\nSaltmarsh closes at six.\n');
    peerText.delete(0, 2);
    peer.getMap('extra').set('reviewer', 'Alice');
    Y.applyUpdate(live.ydoc, Y.encodeStateAsUpdate(peer, Y.encodeStateVector(live.ydoc)));

    const svBefore = Y.encodeStateVector(live.ydoc);
    const textBefore = text.toString();
    const jsonBefore = live.ydoc.toJSON();
    // Positive controls: the fixture really holds two clients and the edits.
    expect(Y.decodeStateVector(svBefore).size).toBeGreaterThanOrEqual(2);
    expect(textBefore).toBe('Harborlight\n\nRiverbend opens at ten.\n\nSaltmarsh closes at six.\n');

    first.flush();
    first.stop();
    expect(existsSync(join(dataDir, `${docId}.ydoc`))).toBe(true);

    const second = store(dataDir);
    const reopened = second.get(docId);
    expect(reopened).toBeDefined();
    // A different Y.Doc instance, built from disk — not the one held above.
    expect(reopened?.ydoc).not.toBe(live.ydoc);
    expect(Y.encodeStateVector(reopened!.ydoc)).toEqual(svBefore);
    expect(reopened!.ydoc.getText('content').toString()).toBe(textBefore);
    expect(reopened!.ydoc.toJSON()).toEqual(jsonBefore);
  });
});
