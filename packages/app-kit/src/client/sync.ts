/**
 * A page's half of a doc socket: keeps one Y.Doc in sync with the server's
 * copy over `/docs/<id>/ws`, and reconnects when the socket drops.
 *
 * It speaks the collab core's frames, `[0, syncMessage]`. On every open it
 * sends a sync step 1 (asking for what it lacks), and the server's own step 1
 * asks for what the page wrote while it was away. No DOM: tests run it in Bun
 * and in Node.
 *
 * A browser cannot put headers on a socket. A page that signs in with a
 * token rather than a cookie passes `url` as a function, so each reconnect
 * reads the current token, or sends it as a `protocols` entry.
 */
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';

const MSG_SYNC = 0;

export type SyncStatus = 'connecting' | 'synced' | 'offline';

export interface DocSync {
  doc: Y.Doc;
  /** Resolves the first time the server's copy has been applied. */
  synced: Promise<void>;
  status(): SyncStatus;
  onStatus(fn: (s: SyncStatus) => void): void;
  close(): void;
}

export interface DocSyncOptions {
  doc?: Y.Doc;
  /** Extra handshake headers. Bun honours them; a browser sends its cookies. */
  headers?: Record<string, string>;
  /** WebSocket subprotocols, for a token a browser cannot send as a header. */
  protocols?: string[];
  /** First retry delay; doubles to `maxRetryMs`. */
  retryMs?: number;
  maxRetryMs?: number;
}

const frame = (write: (enc: encoding.Encoder) => void): Uint8Array => {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MSG_SYNC);
  write(enc);
  return encoding.toUint8Array(enc);
};

/** The socket's address, or a function asked again on every reconnect. */
export type DocUrl = string | (() => string);

export function connectDoc(url: DocUrl, opts: DocSyncOptions = {}): DocSync {
  const doc = opts.doc ?? new Y.Doc();
  const listeners: Array<(s: SyncStatus) => void> = [];
  let status: SyncStatus = 'connecting';
  let ws: WebSocket | null = null;
  let closed = false;
  let retry = opts.retryMs ?? 500;
  let markSynced: () => void = () => {};
  const synced = new Promise<void>((r) => {
    markSynced = r;
  });

  const setStatus = (s: SyncStatus): void => {
    if (s === status) return;
    status = s;
    for (const fn of listeners) fn(s);
  };

  const onUpdate = (update: Uint8Array, origin: unknown): void => {
    if (origin === ws || ws?.readyState !== WebSocket.OPEN) return;
    ws.send(frame((enc) => syncProtocol.writeUpdate(enc, update)));
  };
  doc.on('update', onUpdate);

  const open = (): void => {
    const address = typeof url === 'function' ? url() : url;
    const socket = opts.headers
      ? new WebSocket(address, { headers: opts.headers } as unknown as string[])
      : new WebSocket(address, opts.protocols);
    socket.binaryType = 'arraybuffer';
    ws = socket;
    socket.addEventListener('open', () => {
      retry = opts.retryMs ?? 500;
      socket.send(frame((enc) => syncProtocol.writeSyncStep1(enc, doc)));
    });
    socket.addEventListener('message', (ev) => {
      const dec = decoding.createDecoder(new Uint8Array(ev.data as ArrayBuffer));
      if (decoding.readVarUint(dec) !== MSG_SYNC) return;
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_SYNC);
      const kind = syncProtocol.readSyncMessage(dec, enc, doc, socket);
      if (encoding.length(enc) > 1) socket.send(encoding.toUint8Array(enc));
      if (kind === syncProtocol.messageYjsSyncStep2) {
        setStatus('synced');
        markSynced();
      }
    });
    socket.addEventListener('close', () => {
      if (ws === socket) ws = null;
      if (closed) return;
      setStatus('offline');
      setTimeout(open, retry);
      retry = Math.min(retry * 2, opts.maxRetryMs ?? 10_000);
    });
  };
  open();

  return {
    doc,
    synced,
    status: () => status,
    onStatus: (fn) => {
      listeners.push(fn);
    },
    close: () => {
      closed = true;
      doc.off('update', onUpdate);
      ws?.close();
    },
  };
}
