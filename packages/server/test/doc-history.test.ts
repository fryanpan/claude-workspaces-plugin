/**
 * Doc history over a real DocStore, for the four kinds of doc: a markdown
 * doc, a board, a whiteboard and a doc holding component state (D1 step 12,
 * done-when lines 2, 3 and 4).
 *
 * Each case builds the kind's fixture, then two people edit different parts
 * of it over their sockets. The doc read as it was before their edits
 * matches what it held then, the parts each changed are named with the
 * right person, and restoring that version is a recorded change after which
 * the version before the restore still reads back.
 *
 * A socket here is the slice the recorder reads: in the doc's connections,
 * with the identity its upgrade proved. The server test
 * (`doc-history-server.test.ts`) drives real sockets.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as Y from 'yjs';
import { getProseFragment } from '../../core/src/prose.ts';
import { MemoryHistoryStore } from '../src/doc-history/log.ts';
import { DocHistory } from '../src/doc-history/recorder.ts';
import { MemoryDocStateStore } from '../src/doc-state/memory.ts';
import { DocStore, type FeedbackWs, type LiveDoc } from '../src/doc-store.ts';
import { SseBus } from '../src/sse.ts';
import { createWebhookDispatcher } from '../src/webhooks.ts';
import { drawShapes } from '../src/whiteboard/scene.ts';
import { DOC_KINDS, type DocKind } from './doc-state-docs.ts';

const dirs: string[] = [];
const stores: DocStore[] = [];

afterEach(() => {
  for (const s of stores.splice(0)) s.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const ALICE = { id: 'person-alice', name: 'Alice', kind: 'known' as const, color: '#2e7dd7' };
const BOB = { id: 'person-bob', name: 'Bob', kind: 'known' as const, color: '#d72e7d' };

/** A clock the test moves, so "an earlier time" never reads the wall. */
function clock() {
  let t = 1_700_000_000_000;
  return { now: () => t, tick: (ms = 1000) => (t += ms) };
}

function setup(inScope: (doc: LiveDoc) => boolean = () => true) {
  const dataDir = mkdtempSync(join(tmpdir(), 'cw-doc-history-'));
  dirs.push(dataDir);
  const c = clock();
  const historyStore = new MemoryHistoryStore();
  const history = new DocHistory({ store: historyStore, inScope, now: c.now, scopeTtlMs: 0 });
  const store = new DocStore({
    dataDir,
    docState: new MemoryDocStateStore(),
    sse: new SseBus(),
    webhooks: createWebhookDispatcher({ onLog: () => {} }),
    onDocWired: (doc) => history.attach(doc),
  });
  stores.push(store);
  return { store, history, historyStore, clock: c };
}

/** A socket of `doc` whose upgrade proved `user`. */
function socketOf(doc: LiveDoc, user: typeof ALICE): FeedbackWs {
  const ws = { data: { docId: doc.docId, editor: { user } } } as unknown as FeedbackWs;
  doc.conns.add(ws);
  return ws;
}

/** What each kind's two people change, and the parts that names. */
interface Edits {
  alice(doc: Y.Doc): void;
  bob(doc: Y.Doc): void;
  aliceParts: Array<{ root: string; key?: string }>;
  bobParts: Array<{ root: string; key?: string }>;
}

const EDITS: Record<string, Edits> = {
  'markdown doc': {
    alice: (d) => d.getText('content').insert(0, 'Harborlight tide tables. '),
    bob: (d) => d.getMap('extra').set('reviewer', 'Bob'),
    aliceParts: [{ root: 'content' }],
    bobParts: [{ root: 'extra', key: 'reviewer' }],
  },
  board: {
    alice: (d) => d.getMap('tasks').set('t-3', { id: 't-3', title: 'Riverbend ropes' }),
    bob: (d) => d.getMap('tasks').set('t-1', { id: 't-1', title: 'Paint', status: 'todo' }),
    aliceParts: [{ root: 'tasks', key: 't-3' }],
    bobParts: [{ root: 'tasks', key: 't-1' }],
  },
  whiteboard: {
    alice: (d) =>
      drawShapes(
        d,
        [{ id: 'buoy', kind: 'ellipse', x: 300, y: 10, w: 20, h: 20, text: 'Buoy' }],
        'add',
        { id: 'person-alice', name: 'Alice', kind: 'agent' },
        1_700_000_002_000,
      ),
    bob: (d) => d.getMap('elements').delete('pier'),
    aliceParts: [{ root: 'elements', key: 'buoy' }],
    bobParts: [{ root: 'elements', key: 'pier' }],
  },
  'doc holding component state': {
    alice: (d) =>
      ((d.getMap('component-state:poll').get('tally') as Y.Map<number>) ?? new Y.Map()).set(
        'Saltmarsh',
        3,
      ),
    bob: (d) => (d.getMap('component-state:poll').get('votes') as Y.Array<string>).push(['Bob']),
    aliceParts: [{ root: 'component-state:poll', key: 'tally' }],
    bobParts: [{ root: 'component-state:poll', key: 'votes' }],
  },
};

/** The content roots a restore puts back: every root the kind names but meta. */
function contentOf(ydoc: Y.Doc, kind: DocKind): Record<string, unknown> {
  return {
    ...Object.fromEntries(kind.text.map((n) => [n, ydoc.getText(n).toString()])),
    ...Object.fromEntries(
      kind.maps.filter((n) => n !== 'meta').map((n) => [n, ydoc.getMap(n).toJSON()]),
    ),
  };
}

describe('a doc read as it was, and restored, for each kind of doc', () => {
  for (const kind of DOC_KINDS) {
    const edits = EDITS[kind.kind];
    if (!edits) throw new Error(`no edits for ${kind.kind}`);

    it(`reads an earlier version with who changed each part since: ${kind.kind}`, () => {
      const { store, history, clock } = setup();
      kind.build(store);
      const live = store.get(kind.docId);
      expect(live).toBeDefined();
      const doc = live as LiveDoc;
      const before = contentOf(doc.ydoc, kind);
      clock.tick();
      const beforeEdits = clock.now();
      clock.tick();
      doc.ydoc.transact(() => edits.alice(doc.ydoc), socketOf(doc, ALICE));
      clock.tick();
      doc.ydoc.transact(() => edits.bob(doc.ydoc), socketOf(doc, BOB));
      // Positive control: the edits changed what the doc holds.
      expect(contentOf(doc.ydoc, kind)).not.toEqual(before);

      const versions = history.versions(kind.docId);
      expect(versions[0]?.kind).toBe('base');
      expect(versions.slice(-2).map((v) => v.author.name)).toEqual(['Alice', 'Bob']);

      const read = history.read(kind.docId, { at: beforeEdits });
      expect(contentOf(read.doc, kind)).toEqual(before);
      const named = (who: string) =>
        read.changes
          .filter((p) => p.authors.some((a) => a.name === who))
          .map((p) => ({ root: p.root, ...(p.key !== undefined ? { key: p.key } : {}) }));
      for (const part of edits.aliceParts) expect(named('Alice')).toContainEqual(part);
      for (const part of edits.bobParts) expect(named('Bob')).toContainEqual(part);
      // Neither is named on the other's part.
      for (const part of edits.bobParts) expect(named('Alice')).not.toContainEqual(part);
      read.doc.destroy();
    });

    it(`restores an earlier version as a recorded change, keeping the one it replaced: ${kind.kind}`, () => {
      const { store, history, clock } = setup();
      kind.build(store);
      const doc = store.get(kind.docId) as LiveDoc;
      const before = contentOf(doc.ydoc, kind);
      const target = history.versions(kind.docId).length - 1;
      clock.tick();
      doc.ydoc.transact(() => edits.alice(doc.ydoc), socketOf(doc, ALICE));
      doc.ydoc.transact(() => edits.bob(doc.ydoc), socketOf(doc, BOB));
      const edited = contentOf(doc.ydoc, kind);
      const lastBeforeRestore = history.versions(kind.docId).length - 1;

      clock.tick();
      const riverbend = { kind: 'agent' as const, id: 'agent-riverbend', name: 'Riverbend' };
      const result = history.restore(doc, target, riverbend);
      expect(contentOf(doc.ydoc, kind)).toEqual(before);
      expect(result.seq).toBe(lastBeforeRestore + 1);

      const restoreRec = history.versions(kind.docId).at(-1);
      expect(restoreRec).toMatchObject({ kind: 'restore', restoredTo: target, author: riverbend });
      // The version the restore replaced reads back whole.
      const replaced = history.read(kind.docId, { seq: lastBeforeRestore });
      expect(contentOf(replaced.doc, kind)).toEqual(edited);
      // And the restore is named on the parts it changed.
      expect(replaced.changes.every((p) => p.authors.some((a) => a.name === 'Riverbend'))).toBe(
        true,
      );
      expect(replaced.changes.length).toBeGreaterThan(0);
      replaced.doc.destroy();
    });
  }
});

describe('a markdown doc’s prose, block by block', () => {
  it('names the block each person changed by its index now, and a removed block', () => {
    const { store, history } = setup();
    const doc = store.getOrCreate('harborlight-prose', { type: 'markdown', title: 'Tides' });
    const frag = getProseFragment(doc.ydoc);
    const para = (words: string) => {
      const p = new Y.XmlElement('paragraph');
      const t = new Y.XmlText();
      p.insert(0, [t]);
      t.insert(0, words);
      return p;
    };
    doc.ydoc.transact(() => frag.push([para('One.'), para('Two.'), para('Three.')]));
    const since = history.versions(doc.docId).length - 1;
    const alice = socketOf(doc, ALICE);
    const bob = socketOf(doc, BOB);
    // Alice types into the second block; Bob removes the first and adds one at the end.
    doc.ydoc.transact(() => {
      const t = (frag.get(1) as Y.XmlElement).get(0) as Y.XmlText;
      t.insert(t.length, ' Riverbend.');
    }, alice);
    doc.ydoc.transact(() => {
      frag.delete(0, 1);
      frag.push([para('Four.')]);
    }, bob);

    const { changes, doc: past } = history.read(doc.docId, { seq: since });
    expect(getProseFragment(past).length).toBe(3);
    const prose = changes.filter((p) => p.root === 'prose');
    const who = (p: (typeof prose)[number]) => p.authors.map((a) => a.name);
    // After Bob's delete, Alice's block is the first and Bob's new one the third.
    expect(prose.find((p) => p.index === 0 && who(p).includes('Alice'))).toBeDefined();
    expect(prose.find((p) => p.index === 2 && who(p).includes('Bob'))).toBeDefined();
    expect(prose.find((p) => p.removed && who(p).includes('Bob'))).toBeDefined();
    // The block nobody touched (now index 1, "Three.") is not named.
    expect(prose.find((p) => p.index === 1)).toBeUndefined();
    past.destroy();
  });
});

describe('the log keeps step with the doc', () => {
  it('records nothing for a doc out of scope, and writes a base when it comes back', () => {
    let on = false;
    const { store, history } = setup(() => on);
    const doc = store.getOrCreate('saltmarsh-notes', { type: 'markdown', title: 'Saltmarsh' });
    doc.ydoc.getMap('extra').set('a', 1);
    expect(history.versions(doc.docId)).toEqual([]);
    on = true;
    doc.ydoc.transact(() => doc.ydoc.getMap('extra').set('b', 2), socketOf(doc, ALICE));
    on = false;
    doc.ydoc.getMap('extra').set('c', 3);
    on = true;
    doc.ydoc.transact(() => doc.ydoc.getMap('extra').set('d', 4), socketOf(doc, BOB));
    const kinds = history.versions(doc.docId).map((v) => `${v.kind}:${v.author.name ?? '-'}`);
    // A base before each run of recorded edits, because each began after unrecorded ones.
    expect(kinds).toEqual(['base:-', 'update:Alice', 'base:-', 'update:Bob']);
    // Every version still reads: the one after Alice's edit holds a and b, not c.
    const read = history.read(doc.docId, { seq: 1 });
    expect(read.doc.getMap('extra').toJSON()).toEqual({ a: 1, b: 2 });
    read.doc.destroy();
  });

  it('writes no second base when nothing happened between two runs', () => {
    const { store, historyStore } = setup();
    const doc = store.getOrCreate('riverbend-notes', { type: 'markdown', title: 'Riverbend' });
    doc.ydoc.getMap('extra').set('a', 1);
    const second = new DocHistory({ store: historyStore, inScope: () => true, scopeTtlMs: 0 });
    // A restart: a new recorder over the same log, on a doc with the same state.
    const reopened = new Y.Doc();
    Y.applyUpdate(reopened, Y.encodeStateAsUpdate(doc.ydoc));
    const fake = { ...doc, ydoc: reopened, conns: new Set<FeedbackWs>() } as LiveDoc;
    second.attach(fake);
    reopened.getMap('extra').set('b', 2);
    expect(second.versions(doc.docId).map((v) => v.kind)).toEqual(['base', 'update', 'update']);
  });

  it('refuses a restore on a doc it does not record', () => {
    const { store, history } = setup(() => false);
    const doc = store.getOrCreate('harborlight-off', { type: 'markdown', title: 'Off' });
    expect(() => history.restore(doc, 0, { kind: 'person', name: 'Alice' })).toThrow(
      /keeps no history/,
    );
  });
});
