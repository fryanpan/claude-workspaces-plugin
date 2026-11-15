/**
 * History for the docs of boards on the collab core (D1 step 12): every saved
 * change recorded with who made it, a doc readable as it was after any
 * record, and a past version restorable as a change of its own.
 *
 * Attached to every live doc the store wires (`DocStore`'s `onDocWired`), and
 * silent for a doc outside `inScope`, so a board on the current code records
 * nothing and pays one function call per transaction.
 *
 * The author comes from the server, never from the page:
 *
 *   - an edit from one of the doc's sockets is the identity that socket's
 *     upgrade proved (`ws.data.editor.user`). A socket that proved nobody is
 *     an unnamed person: the name its presence announces is the page's claim
 *     and is not written down.
 *   - any other edit made while a request is being answered is whoever that
 *     request proved (`currentRequestAuthor`): an agent's MCP edit, a task
 *     filed through REST and projected onto the board doc.
 *   - the rest is the server's own (`kind: 'server'`, with the origin).
 *
 * Nothing recorded is ever rewritten. Before the first change it records for
 * a doc instance, the recorder checks the log ends where the doc is now; when
 * it does not (no log yet, a period switched off, a compaction at load) it
 * writes a base of the doc's state first, so every later record replays onto
 * the state it was made on.
 */
import type * as Y from 'yjs';
import * as YJS from 'yjs';
import { classifyActor } from '../actor-identity.ts';
import type { FeedbackWs, LiveDoc } from '../doc-store.ts';
import { currentRequestAuthor, inOpenRequest } from '../event-origin.ts';
import { type HistoryAuthor, HistoryLog, type HistoryRecord, type HistoryStore } from './log.ts';
import { type ChangedPart, changesSince, seqAtTime, versionAt } from './replay.ts';
import { applyVersion } from './restore.ts';

/** Roots a restore leaves alone in every doc; see `restore.ts`. */
const RESTORE_SKIPS: readonly string[] = ['meta', 'threads'];

/** The transaction origin a restore writes under: agent-shaped, so the store
 *  treats it as authoring (revision bump, write-back) like an agent's edit. */
export const RESTORE_ORIGIN = 'agent-history-restore';

export interface DocHistoryOptions {
  store: HistoryStore;
  /** Whether this doc's changes are recorded now: its board is on the core. */
  inScope: (doc: LiveDoc) => boolean;
  now?: () => number;
  /** How long one doc's `inScope` answer is reused, in ms. Asking costs a
   *  walk of the board membership, and the answer is asked on every change.
   *  Default 1000; a switch flip reaches a doc within it. */
  scopeTtlMs?: number;
  /** More roots a restore leaves alone in this doc: the ones another store
   *  owns and reasserts, such as a board doc's projected tasks. */
  ownedElsewhere?: (doc: LiveDoc) => readonly string[];
}

/** One record, without its bytes. */
export interface VersionInfo {
  seq: number;
  at: number;
  kind: HistoryRecord['kind'];
  author: HistoryAuthor;
  restoredTo?: number;
}

export interface VersionRead {
  /** The record the version is after; -1 for before the first. */
  seq: number;
  /** The doc as it was. The caller destroys it. */
  doc: Y.Doc;
  /** Every part changed since, and who changed it. */
  changes: ChangedPart[];
}

export class DocHistory {
  private readonly store: HistoryStore;
  private readonly now: () => number;
  private readonly logs = new Map<string, HistoryLog>();
  /** Doc instances whose log is known to end at the doc's state. */
  private readonly inStep = new WeakSet<LiveDoc>();
  private readonly attached = new WeakSet<LiveDoc>();
  private scopes = new WeakMap<LiveDoc, { until: number; on: boolean }>();
  /** Set for the length of a restore's transaction. */
  private restoring: { author: HistoryAuthor; restoredTo: number } | null = null;

  constructor(private readonly opts: DocHistoryOptions) {
    this.store = opts.store;
    this.now = opts.now ?? Date.now;
  }

  /** Start recording a live doc whenever it is in scope. Once per instance. */
  attach(doc: LiveDoc): void {
    if (this.attached.has(doc)) return;
    this.attached.add(doc);
    doc.ydoc.on('beforeTransaction', () => {
      if (this.inStep.has(doc)) return;
      this.guard(doc, () => {
        if (this.inScope(doc)) this.catchUp(doc);
      });
    });
    doc.ydoc.on('update', (update: Uint8Array, origin: unknown) => {
      this.guard(doc, () => this.record(doc, update, origin));
    });
  }

  /** Every record of a doc, oldest first, without the bytes. */
  versions(docId: string): VersionInfo[] {
    return this.records(docId).map(({ update: _u, ...info }) => info);
  }

  /** The doc as it was after record `seq`, or at time `at`, with who changed
   *  each part since. */
  read(docId: string, when: { seq: number } | { at: number }): VersionRead {
    const records = this.records(docId);
    const seq = 'seq' in when ? when.seq : seqAtTime(records, when.at);
    return { seq, doc: versionAt(records, seq), changes: changesSince(records, seq) };
  }

  /**
   * Put the version after record `seq` back into `doc`, as one change
   * recorded under `author`. Returns the restore's own seq. Throws when the
   * doc is not recorded now, since the restore would then be unrecorded.
   */
  restore(
    doc: LiveDoc,
    seq: number,
    author: HistoryAuthor,
  ): { seq: number | null; changed: string[]; refused: string[]; skipped: string[] } {
    if (!this.inScope(doc, true)) throw new Error(`${doc.docId} keeps no history`);
    const records = this.records(doc.docId);
    if (!Number.isInteger(seq) || seq < 0 || seq >= records.length) {
      throw new Error(`${doc.docId} has no version ${seq}`);
    }
    const past = versionAt(records, seq);
    const before = this.logFor(doc.docId).length;
    const skipped = [...RESTORE_SKIPS, ...(this.opts.ownedElsewhere?.(doc) ?? [])];
    let result = { changed: [] as string[], refused: [] as string[] };
    this.restoring = { author, restoredTo: seq };
    try {
      doc.ydoc.transact(() => {
        result = applyVersion(doc.ydoc, past, new Set(skipped));
      }, RESTORE_ORIGIN);
    } finally {
      this.restoring = null;
      past.destroy();
    }
    const log = this.logFor(doc.docId);
    return { seq: log.length > before ? log.length - 1 : null, ...result, skipped };
  }

  /** Forget every cached scope answer: a board's switch just changed. */
  scopeChanged(): void {
    this.scopes = new WeakMap();
  }

  /** Bytes of history stored for a doc. */
  sizeOf(docId: string): number {
    return this.store.size(docId);
  }

  private records(docId: string): HistoryRecord[] {
    return this.logFor(docId).records();
  }

  private logFor(docId: string): HistoryLog {
    let log = this.logs.get(docId);
    if (!log) {
      log = HistoryLog.open(this.store, docId).log;
      this.logs.set(docId, log);
    }
    return log;
  }

  /** Never let history break an edit: a failure is logged, and the next
   *  transaction checks the log again and writes a base if it fell behind. */
  private guard(doc: LiveDoc, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.inStep.delete(doc);
      console.error(`[doc-history] ${doc.docId}:`, err);
    }
  }

  /** Write a base when the log does not end where the doc is now. */
  private catchUp(doc: LiveDoc): void {
    const records = this.records(doc.docId);
    let current = records.length > 0;
    if (current) {
      const replayed = versionAt(records, records.length - 1);
      current = YJS.equalSnapshots(YJS.snapshot(replayed), YJS.snapshot(doc.ydoc));
      replayed.destroy();
    }
    if (!current) {
      this.logFor(doc.docId).append({
        at: this.now(),
        kind: 'base',
        author: { kind: 'server', via: 'base' },
        update: YJS.encodeStateAsUpdate(doc.ydoc),
      });
    }
    this.inStep.add(doc);
  }

  /** `opts.inScope`, reused for `scopeTtlMs` unless `fresh`. */
  private inScope(doc: LiveDoc, fresh = false): boolean {
    const at = performance.now();
    const cached = this.scopes.get(doc);
    if (!fresh && cached && at < cached.until) return cached.on;
    const on = this.opts.inScope(doc);
    this.scopes.set(doc, { until: at + (this.opts.scopeTtlMs ?? 1000), on });
    return on;
  }

  private record(doc: LiveDoc, update: Uint8Array, origin: unknown): void {
    if (!this.inScope(doc)) {
      // A change nobody recorded: the log no longer ends at this doc.
      this.inStep.delete(doc);
      return;
    }
    if (!this.inStep.has(doc)) {
      // In scope only since this transaction began: its state is the base.
      this.catchUp(doc);
      return;
    }
    const restoring = this.restoring;
    this.logFor(doc.docId).append({
      at: this.now(),
      kind: restoring ? 'restore' : 'update',
      author: restoring?.author ?? authorOf(doc, origin),
      update,
      ...(restoring ? { restoredTo: restoring.restoredTo } : {}),
    });
  }
}

/** Who made a change, from what the server proved. See the file comment. */
export function authorOf(doc: LiveDoc, origin: unknown): HistoryAuthor {
  if (typeof origin === 'object' && origin !== null && doc.conns.has(origin as FeedbackWs)) {
    const user = (origin as FeedbackWs).data.editor?.user;
    if (!user) return { kind: 'person' };
    return { kind: classifyActor(user), id: user.id, name: user.name };
  }
  const via = typeof origin === 'string' ? origin : undefined;
  if (inOpenRequest()) {
    const user = currentRequestAuthor();
    if (user) {
      return { kind: classifyActor(user), id: user.id, name: user.name, ...(via ? { via } : {}) };
    }
    // An agent's edit tool on a request that proved nobody: a local agent.
    if (via?.startsWith('agent')) return { kind: 'agent', via };
  }
  return { kind: 'server', ...(via ? { via } : {}) };
}
