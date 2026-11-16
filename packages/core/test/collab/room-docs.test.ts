/**
 * A room host handed the app's own live docs (`docs`) instead of a storage.
 *
 * An app that already holds its docs in memory, and persists them itself,
 * cannot let the core load a second copy: two Y.Docs for one id diverge, and
 * the later save wins. With `docs`, the room syncs the app's doc in place,
 * names the app's transaction origin on each edit, and never saves or
 * destroys the doc.
 */
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { describe, expect, it, vi } from 'vitest';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import {
  type CollabConnection,
  MSG_SYNC,
  type RoomHost,
  createRoomHost,
} from '../../src/collab/index.ts';

const frame = (write: (enc: encoding.Encoder) => void) => {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MSG_SYNC);
  write(enc);
  return encoding.toUint8Array(enc);
};

function page(host: RoomHost, roomId: string, id: string, origin?: unknown) {
  const ydoc = new Y.Doc();
  let conn: CollabConnection | null = null;
  const result = host.connect({
    roomId,
    principal: { id },
    ...(origin !== undefined ? { origin } : {}),
    send: (bytes) => {
      const dec = decoding.createDecoder(bytes);
      if (decoding.readVarUint(dec) !== MSG_SYNC) return;
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_SYNC);
      syncProtocol.readSyncMessage(dec, enc, ydoc, 'server');
      if (encoding.length(enc) > 1) queueMicrotask(() => conn?.receive(encoding.toUint8Array(enc)));
    },
  });
  if (!result.ok) return { result, ydoc, conn: null };
  conn = result.connection;
  ydoc.on('update', (update: Uint8Array, o: unknown) => {
    if (o === 'server') return;
    conn?.receive(frame((enc) => syncProtocol.writeUpdate(enc, update)));
  });
  conn.receive(frame((enc) => syncProtocol.writeSyncStep1(enc, ydoc)));
  return { result, ydoc, conn };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('a room host over the app’s live docs', () => {
  it('refuses to build with both a storage and docs, or with neither', () => {
    const role = () => 'edit' as const;
    const docs = { open: () => new Y.Doc() };
    const storage = { read: () => null, write: () => {} };
    expect(() => createRoomHost({ role, storage, docs })).toThrow(/storage or docs/);
    expect(() =>
      createRoomHost({ role } as unknown as Parameters<typeof createRoomHost>[0]),
    ).toThrow(/storage or docs/);
  });

  it('syncs the app’s own doc in place, so an edit is in it at once', async () => {
    const live = new Y.Doc();
    live.getText('body').insert(0, 'Harborlight');
    const host = createRoomHost({ role: () => 'edit', docs: { open: () => live } });
    const writer = page(host, 'harborlight', 'writer');
    const reader = page(host, 'harborlight', 'reader');
    await settle();
    expect(writer.ydoc.getText('body').toString()).toBe('Harborlight');
    writer.ydoc.getText('body').insert(0, 'Riverbend ');
    await settle();
    expect(live.getText('body').toString()).toBe('Riverbend Harborlight');
    expect(reader.ydoc.getText('body').toString()).toBe('Riverbend Harborlight');
    // A change the app makes to its doc reaches every page too.
    live.getText('body').insert(live.getText('body').length, '!');
    await settle();
    expect(writer.ydoc.getText('body').toString()).toBe('Riverbend Harborlight!');
  });

  it('names the connection’s origin on the transactions its edits make', async () => {
    const live = new Y.Doc();
    const origins: unknown[] = [];
    live.on('update', (_u: Uint8Array, o: unknown) => origins.push(o));
    const host = createRoomHost({ role: () => 'edit', docs: { open: () => live } });
    const socket = { name: 'the app’s socket' };
    const writer = page(host, 'harborlight', 'writer', socket);
    const sent = vi.fn();
    // A second connection with the same origin is not sent its own edit back.
    const twin = host.connect({
      roomId: 'harborlight',
      principal: { id: 'writer' },
      origin: socket,
      send: sent,
    });
    expect(twin.ok).toBe(true);
    sent.mockClear();
    writer.ydoc.getText('body').insert(0, 'Saltmarsh');
    await settle();
    expect(origins).toContain(socket);
    expect(sent).not.toHaveBeenCalled();
  });

  it('never saves or destroys the app’s doc when the last page leaves', async () => {
    const live = new Y.Doc();
    const open = vi.fn(() => live);
    const host = createRoomHost({ role: () => 'edit', docs: { open } });
    const writer = page(host, 'harborlight', 'writer');
    writer.ydoc.getText('body').insert(0, 'kept');
    await settle();
    writer.conn?.close();
    expect(host.openRooms()).toEqual([]);
    // Still a working doc: the room let go of it without destroying it.
    live.getText('body').insert(0, 'still ');
    expect(live.getText('body').toString()).toBe('still kept');
    // Detached: a page in a reopened room is not sent the update twice.
    const sends = vi.fn();
    host.connect({ roomId: 'harborlight', principal: { id: 'reader' }, send: sends });
    sends.mockClear();
    live.getText('body').insert(0, '>');
    expect(sends).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledTimes(2);
  });

  it('refuses a room the app holds no doc for', () => {
    const host = createRoomHost({ role: () => 'edit', docs: { open: () => null } });
    expect(
      host.connect({ roomId: 'riverbend', principal: { id: 'writer' }, send: () => {} }),
    ).toEqual({
      ok: false,
      error: 'no-doc',
    });
    expect(host.openRooms()).toEqual([]);
  });

  it('still drops a view connection’s edit unread', async () => {
    const live = new Y.Doc();
    const host = createRoomHost({
      role: (p) => (p.id === 'reader' ? 'view' : 'edit'),
      docs: { open: () => live },
    });
    const reader = page(host, 'harborlight', 'reader');
    reader.ydoc.getText('body').insert(0, 'not taken');
    await settle();
    expect(live.getText('body').toString()).toBe('');
  });
});
