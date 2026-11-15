/**
 * The Workspaces side of the collab core (`collab-core-path.ts`): one core
 * room host over the doc store's live docs, serving the sync frames of the
 * sockets a switched-on board opened.
 *
 * Driven with fake sockets so the frames, the origin and the room's lifetime
 * can be read directly. The full server path, two real sockets on a board, is
 * `collab-core-board.test.ts`.
 */
import { describe, expect, it } from 'bun:test';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import { CollabCorePath, roomIdOf } from '../src/collab-core-path.ts';
import { CollabRooms } from '../src/collab-rooms.ts';
import type { FeedbackWs, LiveDoc } from '../src/doc-store.ts';

const MSG_SYNC = 0;

function fakeWs(docId: string, data: Record<string, unknown> = {}) {
  const sent: Uint8Array[] = [];
  const closed: number[] = [];
  const ws = {
    data: { docId, core: true, ...data },
    sendBinary: (b: Uint8Array) => {
      sent.push(b);
      return b.length;
    },
    close: (code: number) => closed.push(code),
  } as unknown as FeedbackWs;
  return { ws, sent, closed };
}

const step1 = (doc: Y.Doc): Uint8Array => {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MSG_SYNC);
  syncProtocol.writeSyncStep1(enc, doc);
  return encoding.toUint8Array(enc);
};
const updateFrame = (update: Uint8Array): Uint8Array => {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MSG_SYNC);
  syncProtocol.writeUpdate(enc, update);
  return encoding.toUint8Array(enc);
};
/** Apply every sync frame a fake socket was sent to a page doc. */
const applyAll = (frames: Uint8Array[], page: Y.Doc): void => {
  for (const f of frames) {
    const dec = decoding.createDecoder(f);
    if (decoding.readVarUint(dec) !== MSG_SYNC) continue;
    syncProtocol.readSyncMessage(dec, encoding.createEncoder(), page, 'server');
  }
};

const liveOf = (docId: string, ydoc: Y.Doc): LiveDoc => ({ docId, ydoc }) as unknown as LiveDoc;

function store(docs: Record<string, Y.Doc>) {
  return (docId: string) => {
    const ydoc = docs[docId];
    return ydoc ? liveOf(docId, ydoc) : undefined;
  };
}

describe('roomIdOf', () => {
  it('turns any doc id into a room id the core accepts, one per doc', () => {
    const a = roomIdOf('ws:harborlight');
    const b = roomIdOf('harborlight:notes~plan.md');
    expect(a).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
    expect(b).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
    expect(a).not.toBe(b);
    expect(roomIdOf('ws:harborlight')).toBe(a);
  });
});

describe('CollabCorePath', () => {
  it('sends the room’s sync step 1 on open, and answers a page’s step 1 with the doc', () => {
    const live = new Y.Doc();
    live.getText('body').insert(0, 'Harborlight');
    const path = new CollabCorePath({ getDoc: store({ d: live }), rooms: new CollabRooms() });
    const { ws, sent } = fakeWs('d');
    expect(path.open(ws, liveOf('d', live))).toBe(true);
    expect(sent.length).toBe(1);
    const page = new Y.Doc();
    path.receive(ws, step1(page));
    applyAll(sent, page);
    expect(page.getText('body').toString()).toBe('Harborlight');
  });

  it('applies an edit to the store’s live doc with the socket as its origin', () => {
    const live = new Y.Doc();
    const origins: unknown[] = [];
    live.on('update', (_u: Uint8Array, o: unknown) => origins.push(o));
    const path = new CollabCorePath({ getDoc: store({ d: live }), rooms: new CollabRooms() });
    const alice = fakeWs('d');
    const bob = fakeWs('d');
    path.open(alice.ws, liveOf('d', live));
    path.open(bob.ws, liveOf('d', live));
    const page = new Y.Doc();
    page.getText('body').insert(0, 'Riverbend');
    path.receive(alice.ws, updateFrame(Y.encodeStateAsUpdate(page)));
    expect(live.getText('body').toString()).toBe('Riverbend');
    expect(origins).toEqual([alice.ws]);
    // Bob hears it; Alice is not sent her own edit back.
    const bobPage = new Y.Doc();
    applyAll(bob.sent, bobPage);
    expect(bobPage.getText('body').toString()).toBe('Riverbend');
    expect(alice.sent.length).toBe(1);
  });

  it('serves a read-only socket the doc and drops its edits', () => {
    const live = new Y.Doc();
    const path = new CollabCorePath({ getDoc: store({ d: live }), rooms: new CollabRooms() });
    const { ws } = fakeWs('d', { readOnly: true });
    path.open(ws, liveOf('d', live));
    const page = new Y.Doc();
    page.getText('body').insert(0, 'not taken');
    path.receive(ws, updateFrame(Y.encodeStateAsUpdate(page)));
    expect(live.getText('body').toString()).toBe('');
  });

  it('closes a socket whose doc the store has since replaced, so it reconnects to the new one', () => {
    const docs: Record<string, Y.Doc> = { d: new Y.Doc() };
    const path = new CollabCorePath({ getDoc: store(docs), rooms: new CollabRooms() });
    const { ws, closed } = fakeWs('d');
    path.open(ws, liveOf('d', docs.d as Y.Doc));
    docs.d = new Y.Doc();
    path.receive(ws, step1(new Y.Doc()));
    expect(closed).toEqual([1012]);
  });

  it('puts an alias and its doc in one room, keyed by the store’s id', () => {
    const live = new Y.Doc();
    const path = new CollabCorePath({ getDoc: store({ d: live }), rooms: new CollabRooms() });
    const viaAlias = fakeWs('old-name');
    const direct = fakeWs('d');
    path.open(viaAlias.ws, liveOf('d', live));
    path.open(direct.ws, liveOf('d', live));
    expect(path.openRooms()).toEqual(['d']);
  });

  it('lets go of the room when its last socket closes, and registers with the revoke recheck', () => {
    const live = new Y.Doc();
    const rooms = new CollabRooms();
    const path = new CollabCorePath({ getDoc: store({ d: live }), rooms });
    const { ws } = fakeWs('d');
    path.open(ws, liveOf('d', live));
    expect(path.openRooms()).toEqual(['d']);
    rooms.recheck(); // A socket whose role is unchanged stays.
    expect(path.openRooms()).toEqual(['d']);
    path.close(ws);
    expect(path.openRooms()).toEqual([]);
    live.getText('body').insert(0, 'still a working doc');
    expect(live.getText('body').toString()).toBe('still a working doc');
  });
});
