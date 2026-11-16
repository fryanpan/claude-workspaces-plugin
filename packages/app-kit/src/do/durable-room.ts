import type * as Y from 'yjs';
/**
 * The collab core inside a Cloudflare Durable Object that hibernates.
 *
 * The core's room host keeps its rooms and connections in memory. A Durable
 * Object that hibernates loses that memory while its WebSockets stay open,
 * and comes back as a new instance. So each socket carries its own grant (the
 * room, the person and the role the Worker's sign-in check decided) as its
 * attachment, and a new instance re-connects every socket it is handed
 * (`getWebSockets`) from those attachments. The core sends each re-connected
 * socket a sync step 1, the page answers with whatever the server lacks, and
 * nothing new goes on the wire.
 *
 * The adapter never authenticates. The Worker checks the person's session and
 * their access to the room before it forwards the upgrade, and hands the
 * grant to `accept`. `revoke` takes a person's access away from every open
 * socket at once, and `closeRoom` ends every socket in one room with a code
 * the page reads (4400 to 4499: the doc is gone, do not reconnect).
 *
 * Types are structural, so this file imports nothing from the Workers
 * runtime and runs (and is tested) anywhere.
 */
import {
  type ActionResult,
  type ActionSpec,
  type CollabConnection,
  type CollabRole,
  type CollabStorage,
  type Principal,
  ROOM_ID,
  type RoomDocs,
  type RoomHost,
  createRoomHost,
} from '../collab/index.ts';

/** The slice of a Workers WebSocket the adapter uses. */
export interface HibernatingSocket {
  send(data: ArrayBuffer | ArrayBufferView | string): void;
  close(code?: number, reason?: string): void;
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
}

/** The slice of `DurableObjectState` the adapter uses. */
export interface HibernationContext<WS extends HibernatingSocket> {
  acceptWebSocket(ws: WS): void;
  getWebSockets(): WS[];
}

/** What the Worker decided about one socket, kept as its attachment. */
export interface SocketGrant {
  roomId: string;
  principal: Principal;
  role: CollabRole;
}

export interface DurableRoomOptions<WS extends HibernatingSocket> {
  ctx: HibernationContext<WS>;
  /** Where each room's doc is saved. Give this or `docs`. With `storage`
   *  the room is saved after every message, because a Durable Object can be
   *  evicted with a save timer still pending. */
  storage?: CollabStorage;
  /** The app's own live docs (for example `markdownFileRoom`'s), which it
   *  saves itself. Give this or `storage`. */
  docs?: RoomDocs;
  actions?: Record<string, ActionSpec>;
  onSaveError?: (roomId: string, err: unknown) => void;
}

export type AcceptResult = { ok: true } | { ok: false; error: string };

export interface DurableRoom<WS extends HibernatingSocket> {
  readonly host: RoomHost;
  /** Take a socket the Worker has already admitted. Accepts it for
   *  hibernation, keeps the grant as its attachment and connects it. */
  accept(ws: WS, grant: SocketGrant): AcceptResult;
  /** `webSocketMessage`: feed one message. Text messages are ignored. */
  message(ws: WS, data: ArrayBuffer | ArrayBufferView | string): void;
  /** `webSocketClose` / `webSocketError`. */
  close(ws: WS): void;
  /** Take `principalId`'s access away: every socket of theirs is dropped
   *  and closed with 1008. Returns how many sockets were closed. */
  revoke(principalId: string): number;
  /** Close every socket in `roomId` with `code` and `reason`, and drop its
   *  connection. A code from 4400 to 4499 tells the kit's page client the
   *  doc is gone for good, so it does not reconnect (for example 4410 when
   *  the doc's file was deleted). `code` must be 1000 or 3000 to 4999, and
   *  `reason` at most 123 bytes. Returns how many sockets were closed. */
  closeRoom(roomId: string, code: number, reason?: string): number;
  /** A standing role for a principal that holds no socket, such as the
   *  agent. Kept in memory: grant it again in the constructor. */
  grant(principal: Principal, role: CollabRole): void;
  /** Run one of the app's actions in `roomId` as `principal`. */
  action(roomId: string, principal: Principal, name: string, body: unknown): ActionResult;
  /** Read a room's doc on the server, opening the room if need be. */
  read<T>(roomId: string, fn: (doc: Y.Doc) => T): ActionResult;
  /** Save every room with unsaved changes now. */
  flush(): void;
}

/** The principal `read` runs as. */
export const SERVER_PRINCIPAL: Principal = { id: 'server:durable-room', name: 'Server' };

const READ_ACTION = 'cw.server-read';

function grantOf(value: unknown): SocketGrant | null {
  if (!value || typeof value !== 'object') return null;
  const g = value as Partial<SocketGrant>;
  const p = g.principal as Partial<Principal> | undefined;
  if (typeof g.roomId !== 'string' || !ROOM_ID.test(g.roomId)) return null;
  if (!p || typeof p.id !== 'string' || p.id === '') return null;
  if (g.role !== 'owner' && g.role !== 'edit' && g.role !== 'comment' && g.role !== 'view') {
    return null;
  }
  return {
    roomId: g.roomId,
    principal: typeof p.name === 'string' ? { id: p.id, name: p.name } : { id: p.id },
    role: g.role,
  };
}

const key = (principalId: string, roomId: string): string => `${principalId}\u0000${roomId}`;

export function createDurableRoom<WS extends HibernatingSocket>(
  opts: DurableRoomOptions<WS>,
): DurableRoom<WS> {
  /** Roles held by sockets, from their attachments. */
  const socketRoles = new Map<string, CollabRole>();
  /** Roles held without a socket: `grant` and the server's own reads. */
  const standing = new Map<string, CollabRole>();
  const revoked = new Set<string>();
  const conns = new Map<WS, CollabConnection>();
  /** The room each connected socket is in. */
  const roomOf = new Map<WS, string>();
  let reader: ((doc: Y.Doc) => unknown) | null = null;

  const host = createRoomHost({
    ...(opts.storage ? { storage: opts.storage } : {}),
    ...(opts.docs ? { docs: opts.docs } : {}),
    role: (who, roomId) => {
      if (revoked.has(who.id)) return null;
      if (who.id === SERVER_PRINCIPAL.id) return 'owner';
      return standing.get(who.id) ?? socketRoles.get(key(who.id, roomId)) ?? null;
    },
    actions: {
      ...opts.actions,
      [READ_ACTION]: {
        readOnly: true,
        run: (ctx) => (reader ? reader(ctx.doc) : undefined),
      },
    },
    ...(opts.onSaveError ? { onSaveError: opts.onSaveError } : {}),
  });

  const save = (): void => {
    if (opts.storage) host.flush();
  };

  const connect = (ws: WS, grant: SocketGrant): AcceptResult => {
    socketRoles.set(key(grant.principal.id, grant.roomId), grant.role);
    const res = host.connect({
      roomId: grant.roomId,
      principal: grant.principal,
      send: (bytes) => ws.send(bytes),
      onRevoked: () => {
        conns.delete(ws);
        roomOf.delete(ws);
        try {
          ws.close(1008, 'revoked');
        } catch {
          // Already closing.
        }
      },
    });
    if (!res.ok) return { ok: false, error: res.error };
    conns.set(ws, res.connection);
    roomOf.set(ws, grant.roomId);
    return { ok: true };
  };

  // A new instance: put back every socket the runtime kept open for us.
  for (const ws of opts.ctx.getWebSockets()) {
    const grant = grantOf(ws.deserializeAttachment());
    if (!grant || !connect(ws, grant).ok) {
      try {
        ws.close(1008, 'no grant');
      } catch {
        // Already closing.
      }
    }
  }

  return {
    host,
    accept(ws, grant) {
      const checked = grantOf(grant);
      if (!checked) return { ok: false, error: 'bad-grant' };
      revoked.delete(checked.principal.id);
      opts.ctx.acceptWebSocket(ws);
      ws.serializeAttachment(checked);
      const res = connect(ws, checked);
      if (!res.ok) ws.close(1008, res.error);
      return res;
    },
    message(ws, data) {
      if (typeof data === 'string') return;
      const conn = conns.get(ws);
      if (!conn) return;
      const bytes =
        data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      conn.receive(bytes);
      save();
    },
    close(ws) {
      const conn = conns.get(ws);
      conns.delete(ws);
      roomOf.delete(ws);
      conn?.close();
    },
    closeRoom(roomId, code, reason = '') {
      if (code !== 1000 && !(Number.isInteger(code) && code >= 3000 && code <= 4999)) {
        throw new RangeError(`close code ${code} is not 1000 or 3000 to 4999`);
      }
      if (new TextEncoder().encode(reason).length > 123) {
        throw new RangeError('close reason is longer than 123 bytes');
      }
      let closed = 0;
      for (const [ws, room] of [...roomOf]) {
        if (room !== roomId) continue;
        const conn = conns.get(ws);
        conns.delete(ws);
        roomOf.delete(ws);
        conn?.close();
        try {
          ws.close(code, reason);
        } catch {
          // Already closing.
        }
        closed++;
      }
      return closed;
    },
    revoke(principalId) {
      const before = conns.size;
      revoked.add(principalId);
      standing.delete(principalId);
      for (const k of [...socketRoles.keys()]) {
        if (k.startsWith(`${principalId}\u0000`)) socketRoles.delete(k);
      }
      host.recheckRoles();
      return before - conns.size;
    },
    grant(principal, role) {
      revoked.delete(principal.id);
      standing.set(principal.id, role);
    },
    action(roomId, principal, name, body) {
      const res = host.action(roomId, principal, name, body);
      save();
      return res;
    },
    read(roomId, fn) {
      reader = fn;
      try {
        return host.action(roomId, SERVER_PRINCIPAL, READ_ACTION, {});
      } finally {
        reader = null;
      }
    },
    flush: () => host.flush(),
  };
}
