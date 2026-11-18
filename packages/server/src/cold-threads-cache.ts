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
 */
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

export interface ColdThreadsStats {
  docs: number;
  chars: number;
  hits: number;
  misses: number;
}

export class ColdThreadsCache {
  /** Insertion order is recency: a read moves its entry to the end. */
  private readonly entries = new Map<string, { threads: Thread[]; chars: number }>();
  private chars = 0;
  private hits = 0;
  private misses = 0;

  constructor(
    private readonly maxDocs: number = COLD_THREADS_MAX_DOCS,
    private readonly maxChars: number = COLD_THREADS_MAX_CHARS,
  ) {}

  /** The threads `read` gives for `docId`, decoded at most once while its
   *  state is unchanged. A fresh array each call, so no caller can reorder
   *  another's. */
  get(docId: string, read: () => Thread[]): Thread[] {
    const hit = this.entries.get(docId);
    if (hit) {
      this.hits++;
      this.entries.delete(docId);
      this.entries.set(docId, hit);
      return hit.threads.slice();
    }
    this.misses++;
    const threads = read();
    const chars = weigh(threads);
    if (chars <= this.maxChars) {
      this.entries.set(docId, { threads, chars });
      this.chars += chars;
      this.trim();
    }
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
