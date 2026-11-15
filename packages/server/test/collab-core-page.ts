/**
 * A page on a board or doc socket, for the collab core switch tests: it syncs,
 * applies what the server sends, sends on its own edits, and keeps the kind
 * of every frame it was sent so two paths' wire traffic can be compared.
 */
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';

const MSG_SYNC = 0;

export interface Page {
  ydoc: Y.Doc;
  /** Resolves once the server's first sync step 2 has arrived. */
  ready: Promise<void>;
  /** `sync:<step>` for a sync frame, else the frame's kind, in arrival order. */
  kinds: string[];
  /** Send one raw frame, as recorded traffic is replayed. */
  sendRaw: (frame: Uint8Array) => void;
  close: () => void;
}

export function openPage(url: string, origin: string, opts: { quiet?: boolean } = {}): Page {
  const ydoc = new Y.Doc();
  const kinds: string[] = [];
  const ws = new WebSocket(url, { headers: { origin } } as unknown as string[]);
  ws.binaryType = 'arraybuffer';
  let synced: () => void = () => {};
  const ready = new Promise<void>((r) => {
    synced = r;
  });
  ws.addEventListener('open', () => {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.writeSyncStep1(enc, ydoc);
    ws.send(encoding.toUint8Array(enc));
  });
  ws.addEventListener('message', (ev) => {
    const bytes = new Uint8Array(ev.data as ArrayBuffer);
    const dec = decoding.createDecoder(bytes);
    const kind = decoding.readVarUint(dec);
    if (kind !== MSG_SYNC) {
      kinds.push(String(kind));
      return;
    }
    const step = decoding.peekVarUint(dec);
    kinds.push(`sync:${step}`);
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    const type = syncProtocol.readSyncMessage(dec, enc, ydoc, ws);
    if (encoding.length(enc) > 1) ws.send(encoding.toUint8Array(enc));
    if (type === syncProtocol.messageYjsSyncStep2) synced();
  });
  if (!opts.quiet) {
    ydoc.on('update', (update: Uint8Array, from: unknown) => {
      if (from === ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(syncFrame((enc) => syncProtocol.writeUpdate(enc, update)));
    });
  }
  return { ydoc, ready, kinds, sendRaw: (f) => ws.send(f), close: () => ws.close() };
}

export function syncFrame(write: (enc: encoding.Encoder) => void): Uint8Array {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MSG_SYNC);
  write(enc);
  return encoding.toUint8Array(enc);
}

/** The prose a doc page shows, as plain text. */
export function proseText(ydoc: Y.Doc): string {
  return ydoc.getXmlFragment('prose').toString();
}

/** Append one paragraph to a doc page's prose. */
export function appendParagraph(ydoc: Y.Doc, words: string): void {
  ydoc.transact(() => {
    const p = new Y.XmlElement('paragraph');
    const t = new Y.XmlText();
    p.insert(0, [t]);
    t.insert(0, words);
    ydoc.getXmlFragment('prose').push([p]);
  });
}

/**
 * Two pages' traffic, recorded: each update frame the pages sent, in the
 * order they sent them, with fixed client ids so a replay is comparable.
 * Page B edits concurrently with A, then builds on A's text, then A deletes,
 * so the replay exercises a merge and a delete as well as inserts.
 */
export interface RecordedFrame {
  from: 'a' | 'b';
  /** The update the frame carries. */
  update: Uint8Array;
  /** The frame as the page sent it. */
  frame: Uint8Array;
}

export function recordTwoPages(): RecordedFrame[] {
  const a = new Y.Doc();
  a.clientID = 101;
  const b = new Y.Doc();
  b.clientID = 202;
  const out: RecordedFrame[] = [];
  const record = (from: 'a' | 'b', doc: Y.Doc, edit: () => void): Uint8Array => {
    let captured: Uint8Array | null = null;
    const on = (u: Uint8Array) => {
      captured = u;
    };
    doc.on('update', on);
    doc.transact(edit);
    doc.off('update', on);
    const update = captured as Uint8Array | null;
    if (!update) throw new Error('edit made no update');
    out.push({ from, update, frame: syncFrame((enc) => syncProtocol.writeUpdate(enc, update)) });
    return update;
  };
  const ua1 = record('a', a, () => a.getText('replay').insert(0, 'Harborlight tide tables'));
  const ub1 = record('b', b, () => b.getMap('replay-meta').set('author', 'Bob'));
  Y.applyUpdate(b, ua1);
  Y.applyUpdate(a, ub1);
  const ub2 = record('b', b, () => b.getText('replay').insert(11, ' and Riverbend'));
  Y.applyUpdate(a, ub2);
  record('a', a, () => a.getText('replay').delete(0, 12));
  return out;
}
