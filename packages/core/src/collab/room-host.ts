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
 * A `view` or `comment` connection receives the doc and can never change it:
 * its sync step 2 and update messages are dropped before they are read.
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

export type ActionHandler = (ctx: ActionContext, body: Record<string, unknown>) => unknown;

export interface RoomHostOptions {
  storage: CollabStorage;
  /** Required: the app's answer to who may be in a room, and as what. */
  role: RoleFn;
  /** How long after the last change a room is saved. Default 500 ms. */
  saveDelayMs?: number;
  /** Server actions the app offers, by name. */
  actions?: Record<string, ActionHandler>;
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
  | { ok: false; error: 'bad-room' | 'no-role' };

export type ActionResult =
  | { ok: true; value: unknown }
  | {
      ok: false;
      error: 'bad-room' | 'no-role' | 'room-in-body' | 'unknown-action' | 'bad-body';
      message: string;
    };

export interface RoomHost {
  connect(req: ConnectRequest): ConnectResult;
  /** Run a server action in `roomId` as `principal`, both from the caller's
   *  connection or address. */
  action(roomId: string, principal: Principal, name: string, body: unknown): ActionResult;
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
}

interface Conn {
  send: (bytes: Uint8Array) => void;
}

const syncFrame = (write: (enc: encoding.Encoder) => void): Uint8Array => {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MSG_SYNC);
  write(enc);
  return encoding.toUint8Array(enc);
};

export function createRoomHost(opts: RoomHostOptions): RoomHost {
  if (typeof opts?.role !== 'function') {
    throw new TypeError('createRoomHost needs a role function: no room opens without one');
  }
  if (!opts.storage || typeof opts.storage.read !== 'function') {
    throw new TypeError('createRoomHost needs a storage');
  }
  const { storage, role } = opts;
  const saveDelayMs = opts.saveDelayMs ?? 500;
  const rooms = new Map<string, Room>();

  const save = (room: Room): void => {
    if (room.timer) clearTimeout(room.timer);
    room.timer = null;
    if (!room.dirty) return;
    try {
      storage.write(room.id, Y.encodeStateAsUpdate(room.doc));
      room.dirty = false;
    } catch (err) {
      opts.onSaveError?.(room.id, err);
    }
  };

  const open = (id: string): Room => {
    const existing = rooms.get(id);
    if (existing) return existing;
    const doc = new Y.Doc();
    const saved = storage.read(id);
    if (saved) Y.applyUpdate(doc, saved);
    const room: Room = { id, doc, conns: new Set(), timer: null, dirty: false };
    doc.on('update', (update: Uint8Array, origin: unknown) => {
      const frame = syncFrame((enc) => syncProtocol.writeUpdate(enc, update));
      for (const c of room.conns) if (c !== origin) c.send(frame);
      room.dirty = true;
      if (room.timer) clearTimeout(room.timer);
      room.timer = setTimeout(() => save(room), saveDelayMs);
    });
    rooms.set(id, room);
    return room;
  };

  const release = (room: Room): void => {
    if (room.conns.size > 0) return;
    save(room);
    if (room.dirty) return; // a failed save keeps the room, and its changes
    room.doc.destroy();
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
      const conn: Conn = { send: req.send };
      room.conns.add(conn);
      const writable = canEdit(granted);
      let closed = false;
      req.send(syncFrame((enc) => syncProtocol.writeSyncStep1(enc, room.doc)));
      const connection: CollabConnection = {
        roomId: req.roomId,
        principal: req.principal,
        role: granted,
        receive(bytes) {
          if (closed) return;
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
          syncProtocol.readSyncMessage(dec, enc, room.doc, conn);
          if (encoding.length(enc) > 1) req.send(encoding.toUint8Array(enc));
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
      const handler =
        opts.actions && Object.hasOwn(opts.actions, name) ? opts.actions[name] : undefined;
      if (!handler) {
        return { ok: false, error: 'unknown-action', message: `No action "${name}".` };
      }
      const room = open(roomId);
      try {
        return {
          ok: true,
          value: handler(
            { roomId, principal, role: granted, doc: room.doc },
            body as Record<string, unknown>,
          ),
        };
      } finally {
        release(room);
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
