/**
 * The four kinds of doc the storage tests save and reopen: a markdown doc, a
 * board, a whiteboard, and a doc holding component state. Each comes with the
 * roots that hold its content, so a reopened doc can be compared root by root
 * (`Y.Doc.toJSON` lists only the roots a reader has already asked for).
 */
import * as Y from 'yjs';
import type { DocStore } from '../src/doc-store.ts';
import { drawShapes } from '../src/whiteboard/scene.ts';

export interface DocKind {
  kind: string;
  docId: string;
  /** Fixture file name under `fixtures/doc-state-main/`. */
  file: string;
  text: string[];
  maps: string[];
  build(store: DocStore): void;
}

export const DOC_KINDS: DocKind[] = [
  {
    kind: 'markdown doc',
    docId: 'harborlight-notes',
    file: 'markdown.ydoc',
    text: ['content'],
    maps: ['meta', 'extra', 'threads'],
    build(store) {
      const d = store.getOrCreate(this.docId, { type: 'markdown', title: 'Harborlight notes' });
      const t = d.ydoc.getText('content');
      d.ydoc.transact(() => t.insert(0, '# Harborlight\n\nRiverbend opens at nine.\n'));
      d.ydoc.transact(() => t.delete(t.toString().indexOf('nine'), 4));
      d.ydoc.transact(() => t.insert(t.toString().indexOf('.\n'), 'ten'));
      // A second client, so the state vector names two.
      const peer = new Y.Doc();
      Y.applyUpdate(peer, Y.encodeStateAsUpdate(d.ydoc));
      const pt = peer.getText('content');
      pt.insert(pt.length, '\nSaltmarsh closes at six.\n');
      peer.getMap('extra').set('reviewer', 'Alice');
      Y.applyUpdate(d.ydoc, Y.encodeStateAsUpdate(peer, Y.encodeStateVector(d.ydoc)));
    },
  },
  {
    kind: 'board',
    docId: 'ws:harborlight',
    file: 'board.ydoc',
    text: [],
    maps: ['meta', 'tasks', 'workspace'],
    build(store) {
      const d = store.getOrCreate(
        this.docId,
        { type: 'workspace', title: 'Harborlight' },
        { authority: 'server' },
      );
      const tasks = d.ydoc.getMap('tasks');
      d.ydoc.getMap('workspace').set('name', 'Harborlight');
      const sign = { id: 't-1', title: 'Paint the Riverbend sign' };
      d.ydoc.transact(() => tasks.set('t-1', { ...sign, status: 'todo' }));
      d.ydoc.transact(() => tasks.set('t-2', { id: 't-2', title: 'Order rope', status: 'todo' }));
      d.ydoc.transact(() => tasks.set('t-1', { ...sign, status: 'done' }));
      d.ydoc.transact(() => tasks.delete('t-2'));
    },
  },
  {
    kind: 'whiteboard',
    docId: 'harborlight-sketch',
    file: 'whiteboard.ydoc',
    text: [],
    maps: ['meta', 'elements'],
    build(store) {
      const d = store.getOrCreate(this.docId, { type: 'whiteboard', title: 'Harborlight sketch' });
      const actor = { id: 'agent-bob', name: 'Bob', kind: 'agent' as const };
      const shapes = [
        { id: 'dock', kind: 'box' as const, x: 10, y: 20, w: 120, h: 60, text: 'Dock' },
        { id: 'pier', kind: 'ellipse' as const, x: 200, y: 40, w: 80, h: 80, text: 'Pier' },
      ];
      drawShapes(d.ydoc, shapes, 'add', actor, 1_700_000_000_000);
      const moved = [{ id: 'dock', kind: 'box' as const, x: 15, y: 25, w: 140, h: 60, text: 'A' }];
      drawShapes(d.ydoc, moved, 'replace', actor, 1_700_000_001_000);
    },
  },
  {
    kind: 'doc holding component state',
    docId: 'riverbend-poll',
    file: 'component-state.ydoc',
    text: ['content'],
    maps: ['meta', 'component-state:poll'],
    build(store) {
      const d = store.getOrCreate(this.docId, { type: 'markdown', title: 'Riverbend poll' });
      d.ydoc.getText('content').insert(0, '# Riverbend poll\n\n<Poll id="poll" />\n');
      const state = d.ydoc.getMap('component-state:poll');
      d.ydoc.transact(() => {
        state.set('question', 'Saltmarsh or Riverbend?');
        const votes = new Y.Array<string>();
        state.set('votes', votes);
        votes.push(['Alice', 'Bob']);
        const tally = new Y.Map<number>();
        state.set('tally', tally);
        tally.set('Saltmarsh', 1);
        tally.set('Riverbend', 1);
      });
      d.ydoc.transact(() => (state.get('tally') as Y.Map<number>).set('Riverbend', 2));
    },
  },
];

/** Everything a reopened doc is compared on. */
export interface DocView {
  stateVector: Uint8Array;
  update: Uint8Array;
  text: Record<string, string>;
  maps: Record<string, unknown>;
}

export function viewOf(ydoc: Y.Doc, kind: DocKind): DocView {
  return {
    stateVector: Y.encodeStateVector(ydoc),
    update: Y.encodeStateAsUpdate(ydoc),
    text: Object.fromEntries(kind.text.map((n) => [n, ydoc.getText(n).toString()])),
    maps: Object.fromEntries(kind.maps.map((n) => [n, ydoc.getMap(n).toJSON()])),
  };
}
