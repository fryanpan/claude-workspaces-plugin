/**
 * One doc on another server, kept in step with one `.md` on this machine.
 *
 * A board that moved to a project machine (`machine:move-board`) took its
 * docs with it, and that server cannot reach the files they were bound to in
 * the repo on the Mac. This holds the binding from the Mac's side instead:
 * it joins the doc's editing socket as any co-editor does, writes the file
 * when the doc changes, and applies the file to the doc when the file
 * changes. Both directions use the server's own serializer and block diff
 * (`@claude-workspaces/core` prose), so threads on untouched blocks keep
 * their anchors.
 *
 * The delay, each way: a remote edit reaches the file `writeDelayMs` (800ms,
 * the server's own write-back debounce) after it arrives; a file edit is seen
 * by the next stat, at most `pollMs` (1s) later, and reaches the server on
 * the same socket. With the network, about two seconds.
 *
 * At start the two sides are compared with what this mirror last wrote
 * (`MirrorMark`, kept by the caller). When only the file moved, the file
 * wins. Otherwise the doc wins, because it is the record the board's threads
 * hang on; a file the doc overwrites is copied to `backupDir` first.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { prose } from '@claude-workspaces/core';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import { statStampSync } from '../file-stamp.ts';

const MSG_SYNC = 0;

/** What the mirror wrote last, kept between runs so a restart knows which side moved. */
export interface MirrorMark {
  /** sha256 of the file's bytes as last written or read. */
  disk: string;
  /** sha256 of the doc's markdown at that moment. */
  md: string;
}

export interface MirrorSocket {
  binaryType: string;
  readyState: number;
  send(data: Uint8Array): void;
  close(): void;
  addEventListener(type: string, fn: (ev: { data?: unknown }) => void): void;
}

export interface DocMirrorOptions {
  docId: string;
  path: string;
  /** Opens the doc's editing socket. */
  connect: () => MirrorSocket;
  mark?: MirrorMark;
  onMark: (mark: MirrorMark) => void;
  backupDir: string;
  log: (line: string) => void;
  writeDelayMs?: number;
  pollMs?: number;
  /** Wait before reconnecting, doubling to 30s. */
  reconnectMs?: number;
}

const OPEN = 1;
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

/** The file's stamp as the server's own poll reads one (`file-stamp.ts`), or null. */
function stampOf(path: string): string | null {
  try {
    const st = statStampSync(path);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return null;
  }
}

function readFile(path: string): { text: string; stamp: string } | null {
  const stamp = stampOf(path);
  if (stamp === null) return null;
  try {
    return { text: readFileSync(path, 'utf8'), stamp };
  } catch {
    return null;
  }
}

export function createDocMirror(opts: DocMirrorOptions) {
  const writeDelayMs = opts.writeDelayMs ?? 800;
  const pollMs = opts.pollMs ?? 1000;
  const ydoc = new Y.Doc();
  const fragment = prose.getProseFragment(ydoc);
  let ws: MirrorSocket | null = null;
  let synced = false;
  let stopped = false;
  let backoff = opts.reconnectMs ?? 1000;
  /** The file's bytes, and its stat, as this mirror last wrote or read them. */
  let lastDisk: string | null = null;
  let lastStamp: string | null = null;
  let lastMd: string | null = null;
  let writeTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  const poll = setInterval(() => pollFile(), pollMs);

  const md = (): string => prose.serializeFragmentToMarkdown(fragment);
  const mark = () => {
    if (lastDisk !== null && lastMd !== null) opts.onMark({ disk: sha(lastDisk), md: sha(lastMd) });
  };

  function backup(text: string): void {
    mkdirSync(opts.backupDir, { recursive: true, mode: 0o700 });
    const to = join(
      opts.backupDir,
      `${opts.docId.replace(/[^A-Za-z0-9._-]/g, '_')}.${new Date().toISOString().replace(/[:.]/g, '-')}.${basename(opts.path)}`,
    );
    writeFileSync(to, text, { mode: 0o600 });
    opts.log(`${opts.docId}: the doc wins; the file it replaced is kept at ${to}`);
  }

  function writeFile(): void {
    writeTimer = null;
    if (!synced || stopped) return;
    const now = md();
    if (now === lastMd) return;
    // A file edit nobody has read yet goes to the doc first; the poll does that.
    if (stampOf(opts.path) !== lastStamp) {
      schedule();
      return;
    }
    const bytes = prose.serializeKeepingSource(fragment, lastDisk ?? undefined);
    try {
      writeFileSync(opts.path, bytes);
    } catch (err) {
      opts.log(`${opts.docId}: could not write ${opts.path}: ${(err as Error).message}`);
      return;
    }
    lastDisk = bytes;
    lastStamp = stampOf(opts.path);
    lastMd = now;
    mark();
  }

  function schedule(): void {
    if (writeTimer) clearTimeout(writeTimer);
    writeTimer = setTimeout(writeFile, writeDelayMs);
  }

  function applyFile(text: string, stamp: string): void {
    ydoc.transact(() => prose.applyMarkdownToFragment(fragment, text), 'file');
    lastDisk = text;
    lastStamp = stamp;
    lastMd = md();
    mark();
  }

  function pollFile(): void {
    if (!synced || stopped) return;
    const stamp = stampOf(opts.path);
    if (stamp === null || stamp === lastStamp) return;
    const f = readFile(opts.path);
    if (!f) return;
    if (f.text === lastDisk) {
      lastStamp = f.stamp;
      return;
    }
    applyFile(f.text, f.stamp);
    opts.log(`${opts.docId}: file edit sent to the doc`);
  }

  /** The first full sync: decide which side moved while nobody was watching. */
  function reconcile(): void {
    const f = readFile(opts.path);
    const live = md();
    if (f !== null && opts.mark && lastDisk === null) {
      const fileMoved = sha(f.text) !== opts.mark.disk;
      const docMoved = sha(live) !== opts.mark.md;
      if (fileMoved && !docMoved) {
        applyFile(f.text, f.stamp);
        opts.log(`${opts.docId}: the file changed while the sync was off; sent to the doc`);
        return;
      }
    }
    if (f !== null && lastDisk === null) {
      lastDisk = f.text;
      lastStamp = f.stamp;
      // Same words in the file's own layout: nothing to write.
      if (prose.serializeKeepingSource(fragment, f.text) === f.text) {
        lastMd = live;
        mark();
        return;
      }
      // A file that holds only what this mirror last wrote needs no copy.
      if (opts.mark?.disk !== sha(f.text)) backup(f.text);
    }
    if (f === null && !existsSync(opts.path)) lastStamp = null;
    lastMd = null;
    writeFile();
  }

  ydoc.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin === ws) {
      if (synced) schedule();
      return;
    }
    if (!ws || ws.readyState !== OPEN) return;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.writeUpdate(enc, update);
    ws.send(encoding.toUint8Array(enc));
  });

  function open(): void {
    if (stopped) return;
    const sock = opts.connect();
    ws = sock;
    sock.binaryType = 'arraybuffer';
    sock.addEventListener('open', () => {
      backoff = opts.reconnectMs ?? 1000;
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_SYNC);
      syncProtocol.writeSyncStep1(enc, ydoc);
      sock.send(encoding.toUint8Array(enc));
    });
    sock.addEventListener('message', (ev) => {
      const dec = decoding.createDecoder(new Uint8Array(ev.data as ArrayBuffer));
      if (decoding.readVarUint(dec) !== MSG_SYNC) return;
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_SYNC);
      const kind = syncProtocol.readSyncMessage(dec, enc, ydoc, sock);
      if (encoding.length(enc) > 1) sock.send(encoding.toUint8Array(enc));
      if (kind === syncProtocol.messageYjsSyncStep2 && !synced) {
        synced = true;
        opts.log(`${opts.docId}: synced with ${opts.path}`);
        reconcile();
      }
    });
    sock.addEventListener('close', () => {
      if (ws === sock) ws = null;
      if (stopped) return;
      opts.log(`${opts.docId}: socket closed; reconnecting in ${backoff}ms`);
      reconnectTimer = setTimeout(open, backoff);
      backoff = Math.min(backoff * 2, 30_000);
    });
  }

  return {
    start: open,
    /** Whether the first sync has happened. */
    synced: () => synced,
    stop(): void {
      stopped = true;
      clearInterval(poll);
      if (writeTimer) clearTimeout(writeTimer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ws?.close();
      ydoc.destroy();
    },
  };
}
