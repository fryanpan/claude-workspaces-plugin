/**
 * A page holding a doc open over the real doc socket
 * (`/workspaces/<ws>/docs/<id>/y`): a raw Yjs client that syncs and sends
 * what it writes. `synced()` resolves once the server has answered a sync
 * step 1 sent after everything this page wrote so far; the socket is handled
 * in order, so by then the server has applied those writes. Call it before
 * reading: the page asks for the doc only then, and the server sends a
 * socket nothing it has not asked for.
 */
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';

const MSG_SYNC = 0;

export interface YPage {
  ydoc: Y.Doc;
  synced: () => Promise<void>;
  close: () => void;
}

export function openYPage(url: string, headers?: Record<string, string>): YPage {
  const ydoc = new Y.Doc();
  const ws = new WebSocket(url, (headers ? { headers } : {}) as unknown as string[]);
  ws.binaryType = 'arraybuffer';
  let waiting: Array<() => void> = [];
  const step1 = () => {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.writeSyncStep1(enc, ydoc);
    ws.send(encoding.toUint8Array(enc));
  };
  const opened = new Promise<void>((r) => ws.addEventListener('open', () => r()));
  ws.addEventListener('message', (ev) => {
    const dec = decoding.createDecoder(new Uint8Array(ev.data as ArrayBuffer));
    if (decoding.readVarUint(dec) !== MSG_SYNC) return;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    const kind = syncProtocol.readSyncMessage(dec, enc, ydoc, ws);
    if (encoding.length(enc) > 1) ws.send(encoding.toUint8Array(enc));
    if (kind === syncProtocol.messageYjsSyncStep2) {
      for (const r of waiting.splice(0)) r();
    }
  });
  ydoc.on('update', (update: Uint8Array, from: unknown) => {
    if (from === ws || ws.readyState !== WebSocket.OPEN) return;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.writeUpdate(enc, update);
    ws.send(encoding.toUint8Array(enc));
  });
  const synced = async () => {
    await opened;
    const done = new Promise<void>((r) => waiting.push(r));
    step1();
    await done;
  };
  return {
    ydoc,
    synced,
    close: () => {
      waiting = [];
      ws.close();
    },
  };
}
