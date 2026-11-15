/**
 * The rooms one app server holds: each a Yjs doc that every connection to the
 * room syncs, saved through the app's storage.
 *
 * Transport-free. The app accepts a socket however it likes, decides who is
 * on it with its own sign-in check and which room from the address, and
 * hands the core a `send` and a `close`. The core speaks the y-protocols sync
 * messages Workspaces already speaks (`[0, syncMessage]`), so an existing
 * page client works unchanged.
 *
 * Two rules the core holds for every app:
 *   - No room opens without a role function. `createRoomHost` throws when
 *     `role` is missing, and a connection whose role comes back null is
 *     refused before the room's doc is loaded.
 *   - The room comes from the connection, never a payload. An action's body
 *     that names a room, board or doc is refused (`request-guard.ts`).
 *
 * A room's doc comes from one of two places. With `storage`, the core loads
 * it, saves it on a debounce and destroys it when the room empties. With
 * `docs`, the app hands over a doc it already holds and persists itself:
 * the core syncs that doc in place and never saves or destroys it, because
 * a second Y.Doc for the same id would diverge from the app's and the later
 * save would win.
 *
 * A `view` or `comment` connection receives the doc and can never change it:
 * its sync step 2 and update messages are dropped before they are read. An
 * action is an edit unless the app marks it read-only, and an edit action is
 * refused for those roles. A socket's role is asked when it connects and again
 * whenever the app calls `recheckRoles`, which drops a revoked connection.
 */
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import { roomKeyInBody } from './request-guard.ts';
import { type CollabRole, type Principal, ROOM_ID, type RoleFn, canEdit } from './roles.ts';
import type { CollabStorage } from './storage.ts';

/** The one message kind the core speaks today. */
export const MSG_SYNC = 0;

/** What an action handler is given: the room and role come from the core. */
export interface ActionContext {
  roomId: string;
  principal: Principal;
  role: CollabRole;
  doc: Y.Doc;
}

/** May be async: the room stays open until a returned promise settles. */
export type ActionHandler = (ctx: ActionContext, body: Record<string, unknown>) => unknown;

/** An action is an edit unless the app marks it read-only. A read-only
 *  action may run for a `view` or `comment` principal, and is then given a
 *  copy of the doc, so nothing it does reaches the room. */
export type ActionSpec = ActionHandler | { run: ActionHandler; readOnly: true };

/** The app's own live docs, for an app that loads and saves them itself. */
export interface RoomDocs {
  /** The doc for a room, or null when the app has none (the connect is
   *  refused with `no-doc`). Asked each time a room opens. */
  open(roomId: string): Y.Doc | null;
}

export interface RoomHostOptions {
  /** Where the core loads and saves each room's doc. Give this or `docs`. */
  storage?: CollabStorage;
  /** The app's live docs, synced in place. Give this or `storage`. */
  docs?: RoomDocs;
  /** Required: the app's answer to who may be in a room, and as what. */
  role: RoleFn;
  /** How long after the last change a room is saved. Default 500 ms.
   *  Unused with `docs`: the app saves its own docs. */
  saveDelayMs?: number;
  /** Server actions the app offers, by name. */
  actions?: Record<string, ActionSpec>;
  /** Told when a save fails; the change stays in memory and is retried on
   *  the next change or `flush`. */
  onSaveError?: (roomId: string, err: unknown) => void;
}

/** What the app hands the core for one socket. */
export interface ConnectRequest {
  /** From the address the socket was opened on. */
  roomId: string;
  /** From the app's sign-in check. */
  principal: Principal;
  send: (bytes: Uint8Array) => void;
  /** What this connection's edits name as their transaction origin, so the
   *  app can tell who made a change. Defaults to an object of the core's.
   *  Connections sharing an origin are not sent each other's edits. */
  origin?: unknown;
  /** Called when `recheckRoles` finds this principal no longer has a role
   *  in the room; the app closes the socket. The core has already stopped
   *  serving it. */
  onRevoked?: () => void;
}

export interface CollabConnection {
  readonly roomId: string;
  readonly principal: Principal;
  readonly role: CollabRole;
  /** Feed one message the socket received. */
  receive(bytes: Uint8Array): void;
  /** The socket closed. */
  close(): void;
}

export type ConnectResult =
  | { ok: true; connection: CollabConnection }
  | { ok: false; error: 'bad-room' | 'no-role' | 'no-doc' };

export type ActionResult =
  | { ok: true; value: unknown }
  | {
      ok: false;
      error:
        | 'bad-room'
        | 'no-role'
        | 'no-doc'
        | 'read-only'
        | 'room-in-body'
        | 'unknown-action'
        | 'bad-body';
      message: string;
    };

export interface RoomHost {
  connect(req: ConnectRequest): ConnectResult;
  /** Run a server action in `roomId` as `principal`, both from the caller's
   *  connection or address. */
  action(roomId: string, principal: Principal, name: string, body: unknown): ActionResult;
  /** Ask the role function again for every open connection (in one room,
   *  or all). A connection whose role is now null is dropped and its
   *  `onRevoked` called; one whose role changed reads and writes under the
   *  new role. The hook for the identity step's revocation. */
  recheckRoles(roomId?: string): void;
  /** Save every room with unsaved changes now. */
  flush(): void;
  /** Ids of the rooms open now. */
  openRooms(): string[];
}

interface Room {
  id: string;
  doc: Y.Doc;
  conns: Set<Conn>;
  timer: ReturnType<typeof setTimeout> | null;
  dirty: boolean;
  /** Actions still running in the room (an async handler's promise). */
  pending: number;
  /** Stop listening to the doc. */
  detach: () => void;
}

interface Conn {
  origin: unknown;
  send: (bytes: Uint8Array) => void;
  recheck: () => void;
}

const syncFrame = (write: (enc: encoding.Encoder) => void): Uint8Array => {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MSG_SYNC);
  write(enc);
  return encoding.toUint8Array(enc);
};

const isThenable = (v: unknown): v is PromiseLike<unknown> =>
  typeof (v as { then?: unknown } | null)?.then === 'function';

export function createRoomHost(opts: RoomHostOptions): RoomHost {
  if (typeof opts?.role !== 'function') {
    throw new TypeError('createRoomHost needs a role function: no room opens without one');
  }
  const hasStorage = typeof opts.storage?.read === 'function';
  const hasDocs = typeof opts.docs?.open === 'function';
  if (hasStorage === hasDocs) {
    throw new TypeError('createRoomHost needs a storage or docs, and not both');
  }
  const { storage, docs, role } = opts;
  const saveDelayMs = opts.saveDelayMs ?? 500;
  const rooms = new Map<string, Room>();

  const save = (room: Room): void => {
    if (room.timer) clearTimeout(room.timer);
    room.timer = null;
    if (!room.dirty || !storage) return;
    try {
      storage.write(room.id, Y.encodeStateAsUpdate(room.doc));
      room.dirty = false;
    } catch (err) {
      opts.onSaveError?.(room.id, err);
    }
  };

  /** The room, opened if need be; null when the app holds no doc for it. */
  const open = (id: string): Room | null => {
    const existing = rooms.get(id);
    if (existing) return existing;
    let doc: Y.Doc;
    if (docs) {
      const held = docs.open(id);
      if (!held) return null;
      doc = held;
    } else {
      doc = new Y.Doc();
      const saved = storage?.read(id);
      if (saved) Y.applyUpdate(doc, saved);
    }
    const onUpdate = (update: Uint8Array, origin: unknown): void => {
      if (storage) {
        room.dirty = true;
        if (room.timer) clearTimeout(room.timer);
        room.timer = setTimeout(() => save(room), saveDelayMs);
      }
      const frame = syncFrame((enc) => syncProtocol.writeUpdate(enc, update));
      for (const c of room.conns) {
        if (c.origin === origin) continue;
        try {
          c.send(frame);
        } catch {
          // A socket that died mid-send: its close() is on its way.
        }
      }
    };
    const room: Room = {
      id,
      doc,
      conns: new Set(),
      timer: null,
      dirty: false,
      pending: 0,
      detach: () => doc.off('update', onUpdate),
    };
    doc.on('update', onUpdate);
    rooms.set(id, room);
    return room;
  };

  const release = (room: Room): void => {
    if (room.conns.size > 0 || room.pending > 0) return;
    save(room);
    if (room.dirty) return; // a failed save keeps the room, and its changes
    room.detach();
    // The app's own doc is the app's to keep; only a doc the core loaded goes.
    if (!docs) room.doc.destroy();
    rooms.delete(room.id);
  };

  return {
    connect(req) {
      if (typeof req.roomId !== 'string' || !ROOM_ID.test(req.roomId)) {
        return { ok: false, error: 'bad-room' };
      }
      const granted = role(req.principal, req.roomId);
      if (granted === null) return { ok: false, error: 'no-role' };
      const room = open(req.roomId);
      if (!room) return { ok: false, error: 'no-doc' };
      let current: CollabRole = granted;
      let writable = canEdit(granted);
      let closed = false;
      const conn: Conn = {
        origin: null,
        send: req.send,
        recheck: () => {
          if (closed) return;
          const now = role(req.principal, req.roomId);
          if (now === null) {
            connection.close();
            req.onRevoked?.();
            return;
          }
          current = now;
          writable = canEdit(now);
        },
      };
      conn.origin = req.origin ?? conn;
      room.conns.add(conn);
      req.send(syncFrame((enc) => syncProtocol.writeSyncStep1(enc, room.doc)));
      const connection: CollabConnection = {
        roomId: req.roomId,
        principal: req.principal,
        get role() {
          return current;
        },
        receive(bytes) {
          if (closed) return;
          try {
            const dec = decoding.createDecoder(bytes);
            if (decoding.readVarUint(dec) !== MSG_SYNC) return;
            if (!writable) {
              // Peek the sync message's kind: only a step 1 (a request for the
              // doc) is answered; a step 2 or update would change it.
              const kind = decoding.readVarUint(decoding.createDecoder(bytes.subarray(dec.pos)));
              if (kind !== syncProtocol.messageYjsSyncStep1) return;
            }
            const enc = encoding.createEncoder();
            encoding.writeVarUint(enc, MSG_SYNC);
            syncProtocol.readSyncMessage(dec, enc, room.doc, conn.origin);
            if (encoding.length(enc) > 1) req.send(encoding.toUint8Array(enc));
          } catch {
            // A truncated or garbled frame changes nothing; drop it.
          }
        },
        close() {
          if (closed) return;
          closed = true;
          room.conns.delete(conn);
          release(room);
        },
      };
      return { ok: true, connection };
    },

    action(roomId, principal, name, body) {
      if (typeof roomId !== 'string' || !ROOM_ID.test(roomId)) {
        return { ok: false, error: 'bad-room', message: 'The address names no room.' };
      }
      const named = roomKeyInBody(body);
      if (named !== null) {
        return {
          ok: false,
          error: 'room-in-body',
          message: `The body names "${named}". The room comes from the address or the connection, never the body.`,
        };
      }
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        return { ok: false, error: 'bad-body', message: 'The body must be an object.' };
      }
      const granted = role(principal, roomId);
      if (granted === null) {
        return { ok: false, error: 'no-role', message: 'You have no role in this room.' };
      }
      const spec =
        opts.actions && Object.hasOwn(opts.actions, name) ? opts.actions[name] : undefined;
      if (!spec) {
        return { ok: false, error: 'unknown-action', message: `No action "${name}".` };
      }
      const readOnly = typeof spec !== 'function';
      const run = typeof spec === 'function' ? spec : spec.run;
      if (!readOnly && !canEdit(granted)) {
        return {
          ok: false,
          error: 'read-only',
          message: `A ${granted} role cannot run "${name}".`,
        };
      }
      const room = open(roomId);
      if (!room) {
        return { ok: false, error: 'no-doc', message: 'This room has no doc.' };
      }
      // A read-only action run by a reader gets a copy: nothing it does can
      // reach the room.
      const doc = canEdit(granted) ? room.doc : new Y.Doc();
      if (doc !== room.doc) Y.applyUpdate(doc, Y.encodeStateAsUpdate(room.doc));
      room.pending++;
      const finish = (): void => {
        room.pending--;
        if (doc !== room.doc) doc.destroy();
        release(room);
      };
      let value: unknown;
      try {
        value = run({ roomId, principal, role: granted, doc }, body as Record<string, unknown>);
      } catch (err) {
        finish();
        throw err;
      }
      if (isThenable(value)) value.then(finish, finish);
      else finish();
      return { ok: true, value };
    },

    recheckRoles(roomId) {
      for (const room of [...rooms.values()]) {
        if (roomId === undefined || room.id === roomId) {
          for (const c of [...room.conns]) c.recheck();
        }
      }
    },

    flush() {
      for (const room of rooms.values()) save(room);
    },

    openRooms() {
      return [...rooms.keys()];
    },
  };
}
