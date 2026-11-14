import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { describe, expect, it, vi } from 'vitest';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import {
  type CollabConnection,
  type CollabStorage,
  MSG_SYNC,
  MemoryCollabStorage,
  type RoleFn,
  type RoomHost,
  createRoomHost,
} from '../../src/collab/index.ts';

/** A page in memory: a Y.Doc wired to one connection, speaking the same
 *  frames a socket carries. */
function page(host: RoomHost, roomId: string, id: string) {
  const ydoc = new Y.Doc();
  let conn: CollabConnection | null = null;
  const frame = (write: (enc: encoding.Encoder) => void) => {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    write(enc);
    return encoding.toUint8Array(enc);
  };
  const result = host.connect({
    roomId,
    principal: { id },
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
  ydoc.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin === 'server') return;
    conn?.receive(frame((enc) => syncProtocol.writeUpdate(enc, update)));
  });
  // Ask for the doc, as a page does when it opens.
  conn.receive(frame((enc) => syncProtocol.writeSyncStep1(enc, ydoc)));
  return { result, ydoc, conn };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

const roles: RoleFn = (p) =>
  p.id === 'alice' ? 'edit' : p.id === 'bob' ? 'view' : p.id === 'saltmarsh' ? 'owner' : null;

describe('createRoomHost', () => {
  it('refuses to build without a role function', () => {
    const storage = new MemoryCollabStorage();
    expect(() =>
      createRoomHost({ storage } as unknown as Parameters<typeof createRoomHost>[0]),
    ).toThrow(/role function/);
  });

  it('refuses a connection whose role is null before the room is loaded', () => {
    const read = vi.fn(() => null);
    const storage: CollabStorage = { read, write: vi.fn() };
    const host = createRoomHost({ storage, role: roles });
    const { result } = page(host, 'harborlight', 'riverbend');
    expect(result).toEqual({ ok: false, error: 'no-role' });
    expect(read).not.toHaveBeenCalled();
    expect(host.openRooms()).toEqual([]);
  });

  it('refuses a room id outside the allowed shape', () => {
    const host = createRoomHost({ storage: new MemoryCollabStorage(), role: roles });
    expect(page(host, '../etc', 'alice').result).toEqual({ ok: false, error: 'bad-room' });
  });
});

describe('sync between pages', () => {
  it('carries an edit from one page to another in the same room', async () => {
    const host = createRoomHost({ storage: new MemoryCollabStorage(), role: roles });
    const a = page(host, 'harborlight', 'alice');
    const b = page(host, 'harborlight', 'saltmarsh');
    a.ydoc.getText('t').insert(0, 'hello');
    await settle();
    expect(b.ydoc.getText('t').toString()).toBe('hello');
  });

  it('keeps rooms apart', async () => {
    const host = createRoomHost({ storage: new MemoryCollabStorage(), role: roles });
    const a = page(host, 'harborlight', 'alice');
    const b = page(host, 'riverbend', 'saltmarsh');
    a.ydoc.getText('t').insert(0, 'hello');
    await settle();
    expect(b.ydoc.getText('t').toString()).toBe('');
  });

  it('gives a view connection the doc and drops its edits', async () => {
    const host = createRoomHost({ storage: new MemoryCollabStorage(), role: roles });
    const a = page(host, 'harborlight', 'alice');
    a.ydoc.getText('t').insert(0, 'hello');
    await settle();
    const viewer = page(host, 'harborlight', 'bob');
    await settle();
    expect(viewer.conn?.role).toBe('view');
    expect(viewer.ydoc.getText('t').toString()).toBe('hello');
    viewer.ydoc.getText('t').insert(0, 'defaced ');
    await settle();
    expect(a.ydoc.getText('t').toString()).toBe('hello');
  });

  it('saves the room and reopens it identical from storage', async () => {
    const storage = new MemoryCollabStorage();
    const host = createRoomHost({ storage, role: roles, saveDelayMs: 10_000 });
    const a = page(host, 'harborlight', 'alice');
    a.ydoc.getText('t').insert(0, 'kept');
    await settle();
    a.conn?.close();
    expect(host.openRooms()).toEqual([]);
    expect(storage.read('harborlight')).not.toBeNull();
    const again = createRoomHost({ storage, role: roles });
    const b = page(again, 'harborlight', 'alice');
    await settle();
    expect(b.ydoc.getText('t').toString()).toBe('kept');
  });

  it('keeps a room in memory when its save fails', async () => {
    const onSaveError = vi.fn();
    const storage: CollabStorage = {
      read: () => null,
      write: () => {
        throw new Error('disk full');
      },
    };
    const host = createRoomHost({ storage, role: roles, onSaveError });
    const a = page(host, 'harborlight', 'alice');
    a.ydoc.getText('t').insert(0, 'unsaved');
    await settle();
    a.conn?.close();
    expect(onSaveError).toHaveBeenCalledWith('harborlight', expect.any(Error));
    expect(host.openRooms()).toEqual(['harborlight']);
  });
});

describe('a connection that misbehaves', () => {
  it('drops a garbled frame and keeps serving the room', async () => {
    const host = createRoomHost({ storage: new MemoryCollabStorage(), role: roles });
    const a = page(host, 'harborlight', 'alice');
    const b = page(host, 'harborlight', 'saltmarsh');
    // A sync step 1 whose state vector runs past the end of the frame.
    for (const garbled of [[0], [0, 0, 5, 1]]) {
      expect(() => a.conn?.receive(new Uint8Array(garbled))).not.toThrow();
    }
    a.ydoc.getText('t').insert(0, 'still here');
    await settle();
    expect(b.ydoc.getText('t').toString()).toBe('still here');
  });

  it('saves a change even when another socket throws on send', async () => {
    const storage = new MemoryCollabStorage();
    const host = createRoomHost({
      storage,
      role: roles,
      saveDelayMs: 10_000,
      actions: { write: (ctx) => ctx.doc.getText('t').insert(0, 'kept') },
    });
    let sends = 0;
    const dead = host.connect({
      roomId: 'harborlight',
      principal: { id: 'saltmarsh' },
      send: () => {
        if (++sends > 1) throw new Error('socket gone');
      },
    });
    expect(dead.ok).toBe(true);
    expect(host.action('harborlight', { id: 'alice' }, 'write', {})).toMatchObject({ ok: true });
    host.flush();
    const doc = new Y.Doc();
    Y.applyUpdate(doc, storage.read('harborlight') ?? new Uint8Array());
    expect(doc.getText('t').toString()).toBe('kept');
  });
});

describe('actions', () => {
  const setup = () => {
    const handler = vi.fn((ctx: { doc: Y.Doc }, body: Record<string, unknown>) => {
      ctx.doc.getText('t').insert(0, String(body.text));
      return 'done';
    });
    const peek = vi.fn((ctx: { doc: Y.Doc }) => {
      ctx.doc.getText('t').insert(0, 'scribble ');
      return ctx.doc.getText('t').toString();
    });
    const storage = new MemoryCollabStorage();
    const host = createRoomHost({
      storage,
      role: roles,
      actions: { write: handler, peek: { run: peek, readOnly: true } },
    });
    const text = () => {
      const doc = new Y.Doc();
      const saved = storage.read('harborlight');
      if (saved) Y.applyUpdate(doc, saved);
      return doc.getText('t').toString();
    };
    return { host, handler, peek, text };
  };

  for (const key of ['board', 'boardId', 'workspaceId', 'docId', 'room', 'roomId']) {
    it(`refuses a body naming "${key}" and never runs the handler`, () => {
      const { host, handler } = setup();
      const res = host.action('harborlight', { id: 'alice' }, 'write', {
        text: 'x',
        [key]: 'riverbend',
      });
      expect(res).toMatchObject({ ok: false, error: 'room-in-body' });
      expect(handler).not.toHaveBeenCalled();
    });
  }

  it('refuses a body naming a board even for an owner', () => {
    const { host, handler } = setup();
    const res = host.action('harborlight', { id: 'saltmarsh' }, 'write', { board: 'riverbend' });
    expect(res).toMatchObject({ ok: false, error: 'room-in-body' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('refuses a principal with no role', () => {
    const { host, handler } = setup();
    expect(host.action('harborlight', { id: 'riverbend' }, 'write', { text: 'x' })).toMatchObject({
      ok: false,
      error: 'no-role',
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it('refuses an action name the app did not offer, including inherited ones', () => {
    const { host } = setup();
    for (const name of ['nope', 'toString', '__proto__']) {
      expect(host.action('harborlight', { id: 'alice' }, name, {})).toMatchObject({
        ok: false,
        error: 'unknown-action',
      });
    }
  });

  it('refuses an edit action for a view principal and leaves the doc alone', () => {
    const { host, handler, text } = setup();
    host.action('harborlight', { id: 'alice' }, 'write', { text: 'kept' });
    expect(host.action('harborlight', { id: 'bob' }, 'write', { text: 'defaced ' })).toMatchObject({
      ok: false,
      error: 'read-only',
    });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(text()).toBe('kept');
  });

  it('runs a read-only action for a view principal on a copy of the doc', () => {
    const { host, text } = setup();
    host.action('harborlight', { id: 'alice' }, 'write', { text: 'kept' });
    expect(host.action('harborlight', { id: 'bob' }, 'peek', {})).toEqual({
      ok: true,
      value: 'scribble kept',
    });
    expect(text()).toBe('kept');
  });

  it('runs an offered action in the room the caller named, with the role the app gave', () => {
    const { host, handler } = setup();
    expect(host.action('harborlight', { id: 'alice' }, 'write', { text: 'hi' })).toEqual({
      ok: true,
      value: 'done',
    });
    expect(handler.mock.calls[0]?.[0]).toMatchObject({ roomId: 'harborlight', role: 'edit' });
  });
});
