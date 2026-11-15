/**
 * The collab core's room host serving Workspaces' doc and board sockets, for
 * the boards `collab-core-switch.ts` turns on (D1 step 5).
 *
 * The core takes the sync half of the socket: the room, the sync step 1 sent
 * at connect, the answers to a page's sync frames, the role gate on writes,
 * and the fan-out of every change to the room's connections. Everything else
 * a socket carries stays where it was (`yjs-protocol.ts`): presence, the
 * access frame, the probe, the board's dead-state reset and the per-frame
 * write gate (`socket-write-gate.ts`), which runs before a frame reaches the
 * core. That is why a switched-on board looks and behaves the same.
 *
 * One doc, one store. The host is built over the doc store's LIVE docs
 * (`docs`, not `storage`): a room syncs the same Y.Doc the store hydrated,
 * and the store persists it to the same `.ydoc` through its doc state store
 * on the same debounce and on shutdown. A second Y.Doc for the same id would
 * diverge from the store's, so the core never loads or saves one here, and
 * turning a board's switch off loses nothing.
 *
 * The socket is each edit's transaction origin, as on the current path, so
 * edit attribution (`edit-sessions.ts`) and the current path's broadcaster,
 * which skips core sockets and an edit's own socket, read it unchanged.
 */
import { createHash } from 'node:crypto';
import {
  type CollabConnection,
  type CollabRole,
  type Principal,
  type RoomHost,
  createRoomHost,
} from '@claude-workspaces/core/collab';
import type * as Y from 'yjs';
import type { CollabRooms } from './collab-rooms.ts';
import type { FeedbackWs, LiveDoc } from './doc-store.ts';

/** Close code for "the doc you were synced to was replaced; reconnect". */
const DOC_REPLACED = 1012;

/** A doc id as a core room id: the core admits `[A-Za-z0-9_-]{1,128}`, and
 *  doc ids carry `:`, `.` and `~`. A digest, so every id fits and two ids
 *  never share a room. */
export function roomIdOf(docId: string): string {
  return createHash('sha256').update(docId).digest('base64url');
}

/** The principal the core is handed: the socket itself, which the role
 *  function reads. Opaque to the core. */
interface SocketPrincipal extends Principal {
  ws: FeedbackWs;
}

/** The role a socket's upgrade decided. The comment and view roles a
 *  board's access names are judged by the write gate before the core, under
 *  the board's roles mode, so the core sees them as `edit`; a read-only
 *  socket is `view`, so the core answers its reads and drops its writes. */
function roleOfSocket(ws: FeedbackWs): CollabRole {
  return ws.data.readOnly ? 'view' : 'edit';
}

export interface CollabCorePathOptions {
  /** The store's resident doc for an id, never hydrating one (`DocStore.peek`). */
  getDoc: (docId: string) => LiveDoc | undefined;
  /** Registered so every revoke rechecks this host's connections. */
  rooms: CollabRooms;
}

/** What `yjs-protocol.ts` calls for a socket stamped `core`. */
export interface CoreSync {
  /** Join the socket to the room of `doc`, the store's doc it addressed,
   *  and send the room's sync step 1. False when the core refused it: the
   *  caller uses the current code instead. */
  open(ws: FeedbackWs, doc: LiveDoc): boolean;
  /** One sync frame the socket sent, already past the write gate. */
  receive(ws: FeedbackWs, data: Uint8Array): void;
  /** The socket closed. */
  close(ws: FeedbackWs): void;
}

interface Held {
  connection: CollabConnection;
  docId: string;
  ydoc: Y.Doc;
}

export class CollabCorePath implements CoreSync {
  private readonly host: RoomHost;
  private readonly held = new WeakMap<FeedbackWs, Held>();
  /** Room id → doc id, for the rooms open now. */
  private readonly docOfRoom = new Map<string, string>();

  constructor(private readonly opts: CollabCorePathOptions) {
    this.host = createRoomHost({
      role: (who) => roleOfSocket((who as SocketPrincipal).ws),
      docs: {
        open: (roomId) => {
          const docId = this.docOfRoom.get(roomId);
          return docId === undefined ? null : (opts.getDoc(docId)?.ydoc ?? null);
        },
      },
    });
    opts.rooms.register(this.host);
  }

  open(ws: FeedbackWs, doc: LiveDoc): boolean {
    // The store's own id, not the address: an alias and its doc share a room.
    const docId = doc.docId;
    const roomId = roomIdOf(docId);
    this.docOfRoom.set(roomId, docId);
    const principal: SocketPrincipal = { id: `socket:${docId}`, ws };
    const result = this.host.connect({
      roomId,
      principal,
      origin: ws,
      send: (bytes) => {
        ws.sendBinary(bytes, true);
      },
      onRevoked: () => ws.close(1008, 'revoked'),
    });
    if (!result.ok) {
      this.forgetIfEmpty(roomId);
      return false;
    }
    this.held.set(ws, { connection: result.connection, docId, ydoc: doc.ydoc });
    return true;
  }

  receive(ws: FeedbackWs, data: Uint8Array): void {
    const h = this.held.get(ws);
    if (!h) return;
    // The store replaced this doc (a rebuild or a rehydrate): the room still
    // holds the old one, so the socket is sent back to reconnect.
    if (this.opts.getDoc(h.docId)?.ydoc !== h.ydoc) {
      this.close(ws);
      ws.close(DOC_REPLACED, 'doc replaced');
      return;
    }
    h.connection.receive(data);
  }

  close(ws: FeedbackWs): void {
    const h = this.held.get(ws);
    if (!h) return;
    this.held.delete(ws);
    h.connection.close();
    this.forgetIfEmpty(h.connection.roomId);
  }

  /** Doc ids of the rooms the core holds open now. */
  openRooms(): string[] {
    return this.host.openRooms().map((r) => this.docOfRoom.get(r) ?? r);
  }

  private forgetIfEmpty(roomId: string): void {
    if (!this.host.openRooms().includes(roomId)) this.docOfRoom.delete(roomId);
  }
}
