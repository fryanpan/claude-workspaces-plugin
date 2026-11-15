/**
 * A doc's history: every saved change, in order, with who made it and when.
 *
 * One append-only file per doc, `<dataDir>/_history/<docId>.yhist`, beside
 * the `.ydoc` and never instead of it. The `.ydoc` stays the doc's state and
 * the only thing the current code reads, so a server with history off, or a
 * board switched back off, reads every doc exactly as before. This file only
 * ever grows; nothing here rewrites or removes a record.
 *
 * A record is one Yjs update (V1), so the doc as it was after record N is the
 * last base at or before N with every update after it applied (`replay.ts`).
 * Three kinds:
 *
 *   - `base`: the doc's whole state, written when the log starts and whenever
 *     the doc changed with nothing recorded (a board switched off for a
 *     while, a board doc compacted at load). Reading starts again from it.
 *   - `update`: one change, as the doc emitted it.
 *   - `restore`: one change that put back an earlier version (`restoredTo`).
 *
 * On disk each record is a length-prefixed lib0 frame, so a record cut short
 * by a crash is found and cut off before the next append, and the records
 * before it still read. Authors are written once per file and referred to by
 * number, so a keystroke costs its update plus about four bytes.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  truncateSync,
} from 'node:fs';
import { join } from 'node:path';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';

/** Who made a change, as the server knew it. Never from a page's claim. */
export interface HistoryAuthor {
  /** `server` is the server's own housekeeping, and the author of a base. */
  kind: 'person' | 'agent' | 'server';
  /** The signed-in account or agent id. Absent when nobody was proved. */
  id?: string;
  /** The name that account or agent carries on this server. */
  name?: string;
  /** For `server`: the transaction origin it wrote under, when it had one. */
  via?: string;
}

export type HistoryKind = 'base' | 'update' | 'restore';

export interface HistoryRecord {
  /** 0-based position among this doc's records. */
  seq: number;
  /** Epoch ms when the server recorded it. */
  at: number;
  kind: HistoryKind;
  author: HistoryAuthor;
  /** A Yjs V1 update: the whole state for a base, one change otherwise. */
  update: Uint8Array;
  /** For a restore: the seq of the version it put back. */
  restoredTo?: number;
}

/** Where the history files are kept. Synchronous, like the doc state store. */
export interface HistoryStore {
  /** The doc's whole history file, or null when it has none. */
  read(docId: string): Uint8Array | null;
  append(docId: string, bytes: Uint8Array): void;
  /** Cut the file to `length` bytes: only ever a torn last record. */
  truncate(docId: string, length: number): void;
  /** Bytes stored for this doc, for the size report. */
  size(docId: string): number;
}

export function historyDir(dataDir: string): string {
  return join(dataDir, '_history');
}

export class DiskHistoryStore implements HistoryStore {
  private readonly dir: string;
  constructor(dataDir: string) {
    this.dir = historyDir(dataDir);
  }

  pathOf(docId: string): string {
    return join(this.dir, `${docId}.yhist`);
  }

  read(docId: string): Uint8Array | null {
    const path = this.pathOf(docId);
    return existsSync(path) ? new Uint8Array(readFileSync(path)) : null;
  }

  append(docId: string, bytes: Uint8Array): void {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    appendFileSync(this.pathOf(docId), bytes, { mode: 0o600 });
  }

  truncate(docId: string, length: number): void {
    truncateSync(this.pathOf(docId), length);
  }

  size(docId: string): number {
    const path = this.pathOf(docId);
    return existsSync(path) ? statSync(path).size : 0;
  }
}

/** History in a map: for tests. A restart is a new recorder handed the same instance. */
export class MemoryHistoryStore implements HistoryStore {
  private readonly files = new Map<string, Uint8Array>();

  read(docId: string): Uint8Array | null {
    const f = this.files.get(docId);
    return f ? f.slice() : null;
  }

  append(docId: string, bytes: Uint8Array): void {
    const prev = this.files.get(docId) ?? new Uint8Array(0);
    const next = new Uint8Array(prev.length + bytes.length);
    next.set(prev);
    next.set(bytes, prev.length);
    this.files.set(docId, next);
  }

  truncate(docId: string, length: number): void {
    const f = this.files.get(docId);
    if (f) this.files.set(docId, f.slice(0, length));
  }

  size(docId: string): number {
    return this.files.get(docId)?.length ?? 0;
  }
}

const TAG_AUTHOR = 0;
const TAG_OF: Record<HistoryKind, number> = { base: 1, update: 2, restore: 3 };
const KIND_OF: Record<number, HistoryKind> = { 1: 'base', 2: 'update', 3: 'restore' };

/** What a parse leaves behind for the next append. */
interface Tail {
  authors: Map<string, number>;
  lastAt: number;
  nextSeq: number;
}

export interface ParsedLog extends Tail {
  records: HistoryRecord[];
  /** Bytes up to the end of the last whole record. */
  goodLength: number;
}

/** Read a history file. A torn or garbled last frame ends the read there. */
export function parseLog(bytes: Uint8Array | null): ParsedLog {
  const out: ParsedLog = {
    records: [],
    authors: new Map(),
    lastAt: 0,
    nextSeq: 0,
    goodLength: 0,
  };
  if (!bytes) return out;
  const byIndex: HistoryAuthor[] = [];
  const dec = decoding.createDecoder(bytes);
  while (decoding.hasContent(dec)) {
    try {
      const frame = decoding.readVarUint8Array(dec);
      const f = decoding.createDecoder(frame);
      const tag = decoding.readVarUint(f);
      if (tag === TAG_AUTHOR) {
        const json = decoding.readVarString(f);
        out.authors.set(json, byIndex.length);
        byIndex.push(JSON.parse(json) as HistoryAuthor);
      } else {
        const kind = KIND_OF[tag];
        if (!kind) throw new Error(`unknown record tag ${tag}`);
        const at = out.lastAt + decoding.readVarUint(f);
        const author = byIndex[decoding.readVarUint(f)];
        if (!author) throw new Error('record names an author never written');
        const restoredTo = kind === 'restore' ? decoding.readVarUint(f) : undefined;
        const update = decoding.readVarUint8Array(f);
        out.records.push({
          seq: out.nextSeq++,
          at,
          kind,
          author,
          update,
          ...(restoredTo !== undefined ? { restoredTo } : {}),
        });
        out.lastAt = at;
      }
      out.goodLength = dec.pos;
    } catch {
      break;
    }
  }
  return out;
}

/** One doc's log, open for appending. */
export class HistoryLog {
  private constructor(
    private readonly store: HistoryStore,
    readonly docId: string,
    private readonly tail: Tail,
  ) {}

  /** Open a doc's log, cutting off a torn last record first. */
  static open(store: HistoryStore, docId: string): { log: HistoryLog; parsed: ParsedLog } {
    const bytes = store.read(docId);
    const parsed = parseLog(bytes);
    if (bytes && parsed.goodLength < bytes.length) {
      console.error(
        `[doc-history] ${docId}: cut a torn record (${bytes.length - parsed.goodLength} bytes)`,
      );
      store.truncate(docId, parsed.goodLength);
    }
    const tail: Tail = {
      authors: new Map(parsed.authors),
      lastAt: parsed.lastAt,
      nextSeq: parsed.nextSeq,
    };
    return { log: new HistoryLog(store, docId, tail), parsed };
  }

  /** How many records the log holds. */
  get length(): number {
    return this.tail.nextSeq;
  }

  /** Append one record in one write; returns its seq. */
  append(rec: Omit<HistoryRecord, 'seq'>): number {
    const enc = encoding.createEncoder();
    const json = JSON.stringify(rec.author);
    let index = this.tail.authors.get(json);
    const newAuthor = index === undefined;
    if (index === undefined) {
      index = this.tail.authors.size;
      const a = encoding.createEncoder();
      encoding.writeVarUint(a, TAG_AUTHOR);
      encoding.writeVarString(a, json);
      encoding.writeVarUint8Array(enc, encoding.toUint8Array(a));
    }
    // A clock that stepped back records no time passing, never a negative.
    const at = Math.max(rec.at, this.tail.lastAt);
    const r = encoding.createEncoder();
    encoding.writeVarUint(r, TAG_OF[rec.kind]);
    encoding.writeVarUint(r, at - this.tail.lastAt);
    encoding.writeVarUint(r, index);
    if (rec.kind === 'restore') encoding.writeVarUint(r, rec.restoredTo ?? 0);
    encoding.writeVarUint8Array(r, rec.update);
    encoding.writeVarUint8Array(enc, encoding.toUint8Array(r));
    this.store.append(this.docId, encoding.toUint8Array(enc));
    // Only after the write: a failed append leaves the tail as the file is.
    if (newAuthor) this.tail.authors.set(json, index);
    this.tail.lastAt = at;
    return this.tail.nextSeq++;
  }

  /** Every record, read fresh from the store. */
  records(): HistoryRecord[] {
    return parseLog(this.store.read(this.docId)).records;
  }
}
