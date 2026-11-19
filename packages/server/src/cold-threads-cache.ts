/**
 * The threads of cold docs, kept between walks so an unchanged `.ydoc` is
 * decoded once rather than on every read.
 *
 * Home's review queue and the stall pass each read the threads of every live
 * row on every board through `DocStore.peekThreads`, which decodes a cold
 * doc's whole `.ydoc` — content and edit history — to read a few comments,
 * and then throws the copy away. On a synthetic 60-board, 2,400-doc corpus
 * that decode was ~90% of the time `/` spent on the server, every load, and
 * it grows with every doc's history. Nothing about those docs had changed
 * between loads.
 *
 * What is kept is the decoded `Thread[]` and nothing else: no `Y.Doc`, no
 * text, no entry in the resident-doc map, so it does not bring back the
 * whole-corpus residency PRs 1723/1725 removed. It is bounded twice, by doc
 * count and by an estimate of the comment text it holds, and the least
 * recently read doc goes first.
 *
 * It is exact because the server is the only writer of a doc's state, and
 * every write goes through the `DocStateStore` the store holds:
 * `forgettingWrites` wraps that store so a write, move, staged delete or
 * removal forgets the doc's entry in the same call. A resident doc never
 * answers from here (`peekThreads` asks memory first), and its edits reach
 * the state through that same write before it can go cold again.
 *
 * It also outlives the process. The boot warm filled it 15s after a start,
 * and every Home before that read and decoded each threaded doc: on a
 * 40-board, 3,680-threaded-doc corpus the first `/` after a boot spent ~1s
 * there, ~65% of it opening the files. Shutdown and the boot warm now write
 * the cache to one file (`save`), and the next start reads it back (`load`).
 * A restored entry is trusted only while its doc's state still carries the
 * save time it was decoded at — one `stat`, where a miss is a read and a
 * decode — so an entry for a doc written since is dropped, never served.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Thread } from '@claude-workspaces/core';
import type { DocStateArea, DocStateStore } from './doc-state/store.ts';

/** Default bounds: enough for every live row on a large install, small next
 *  to a single resident doc set. */
export const COLD_THREADS_MAX_DOCS = 20_000;
export const COLD_THREADS_MAX_CHARS = 16_000_000;

/** A rough char cost per thread and per comment beyond its text: ids,
 *  authors, anchors, timestamps. Only the bound reads it. */
const THREAD_OVERHEAD = 200;
const COMMENT_OVERHEAD = 150;

function weigh(threads: readonly Thread[]): number {
  let chars = 0;
  for (const t of threads) {
    chars += THREAD_OVERHEAD;
    for (const c of t.comments) chars += COMMENT_OVERHEAD + (c.text?.length ?? 0);
  }
  return chars;
}

/** Enough of a `Thread[]` for every reader to walk it: a damaged file must
 *  load nothing rather than hand a caller a thread with no comment list. */
function isThreadList(v: unknown): boolean {
  return (
    Array.isArray(v) &&
    v.every(
      (t) =>
        typeof t === 'object' &&
        t !== null &&
        typeof (t as Thread).id === 'string' &&
        Array.isArray((t as Thread).comments),
    )
  );
}

export interface ColdThreadsStats {
  docs: number;
  chars: number;
  hits: number;
  misses: number;
}

/** Where a data dir's cold threads are kept between processes. */
export function coldThreadsPath(dataDir: string): string {
  return join(dataDir, 'cold-threads.json');
}

/** The file `save` writes: entries in recency order, oldest first. */
interface SavedCache {
  v: 1;
  entries: Array<[docId: string, stamp: number, threads: Thread[]]>;
}

interface Entry {
  threads: Thread[];
  chars: number;
  /** The doc state's save time when it was decoded; undefined when unknown,
   *  and then the entry is never written out. */
  stamp: number | undefined;
  /** Read back from a previous process: answers only once `stamp` matches. */
  restored: boolean;
}

export class ColdThreadsCache {
  /** Insertion order is recency: a read moves its entry to the end. */
  private readonly entries = new Map<string, Entry>();
  private chars = 0;
  private hits = 0;
  private misses = 0;

  constructor(
    private readonly maxDocs: number = COLD_THREADS_MAX_DOCS,
    private readonly maxChars: number = COLD_THREADS_MAX_CHARS,
  ) {}

  /** The threads `read` gives for `docId`, decoded at most once while its
   *  state is unchanged. A fresh array each call, so no caller can reorder
   *  another's. `stampOf` is the doc state's save time now: it is recorded
   *  with a decode, and a restored entry answers only while it still matches. */
  get(docId: string, read: () => Thread[], stampOf?: () => number | undefined): Thread[] {
    let hit = this.entries.get(docId);
    if (hit?.restored) {
      if (hit.stamp !== undefined && stampOf?.() === hit.stamp) hit.restored = false;
      else {
        this.forget(docId);
        hit = undefined;
      }
    }
    if (hit) {
      this.hits++;
      this.entries.delete(docId);
      this.entries.set(docId, hit);
      return hit.threads.slice();
    }
    this.misses++;
    // Before the read, so a stamp can only be older than the bytes it names.
    const stamp = stampOf?.();
    const threads = read();
    this.put(docId, { threads, chars: weigh(threads), stamp, restored: false });
    return threads.slice();
  }

  /** The doc's state changed or went away: the next read decodes it. */
  forget(docId: string): void {
    const gone = this.entries.get(docId);
    if (!gone) return;
    this.entries.delete(docId);
    this.chars -= gone.chars;
  }

  stats(): ColdThreadsStats {
    return { docs: this.entries.size, chars: this.chars, hits: this.hits, misses: this.misses };
  }

  /** Write every stamped entry to `path`, replacing it whole. Never throws:
   *  a cache that cannot be saved costs the next start its decodes, nothing
   *  more. Answers how many entries were written. */
  save(path: string): number {
    const entries: SavedCache['entries'] = [];
    for (const [docId, e] of this.entries) {
      if (e.stamp !== undefined) entries.push([docId, e.stamp, e.threads]);
    }
    try {
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, JSON.stringify({ v: 1, entries } satisfies SavedCache), { mode: 0o600 });
      renameSync(tmp, path);
      return entries.length;
    } catch (err) {
      console.error('[cold-threads] save failed:', err);
      return 0;
    }
  }

  /** Read back what `save` wrote, as restored entries. A missing, damaged or
   *  foreign file loads nothing. Answers how many entries were read. */
  load(path: string): number {
    if (!existsSync(path)) return 0;
    let saved: unknown;
    try {
      saved = JSON.parse(readFileSync(path, 'utf8'));
    } catch (err) {
      console.error('[cold-threads] ignoring an unreadable saved cache:', err);
      return 0;
    }
    const entries = (saved as Partial<SavedCache> | null)?.entries;
    if ((saved as Partial<SavedCache> | null)?.v !== 1 || !Array.isArray(entries)) return 0;
    let n = 0;
    for (const row of entries) {
      if (!Array.isArray(row)) continue;
      const [docId, stamp, threads] = row as unknown[];
      if (typeof docId !== 'string' || typeof stamp !== 'number' || !isThreadList(threads)) {
        continue;
      }
      if (this.entries.has(docId)) continue;
      const list = threads as Thread[];
      this.put(docId, { threads: list, chars: weigh(list), stamp, restored: true });
      n++;
    }
    return n;
  }

  private put(docId: string, entry: Entry): void {
    if (entry.chars > this.maxChars) return;
    this.entries.set(docId, entry);
    this.chars += entry.chars;
    this.trim();
  }

  private trim(): void {
    for (const [docId, entry] of this.entries) {
      if (this.entries.size <= this.maxDocs && this.chars <= this.maxChars) return;
      this.entries.delete(docId);
      this.chars -= entry.chars;
    }
  }
}

/**
 * `store`, with `forget(docId)` called by every verb that changes what
 * `read(docId)` returns. Reads pass straight through.
 */
export function forgettingWrites(
  store: DocStateStore,
  forget: (docId: string) => void,
): DocStateStore {
  return {
    get kind() {
      return store.kind;
    },
    has: (docId: string, area?: DocStateArea) => store.has(docId, area),
    read: (docId: string) => store.read(docId),
    write: (docId: string, state: Uint8Array) => {
      forget(docId);
      store.write(docId, state);
    },
    savedAt: (docId: string) => store.savedAt(docId),
    list: () => store.list(),
    move: (docId: string, from: DocStateArea, to: DocStateArea) => {
      forget(docId);
      return store.move(docId, from, to);
    },
    stageDelete: (docId: string) => {
      forget(docId);
      return store.stageDelete(docId);
    },
    unstageDelete: (docId: string) => {
      forget(docId);
      store.unstageDelete(docId);
    },
    dropStaged: (docId: string) => {
      forget(docId);
      store.dropStaged(docId);
    },
    remove: (docId: string) => {
      forget(docId);
      return store.remove(docId);
    },
    keepBeforeCompaction: (docId: string, original: Uint8Array) =>
      store.keepBeforeCompaction(docId, original),
    keptCopyLabel: (docId: string) => store.keptCopyLabel(docId),
  };
}
