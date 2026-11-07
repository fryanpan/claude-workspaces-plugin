/**
 * A whiteboard page's side of the doc socket, without a canvas: sync, its own
 * edits sent on, and the person it announces in presence, as the page does.
 */
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;

/** A page's side of the socket: sync, its own edits sent on, presence. */
export function connectWhiteboardPage(url: string, origin: string, name: string) {
  const ydoc = new Y.Doc();
  const awareness = new awarenessProtocol.Awareness(ydoc);
  const ws = new WebSocket(url, { headers: { origin } } as unknown as string[]);
  ws.binaryType = 'arraybuffer';
  let synced: () => void = () => {};
  const ready = new Promise<void>((r) => {
    synced = r;
  });
  const sendAwareness = () => {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_AWARENESS);
    encoding.writeVarUint8Array(
      enc,
      awarenessProtocol.encodeAwarenessUpdate(awareness, [ydoc.clientID]),
    );
    ws.send(encoding.toUint8Array(enc));
  };
  ws.addEventListener('open', () => {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.writeSyncStep1(enc, ydoc);
    ws.send(encoding.toUint8Array(enc));
    awareness.setLocalStateField('user', { name, color: '#c0392b' });
    sendAwareness();
  });
  ws.addEventListener('message', (ev) => {
    const dec = decoding.createDecoder(new Uint8Array(ev.data as ArrayBuffer));
    const kind = decoding.readVarUint(dec);
    if (kind === MSG_AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(awareness, decoding.readVarUint8Array(dec), ws);
      return;
    }
    if (kind !== MSG_SYNC) return;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    const type = syncProtocol.readSyncMessage(dec, enc, ydoc, ws);
    if (encoding.length(enc) > 1) ws.send(encoding.toUint8Array(enc));
    if (type === syncProtocol.messageYjsSyncStep2) synced();
  });
  ydoc.on('update', (update: Uint8Array, from: unknown) => {
    if (from === ws || ws.readyState !== WebSocket.OPEN) return;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.writeUpdate(enc, update);
    ws.send(encoding.toUint8Array(enc));
  });
  return { ydoc, awareness, ready, close: () => ws.close() };
}
