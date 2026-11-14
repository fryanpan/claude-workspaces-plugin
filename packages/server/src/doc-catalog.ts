import { type DocMeta, listThreads } from '@claude-workspaces/core';
import {
  DOC_INDEX_VERSION,
  type DocIndexEntry,
  readAllDocIndexes,
  writeDocIndex,
} from './doc-index.ts';
import type { DocStateStore } from './doc-state/store.ts';
import type { LiveDoc } from './doc-store.ts';

/**
 * What the store can answer about a doc WITHOUT opening it: the listing rows,
 * the readable aliases that resolve to a doc id, and the `.ydoc` mtimes a
 * listing reports as activity. One map, one on-disk index and one name table,
 * so nothing here needs the live-doc lifecycle beyond the thunks below.
 *
 * Moved out of `doc-store.ts` whole; `DocStore` keeps its public listing verbs
 * as one-line forwarders so no caller has to learn where they went.
 */
export interface DocCatalogHost {
  dataDir(): string;
  /** Where each doc's Yjs state lives (`doc-state/store.ts`). */
  docState(): DocStateStore;
  residentDoc(docId: string): LiveDoc | undefined;
  residentDocs(): Iterable<LiveDoc>;
  /** A debounced `.ydoc` save is pending, so the row may be behind the doc. */
  hasPendingSave(docId: string): boolean;
  /** Whether the row being written must carry `pendingFileWrite`. */
  fileWriteOwed(doc: LiveDoc): boolean;
  /** Load a doc synchronously; the boot pass that writes missing rows. */
  hydrateBlocking(docId: string): void;
  evict(docId: string): void;
  /** A row was written, moved or dropped (`DocStore.onIndexChanged`). */
  indexChanged(
    docId: string,
    prev: DocIndexEntry | undefined,
    next: DocIndexEntry | undefined,
  ): void;
}

export class DocCatalog {
  /**
   * docId → its listing row, resident.
   *
   * The rows are what a board actually reads, and they are ~400 bytes each
   * against 62-125 KB for the CRDT they were being decoded out of. Held in
   * memory deliberately: `list()` is on the board's hot path and must not
   * become a directory walk, and the index is small enough that keeping all
   * of it costs less than keeping one percent of the documents.
   *
   * Maintained by the same write that persists the doc, and by every path
   * that stages, restores, purges or moves one — see `doc-index.ts`.
   */
  private docIndex = new Map<string, DocIndexEntry>();

  constructor(private readonly host: DocCatalogHost) {}

  /**
   * Readable alias → the doc id it was minted alongside.
   *
   * Rebuilt from `meta.alias` on every `getOrCreate`, so it comes back from
   * disk with the docs at boot and travels with a `.ydoc` through archive and
   * restore. There is deliberately no separate alias file to fall out of step
   * with the docs it describes.
   *
   * Write-once: `claimAlias` refuses a name already held. That is what makes
   * a captured URL a promise rather than a hint — a link that resolved
   * yesterday cannot be pointed at somebody else's document today.
   */
  private aliases = new Map<string, string>();

  /**
   * docId → `.ydoc` mtime (ms), the value `withActivity` reports.
   *
   * This file is written by exactly one process — us — so the cache is
   * authoritative between writes, and `persistDocNow` refreshes it. Before
   * this, every `list()` stat'd every doc: one docs listing alone was ~11k
   * syscalls per request against the measured corpus, and `list()` is called
   * two or three times over by the workspace-thread and grouped-diff views.
   * Deleting an entry is always safe — the next read re-stats.
   */
  private activityMtime = new Map<string, number>();

  /** Read every row off disk. The boot, before anything else asks. */
  load(): void {
    this.docIndex = readAllDocIndexes(this.host.dataDir());
  }

  entry(docId: string): DocIndexEntry | undefined {
    return this.docIndex.get(docId);
  }

  has(docId: string): boolean {
    return this.docIndex.has(docId);
  }

  entries(): IterableIterator<[string, DocIndexEntry]> {
    return this.docIndex.entries();
  }

  ids(): IterableIterator<string> {
    return this.docIndex.keys();
  }

  /** Replace a row without telling `indexChanged` — for the writes that
   *  clear a flag rather than change what a listing shows. */
  setQuietly(docId: string, entry: DocIndexEntry): void {
    this.docIndex.set(docId, entry);
  }

  /** The doc id a readable alias names, or undefined. */
  aliasTarget(name: string): string | undefined {
    return this.aliases.get(name);
  }

  noteActivityMtime(docId: string, mtimeMs: number): void {
    this.activityMtime.set(docId, mtimeMs);
  }

  forgetActivity(docId: string): void {
    this.activityMtime.delete(docId);
  }

  resetActivity(): void {
    this.activityMtime.clear();
  }

  setIndex(docId: string, entry: DocIndexEntry | undefined): void {
    const prev = this.docIndex.get(docId);
    if (entry) this.docIndex.set(docId, entry);
    else this.docIndex.delete(docId);
    this.host.indexChanged(docId, prev, entry);
  }

  /**
   * Put every alias in the index into the resolver table.
   *
   * Aliases used to be a side effect of hydration, so the table was complete
   * because everything was loaded. With lazy hydration nothing is loaded, and
   * a table built on demand would 404 the first request for a name — the one
   * failure a captured URL cannot survive.
   */
  seedAliasesFromIndex(): void {
    for (const [docId, entry] of this.docIndex) {
      const alias = entry.meta.alias;
      if (!alias) continue;
      // A doc whose PRIMARY id is this string beats an alias that spells it:
      // the primary is the older address and the one saved links use. Boot
      // used to settle this by loading every `.ydoc` first, so the primary
      // was already resident when the alias was claimed. Nothing is resident
      // now, so the file on disk is what has to be consulted — including the
      // pre-index `.ydoc`s this pass runs before.
      if (docId !== alias && this.host.docState().has(alias)) {
        console.warn(
          `[doc-store] alias "${alias}" is also a doc id on disk; leaving it to that doc (${docId} keeps its own id)`,
        );
        continue;
      }
      this.claimAlias(alias, docId);
    }
  }

  /**
   * Give a row to every `.ydoc` that has none, then let it go again.
   *
   * This is the whole migration for the docs written before the index
   * existed: hydrate once, write the row, evict. There is no separate
   * backfill script to remember to run, and no second code path that could
   * produce a different row than `persistDocNow` does — the row comes from
   * the same `indexEntryFor`.
   *
   * A doc that already has a row is never opened, which is the point: the
   * cost of this pass falls to zero the first time it runs.
   */
  indexUnindexedDocs(): void {
    let written = 0;
    let docIds: string[];
    try {
      docIds = this.host.docState().list();
    } catch (err) {
      console.error('[doc-store] could not list saved doc state:', err);
      return;
    }
    for (const docId of docIds) {
      if (!docId || this.docIndex.has(docId)) continue;
      try {
        // Boot, and the row is written from the doc in the same turn.
        this.host.hydrateBlocking(docId);
        const doc = this.host.residentDoc(docId);
        if (!doc) continue;
        const entry = this.indexEntryFor(doc);
        writeDocIndex(this.host.dataDir(), docId, entry);
        this.docIndex.set(docId, entry);
        written++;
      } catch (err) {
        // Loud: a doc with no row is invisible to every listing, so this is
        // not a cosmetic failure. It is also self-healing — the next write to
        // that doc writes its row — which is why it does not abort the boot.
        console.error(`[doc-store] failed to index ${docId}:`, err);
      } finally {
        // Straight back out. Writing a row is not somebody opening the doc,
        // and a migration that left 5,000 docs resident would be the very
        // boot this change exists to stop.
        this.host.evict(docId);
      }
    }
    if (written > 0) {
      console.error(`[doc-store] wrote ${written} missing doc index row(s) at startup`);
    }
  }

  /**
   * Every doc on this server, as listing rows.
   *
   * A resident doc is authoritative — it may hold changes the last write
   * has not carried into the index yet. A doc that is NOT resident is served
   * from its index row, which is the whole point: answering "what docs are
   * there" must not require decoding every CRDT that has ever been written.
   *
   * Today hydration still loads everything, so the second branch is only
   * reached for a doc whose `.ydoc` went missing while its row survived. It
   * is written now because the listing contract has to be settled BEFORE
   * anything stops being resident, not at the same time.
   */
  list(): DocMeta[] {
    const out: DocMeta[] = [];
    for (const doc of this.host.residentDocs()) out.push(this.withActivity(doc.meta));
    for (const [docId, entry] of this.docIndex) {
      if (this.host.residentDoc(docId) !== undefined) continue;
      out.push(this.withActivity(entry.meta));
    }
    return out;
  }

  /**
   * The same listing built ONLY from index rows, never from resident docs.
   *
   * Exists so the equality that everything else rests on can be asserted
   * directly: an index-backed listing must equal the hydrated one field for
   * field. Without a seam that refuses to consult the docs, a test of that
   * property would read the docs through `list()` and pass no matter what
   * the index said.
   */
  listFromIndex(): DocMeta[] {
    return [...this.docIndex.values()].map((e) => this.withActivity(e.meta));
  }

  /**
   * A doc's open and total thread counts from its index row, without loading
   * it. Null when there is no row — the caller reads the doc instead.
   */
  threadCountsFromIndex(docId: string): { open: number; total: number } | null {
    const entry = this.docIndex.get(docId);
    return entry ? { ...entry.threads } : null;
  }

  /** The most recent comment timestamp on a doc, from its index row. */
  lastThreadActivityFromIndex(docId: string): number | undefined {
    return this.docIndex.get(docId)?.lastThreadActivityAt;
  }

  /**
   * A doc's open and total thread counts, for the listings that render badges.
   *
   * Prefers the index row, which costs a map lookup, over decoding the doc's
   * thread map — which the diff tree and the landing page were doing once per
   * doc per render, twice per doc in the tree's case.
   *
   * The row is skipped only while `saveTimers` holds a pending write for that
   * doc, which is exactly the window in which the doc has changes the index
   * has not been given yet. Outside that window the two cannot differ,
   * because the same debounced write produces both. So this is not "close
   * enough for a badge": it is the same number, found more cheaply.
   */
  threadCounts(docId: string): { open: number; total: number } {
    if (!this.host.hasPendingSave(docId)) {
      const entry = this.docIndex.get(docId);
      if (entry) return { ...entry.threads };
    }
    const doc = this.host.residentDoc(docId);
    if (!doc) return { open: 0, total: 0 };
    const all = listThreads(doc.ydoc);
    return { open: all.filter((t) => t.status === 'open').length, total: all.length };
  }

  /**
   * The newest comment timestamp on a doc — what the landing page ranks by.
   * Same index-first rule as `threadCounts`; 0 when the doc has no comments.
   */
  lastThreadActivity(docId: string): number {
    if (!this.host.hasPendingSave(docId)) {
      const entry = this.docIndex.get(docId);
      if (entry) return entry.lastThreadActivityAt ?? 0;
    }
    const doc = this.host.residentDoc(docId);
    if (!doc) return 0;
    return listThreads(doc.ydoc).reduce((max, t) => Math.max(max, t.lastActivity), 0);
  }

  /**
   * Stamp a doc's meta with `lastActivityAt`, derived from the persisted
   * `.ydoc` mtime. saveToDisk rewrites that file on every prose/thread
   * change (200ms debounced), so its mtime tracks real activity without a
   * CRDT field that would churn the doc history on every keystroke. Falls
   * back to `createdAt` when the file isn't on disk yet.
   */
  withActivity(meta: DocMeta): DocMeta {
    return { ...meta, lastActivityAt: this.lastActivityFor(meta.docId, meta.createdAt) };
  }

  /**
   * When a doc last changed — the same `.ydoc` mtime `withActivity` reports —
   * or undefined for a doc this store does not know. Read by the scheduler
   * for an on-change rule (`task-scheduler-rows.ts`), so it never hydrates:
   * a rule watching a cold doc must not be what pulls it into memory every
   * thirty seconds.
   */
  activityAt(docId: string): number | undefined {
    const target = this.aliases.get(docId) ?? docId;
    const meta = this.host.residentDoc(target)?.meta ?? this.docIndex.get(target)?.meta;
    return meta === undefined ? undefined : this.lastActivityFor(target, meta.createdAt);
  }

  /**
   * The `.ydoc` mtime for a doc, stat'd at most once per write.
   *
   * Same number `withActivity` always reported — this only stops asking the
   * filesystem for it on every row of every list. `persistDocNow` refreshes
   * the entry (it is the only writer of that file), and every path that moves
   * or removes the file drops the entry so the next read re-stats.
   */
  private lastActivityFor(docId: string, createdAt: number): number {
    const cached = this.activityMtime.get(docId);
    if (cached !== undefined) return cached;
    let lastActivityAt = createdAt;
    try {
      const savedAt = this.host.docState().savedAt(docId);
      if (savedAt !== undefined) lastActivityAt = Math.round(savedAt);
    } catch {}
    this.activityMtime.set(docId, lastActivityAt);
    return lastActivityAt;
  }

  /**
   * Bind a readable name to a doc, ONCE.
   *
   * The refusal is the point. An alias that could be repointed would make
   * every captured review URL provisional: the link in yesterday's task
   * comment would still resolve, silently, to a document nobody meant to
   * send. So a name already held stays with its first doc, and the loser is
   * logged rather than swallowed — two docs claiming one name is a fact
   * somebody needs to see, not a race to win.
   *
   * There is no `repointAlias`, no `setAlias`, and no route that reaches
   * this. A doc that wants a different readable name gets an ADDITIONAL one;
   * the id it lives at does not move either way.
   */
  claimAlias(alias: string, docId: string): void {
    const held = this.aliases.get(alias);
    if (held !== undefined && held !== docId) {
      console.error(
        `[doc-store] alias "${alias}" already resolves to ${held}; leaving it there (${docId} keeps its own id)`,
      );
      return;
    }
    // A doc whose PRIMARY id is this string wins too — that is a
    // pre-migration doc, and its address is the one already written down in
    // links people saved.
    //
    // Belt, not braces: `get` tries the primary id first, so the primary
    // would win the lookup even with a stale entry in this map. Keeping the
    // map honest is still worth a line — a resolver whose table disagrees
    // with its own answers is how the next bug reads as impossible. Measured:
    // removing this line alone turns nothing red.
    if (this.host.residentDoc(alias) !== undefined && alias !== docId) return;
    this.aliases.set(alias, docId);
  }

  /** Forget a doc's alias when its doc goes away, so the name does not
   *  outlive the doc as a dangling resolution. */
  releaseAliases(docId: string): void {
    for (const [alias, target] of this.aliases) {
      if (target === docId) this.aliases.delete(alias);
    }
  }

  /** The doc's listing row, built from the live doc. */
  indexEntryFor(doc: LiveDoc): DocIndexEntry {
    const threads = listThreads(doc.ydoc);
    let lastThreadActivityAt: number | undefined;
    let open = 0;
    for (const t of threads) {
      if (t.status === 'open') open++;
      for (const c of t.comments) {
        if (lastThreadActivityAt === undefined || c.ts > lastThreadActivityAt) {
          lastThreadActivityAt = c.ts;
        }
      }
    }
    const pendingFileWrite = this.host.fileWriteOwed(doc);
    return {
      v: DOC_INDEX_VERSION,
      // A copy, not the live object: `doc.meta` keeps being mutated and the
      // entry must describe this write.
      meta: { ...doc.meta },
      threads: { open, total: threads.length },
      ...(lastThreadActivityAt !== undefined ? { lastThreadActivityAt } : {}),
      ...(pendingFileWrite ? { pendingFileWrite: true } : {}),
    };
  }
}
