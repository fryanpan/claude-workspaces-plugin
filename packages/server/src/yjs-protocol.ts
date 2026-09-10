import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import { clientStateIsDead, peekSyncFrame } from './board-sync-gate.ts';
import type { FeedbackWs, LiveDoc } from './doc-store.ts';
import { captureServerError } from './sentry.ts';

/**
 * Minimal y-websocket protocol implementation for Bun's native WebSocket.
 * Framing: messages are Uint8Array with a leading varuint indicating kind.
 *   0 = sync  (see y-protocols/sync)
 *   1 = awareness (see y-protocols/awareness)
 *   2 = reset (server → client; this file, below)
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
};

function state(ws: FeedbackWs): WsState {
  const typed = ws as FeedbackWs & { _state?: WsState };
  if (!typed._state) typed._state = { knownClientIds: new Set() };
  return typed._state;
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
      if (peer === origin) continue;
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

  // sync step 1 — ask the client for updates it has that we don't
  {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.writeSyncStep1(enc, doc.ydoc);
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
  };
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
        const payload = decoding.readVarUint8Array(dec);
        // Track which client IDs this ws is contributing so disconnect only
        // removes *their* awareness states, not every peer's.
        const before = new Set(doc.awareness.getStates().keys());
        awarenessProtocol.applyAwarenessUpdate(doc.awareness, payload, ws);
        const after = doc.awareness.getStates().keys();
        const ws_state = state(ws);
        for (const id of after) {
          if (!before.has(id)) ws_state.knownClientIds.add(id);
        }
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
