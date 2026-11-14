import { MSG_PROBE } from '@claude-workspaces/core/ws-probe';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import { clientStateIsDead, peekSyncFrame } from './board-sync-gate.ts';
import type { FeedbackWs, LiveDoc } from './doc-store.ts';
import {
  type AwarenessEntry,
  LOCAL_GUEST_SCOPE,
  type PresenceStamp,
  type PresenceUser,
  encodeAwarenessEntries,
  isGuestStamp,
  stampAwarenessUpdate,
} from './presence-identity.ts';
import { captureServerError } from './sentry.ts';

/**
 * Minimal y-websocket protocol implementation for Bun's native WebSocket.
 * Framing: messages are Uint8Array with a leading varuint indicating kind.
 *   0 = sync  (see y-protocols/sync)
 *   1 = awareness (see y-protocols/awareness)
 *   2 = reset (server → client; this file, below)
 *   3 = probe (either way; `core/src/ws-probe.ts`)
 */

export const MSG_SYNC = 0;
export const MSG_AWARENESS = 1;
/**
 * "The state you are holding is dead — start over."
 *
 * Sent to a tab whose sync step 1 offers a state vector a rebuilt board doc
 * shares nothing with. Payload-free: there is exactly one thing to say and
 * the client's only useful answer is to drop what it has, so a body would be
 * a field nobody reads.
 *
 * A kind rather than a close code, because closing only makes the same tab
 * reconnect with the same dead doc. A client too old to know this kind
 * ignores it — `ws-client.ts` falls through on an unknown kind — and is
 * caught instead by the stale-build notice, which fires on the same reconnect
 * for the same reason: an old tab is by definition one that was open across
 * the deploy that shipped this.
 */
export const MSG_RESET = 2;

/**
 * Per-connection state attached to the WebSocket. We track the set of
 * Yjs client IDs that have contributed awareness via this specific WS
 * so we only remove those on disconnect — not every peer's awareness.
 */
type WsState = {
  cleanup?: () => void;
  /** clientIDs we've seen incoming awareness from on this ws. */
  knownClientIds: Set<number>;
  /**
   * This connection offered a state vector a rebuilt board doc shares nothing
   * with, so nothing it pushes may be merged.
   *
   * Per CONNECTION, not per doc: another tab on the same board may be
   * perfectly current, and the whole point is to refuse one client's history
   * without refusing anybody else's. Set once, when its step 1 arrives, which
   * is always before the step 2 that answers ours — the client sends step 1
   * from its `open` handler and step 2 only from a later `message`.
   */
  deadState?: boolean;
  /** The name this socket's last state was stamped with: who holds its
   *  client ids, when another socket asks to take one over. */
  presence?: PresenceUser;
};

/** Every open socket and its doc, so a rename can reach the pages already
 *  showing the old name (`restampPerson`). */
const openSockets = new Map<FeedbackWs, LiveDoc>();

/**
 * Put a person's new name on every open socket they proved, and on the
 * states those sockets already announced, so every other page shows it now
 * rather than at the page's next renewal. Each state is re-applied one clock
 * ahead with the socket as its origin, so the socket's own page is not sent
 * its state back; the page's next frame is raised past that clock
 * (`clockFor` below). Returns how many sockets it changed.
 */
export function restampPerson(personId: string, name: string): number {
  let changed = 0;
  for (const [ws, doc] of openSockets) {
    const stamp = ws.data.presenceUser;
    if (!stamp || isGuestStamp(stamp) || stamp.id !== personId) continue;
    ws.data.presenceUser = { ...stamp, name };
    const st = state(ws);
    if (st.presence) st.presence = { ...st.presence, name };
    const states = doc.awareness.getStates();
    const entries: AwarenessEntry[] = [];
    for (const id of st.knownClientIds) {
      const cur = states.get(id) as { user?: Record<string, unknown> } | undefined;
      if (!cur) continue;
      entries.push({
        clientId: id,
        clock: (doc.awareness.meta.get(id)?.clock ?? 0) + 1,
        json: JSON.stringify({ ...cur, user: { ...cur.user, name } }),
      });
    }
    if (entries.length > 0) {
      awarenessProtocol.applyAwarenessUpdate(doc.awareness, encodeAwarenessEntries(entries), ws);
    }
    changed++;
  }
  return changed;
}

function state(ws: FeedbackWs): WsState {
  const typed = ws as FeedbackWs & { _state?: WsState };
  if (!typed._state) typed._state = { knownClientIds: new Set() };
  return typed._state;
}

/**
 * The name this connection's presence announces (`user.name` in its
 * awareness state), or undefined. The server set it: `onMessage` stamps
 * every state a socket sends with that socket's `presenceUser`
 * (`presence-identity.ts`). Read by `edit-sessions.ts` for a socket that
 * proved no identity.
 */
export function announcedNameOf(doc: LiveDoc, ws: FeedbackWs): string | undefined {
  const states = doc.peekAwareness()?.getStates();
  if (!states) return undefined;
  for (const id of state(ws).knownClientIds) {
    const user = (states.get(id) as { user?: { name?: unknown } } | undefined)?.user;
    if (typeof user?.name === 'string' && user.name.trim() !== '') return user.name.trim();
  }
  return undefined;
}

/** The rule this socket's states are stamped with. A socket its upgrade
 *  stamped nothing on is a guest — fail closed. */
const FALLBACK_STAMP: PresenceStamp = { kind: 'guest', verified: false, scope: LOCAL_GUEST_SCOPE };
function stampOf(ws: FeedbackWs): PresenceStamp {
  return ws.data.presenceUser ?? FALLBACK_STAMP;
}

/**
 * Whether `ws` may carry an entry for `clientId`, stamped `user` (null for a
 * removal). Never the server's own slot. A client id another open socket
 * holds may be taken over only when:
 *  - its state is gone, so nobody is using it;
 *  - both sockets are the same person: y-websocket keeps one client id across
 *    a reconnect, and the old socket may sit half-open for minutes.
 * Accepted ids are added to `accepted`; the caller moves them to `ws`.
 */
function carryRule(
  doc: LiveDoc,
  ws: FeedbackWs,
  accepted: Set<number>,
): (clientId: number, user: PresenceUser | null) => boolean {
  return (clientId, user) => {
    if (clientId === doc.awareness.clientID) return false;
    const mine = user ?? state(ws).presence;
    const live = doc.awareness.getStates().has(clientId);
    for (const peer of doc.conns) {
      if (peer === ws || !state(peer).knownClientIds.has(clientId)) continue;
      if (!live) continue;
      const held = state(peer).presence;
      if (held === undefined || mine === undefined || held.id !== mine.id) return false;
    }
    accepted.add(clientId);
    if (user) state(ws).presence = user;
    return true;
  };
}

/** Forget a removed client id on every socket, so a state the outdated
 *  sweep dropped does not stay pinned to a socket that went quiet. */
function forgetRemoved(doc: LiveDoc, removed: number[]): void {
  if (removed.length === 0) return;
  for (const peer of doc.conns) {
    const known = state(peer).knownClientIds;
    for (const id of removed) known.delete(id);
  }
}

/**
 * One broadcaster per doc (not per connection). When the doc's Y.Doc
 * or Awareness emits an update, send it to every connection *except*
 * the origin connection. Registering N handlers with per-ws closures
 * (the previous approach) skipped the wrong peer on the broadcast loop —
 * updates originating from peer B never reached peer A.
 */
const docBroadcasters = new WeakMap<LiveDoc, () => void>();

function ensureBroadcaster(doc: LiveDoc): void {
  if (docBroadcasters.has(doc)) return;
  const onUpdate = (update: Uint8Array, origin: unknown) => {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.writeUpdate(enc, update);
    const payload = encoding.toUint8Array(enc);
    for (const peer of doc.conns) {
      if (peer === origin || peer.data.presenceOnly) continue;
      try {
        peer.sendBinary(payload, true);
      } catch (e) {
        console.error('[ws] doc send failed', e);
      }
    }
  };
  const onAwareness = (
    { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ) => {
    forgetRemoved(doc, removed);
    const ids = [...added, ...updated, ...removed];
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_AWARENESS);
    encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(doc.awareness, ids));
    const payload = encoding.toUint8Array(enc);
    for (const peer of doc.conns) {
      if (peer === origin) continue;
      try {
        peer.sendBinary(payload, true);
      } catch (e) {
        console.error('[ws] awareness send failed', e);
      }
    }
  };
  doc.ydoc.on('update', onUpdate);
  doc.awareness.on('update', onAwareness);
  // Keep the handlers alive for the life of the server; docs are long-lived.
  docBroadcasters.set(doc, () => {
    doc.ydoc.off('update', onUpdate);
    doc.awareness.off('update', onAwareness);
  });
}

export function onOpen(doc: LiveDoc, ws: FeedbackWs): void {
  ensureBroadcaster(doc);
  doc.conns.add(ws);
  openSockets.set(ws, doc);

  // sync step 1 — ask the client for updates it has that we don't. A
  // presence-only socket is asked about an empty doc, so it never offers us
  // anything and is never told how far the board doc has got.
  {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.writeSyncStep1(enc, ws.data.presenceOnly ? EMPTY_DOC : doc.ydoc);
    ws.sendBinary(encoding.toUint8Array(enc), true);
  }

  // send current awareness state
  const states = doc.awareness.getStates();
  if (states.size > 0) {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_AWARENESS);
    encoding.writeVarUint8Array(
      enc,
      awarenessProtocol.encodeAwarenessUpdate(doc.awareness, Array.from(states.keys())),
    );
    ws.sendBinary(encoding.toUint8Array(enc), true);
  }

  state(ws).cleanup = () => {
    const { knownClientIds } = state(ws);
    if (knownClientIds.size > 0) {
      awarenessProtocol.removeAwarenessStates(doc.awareness, Array.from(knownClientIds), ws);
    }
    doc.conns.delete(ws);
    openSockets.delete(ws);
  };
}

/** The doc a presence-only socket is synced against: always empty. */
const EMPTY_DOC = new Y.Doc();

/**
 * A presence-only socket's sync frame (`WsCtx.presenceOnly`). Its step 1 is
 * answered with an empty doc's step 2, so the client counts itself synced
 * and holds nothing; its step 2 and updates are dropped. Nothing it says
 * can reach the board doc, and nothing of the board doc reaches it.
 */
function answerPresenceOnly(ws: FeedbackWs, dec: decoding.Decoder): void {
  if (decoding.readVarUint(dec) !== syncProtocol.messageYjsSyncStep1) return;
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MSG_SYNC);
  syncProtocol.writeSyncStep2(enc, EMPTY_DOC);
  ws.sendBinary(encoding.toUint8Array(enc), true);
}

/**
 * The board-doc gate: mark a connection whose state is dead, and drop what it
 * tries to push afterwards. Returns true when the frame must not be handled.
 *
 * Step 1 is never dropped — the client still gets its step 2 and paints
 * current content while it reloads. What is dropped is the step 2 and the
 * updates, which is precisely the 5 MB of history the doc just shed. See
 * board-sync-gate.ts for why this is a `ws:`-only judgement.
 */
function refuseDeadState(doc: LiveDoc, ws: FeedbackWs, data: Uint8Array): boolean {
  const parsed = peekSyncFrame(data);
  if (parsed === null) return false;
  if (parsed.stateVector !== null) {
    if (
      clientStateIsDead({
        docId: doc.docId,
        clientStateVector: parsed.stateVector,
        docStateVector: Y.encodeStateVector(doc.ydoc),
      })
    ) {
      state(ws).deadState = true;
      console.log(`[ws] ${doc.docId}: a client's state shares nothing with this doc; reset`);
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_RESET);
      try {
        ws.sendBinary(encoding.toUint8Array(enc), true);
      } catch (e) {
        console.error('[ws] reset send failed', e);
      }
    }
    return false;
  }
  return state(ws).deadState === true;
}

export function onMessage(doc: LiveDoc, ws: FeedbackWs, data: Uint8Array): void {
  try {
    const dec = decoding.createDecoder(data);
    const kind = decoding.readVarUint(dec);
    const enc = encoding.createEncoder();
    switch (kind) {
      case MSG_SYNC: {
        if (ws.data.presenceOnly) {
          answerPresenceOnly(ws, dec);
          return;
        }
        if (refuseDeadState(doc, ws, data)) return;
        encoding.writeVarUint(enc, MSG_SYNC);
        if (ws.data.readOnly) {
          // A socket that may read and may not write (`WsCtx.readOnly`).
          //
          // Step 1 is the READ — the client asking what it is missing, which
          // we answer with step 2 and the whole doc. Step 2 and update are
          // the client TELLING US something, and those are dropped: they are
          // the only two frames `readSyncMessage` would have applied to the
          // ydoc, so decoding the sub-kind here and answering only step 1 is
          // exactly "reading unchanged, writing refused" with nothing else
          // altered.
          //
          // Dropped in silence on the wire, and loudly in the UI: the client
          // has already asked `/api/auth/session` whether it may write and
          // has stayed in view mode with a sign-in bar if not, so nothing
          // legitimate reaches this branch. What does reach it is a client
          // that ignored the answer, and it gets what it should — no write.
          const step = decoding.readVarUint(dec);
          if (step === syncProtocol.messageYjsSyncStep1) {
            syncProtocol.readSyncStep1(dec, enc, doc.ydoc);
          }
        } else {
          syncProtocol.readSyncMessage(dec, enc, doc.ydoc, ws);
        }
        if (encoding.length(enc) > 1) {
          ws.sendBinary(encoding.toUint8Array(enc), true);
        }
        return;
      }
      case MSG_AWARENESS: {
        // The server sets the name: every state gets this socket's stamp, and
        // an entry for another socket's client id or the server's own is
        // dropped (`presence-identity.ts`).
        const accepted = new Set<number>();
        const payload = stampAwarenessUpdate(decoding.readVarUint8Array(dec), {
          stamp: stampOf(ws),
          mayCarry: carryRule(doc, ws, accepted),
          clockFor: (id, clock) => Math.max(clock, (doc.awareness.meta.get(id)?.clock ?? -1) + 1),
        });
        if (payload === null) return;
        awarenessProtocol.applyAwarenessUpdate(doc.awareness, payload, ws);
        // Track which client IDs this ws is contributing so disconnect only
        // removes *their* awareness states, not every peer's. A taken-over id
        // leaves the socket that held it, so that socket's close keeps it.
        const live = doc.awareness.getStates();
        const own = state(ws).knownClientIds;
        for (const id of accepted) {
          for (const peer of doc.conns) if (peer !== ws) state(peer).knownClientIds.delete(id);
          if (live.has(id)) own.add(id);
        }
        return;
      }
      case MSG_PROBE: {
        encoding.writeVarUint(enc, MSG_PROBE);
        ws.sendBinary(encoding.toUint8Array(enc), true);
        return;
      }
      default:
        console.warn('[ws] unknown message kind', kind);
    }
  } catch (err) {
    console.error('[ws] message handler error:', err);
    // The sync flow's error path — a genuine desync/protocol bug, not the
    // expected-on-disconnect send failures above (those stay off Sentry on
    // purpose; a peer closing mid-broadcast would otherwise spam it). No
    // docId, no content — a sync protocol error doesn't need either to be
    // actionable.
    captureServerError(err, { phase: 'ws.message' });
  }
}

export function onClose(ws: FeedbackWs): void {
  state(ws).cleanup?.();
}
