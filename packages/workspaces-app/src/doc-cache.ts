/**
 * A copy of each opened doc kept in this browser, so the page shows the doc
 * before the network answers and still shows it when there is no network.
 *
 * Measured on a throttled link (600ms RTT, 1 Mbps down): a reload waited ~7
 * round trips for the socket's sync before any prose painted, and with the
 * link cut it painted nothing at all. Seeding the doc from this copy makes the
 * reload paint as soon as the bundle runs, and edits made while offline sit in
 * the copy until the socket comes back and sync step 2 carries them up.
 *
 * Three rules keep the copy from doing harm:
 *
 *  1. **It never pushes history the server has shed.** A copy is written only
 *     once the server has opened a sync on this page, and it records the
 *     server's state vector from that moment. On the next connect the server's
 *     vector must cover it; one that does not means the server's doc was
 *     rebuilt or restored, and merging the copy back would duplicate or revive
 *     what it shed. The client refuses that sync unanswered
 *     (`acceptSync`, doc-cache-boot.ts), the copy is dropped and the doc
 *     remounts from the server.
 *  2. **It belongs to one identity.** Each copy names who the session said was
 *     signed in. When a session answers with somebody else, every copy goes
 *     before anything renders; sign-out clears them too.
 *  3. **It is best effort.** Every IndexedDB failure reads as "no copy": the
 *     page then behaves exactly as it did without one.
 */
import * as Y from 'yjs';
import type { DocMeta } from './mount-context.ts';

export interface CachedDoc {
  /** The identity the copy was written under (`cacheIdentity`). */
  who: string;
  /** `Y.encodeStateAsUpdate` of the whole doc. */
  state: Uint8Array;
  /** What the server held, by its own state vector, when this page synced. */
  serverStateVector: Uint8Array;
  /** The doc's metadata, so a reload can pick its surface without asking. */
  meta: DocMeta;
  savedAt: number;
}

export interface DocCacheStore {
  get(docId: string): Promise<CachedDoc | null>;
  put(docId: string, doc: CachedDoc): Promise<void>;
  delete(docId: string): Promise<void>;
  clear(): Promise<void>;
}

const DB_NAME = 'cw-doc-cache';
const STORE = 'docs';
/** A reader opens a few dozen docs; past this the oldest copies go. */
export const MAX_CACHED_DOCS = 60;

function done<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

/** The IndexedDB-backed store, or null where the browser has none. */
export function openDocCacheStore(
  idb: IDBFactory | undefined = globalThis.indexedDB,
): DocCacheStore | null {
  if (!idb) return null;
  let db: Promise<IDBDatabase | null>;
  try {
    const open = idb.open(DB_NAME, 1);
    open.onupgradeneeded = () => {
      const store = open.result.createObjectStore(STORE);
      store.createIndex('savedAt', 'savedAt');
    };
    db = done(open).catch(() => null);
  } catch {
    return null;
  }
  const run = async <T>(
    mode: IDBTransactionMode,
    fn: (s: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T | null> => {
    try {
      const d = await db;
      if (!d) return null;
      return await done(fn(d.transaction(STORE, mode).objectStore(STORE)));
    } catch {
      return null;
    }
  };
  const prune = async (): Promise<void> => {
    const n = await run('readonly', (s) => s.count());
    if (n === null || n <= MAX_CACHED_DOCS) return;
    const oldest = await run('readonly', (s) =>
      s.index('savedAt').getAllKeys(null, n - MAX_CACHED_DOCS),
    );
    for (const key of oldest ?? []) await run('readwrite', (s) => s.delete(key));
  };
  return {
    async get(docId) {
      const rec = await run('readonly', (s) => s.get(docId) as IDBRequest<CachedDoc | undefined>);
      return rec ?? null;
    },
    async put(docId, doc) {
      await run('readwrite', (s) => s.put(doc, docId));
      await prune();
    },
    async delete(docId) {
      await run('readwrite', (s) => s.delete(docId));
    },
    async clear() {
      await run('readwrite', (s) => s.clear());
    },
  };
}

/** Every copy in this browser, gone — for sign-out, from any page. */
export async function clearDocCache(
  store: DocCacheStore | null = openDocCacheStore(),
): Promise<void> {
  await store?.clear();
}

/** Where the last identity a session confirmed is kept. */
export const CACHE_WHO_KEY = 'cw.docCache.who';

/**
 * Who a `/api/auth/session` body says this browser is, or null when there is
 * no body (offline, a failed or timed-out read): "unknown", which is not the
 * same as "nobody".
 */
export function cacheIdentity(sessionBody: unknown): string | null {
  if (!sessionBody || typeof sessionBody !== 'object') return null;
  const b = sessionBody as { authenticated?: boolean; user?: { id?: unknown } };
  return b.authenticated === true && typeof b.user?.id === 'string' ? `user:${b.user.id}` : 'anon';
}

interface WhoStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * The identity copies are read and written under. A known identity that
 * differs from the last one clears every copy first; an unknown one falls
 * back to the last identity this browser confirmed.
 */
export async function settleCacheIdentity(
  known: string | null,
  storage: WhoStorage,
  store: DocCacheStore | null,
): Promise<string> {
  let last: string | null = null;
  try {
    last = storage.getItem(CACHE_WHO_KEY);
  } catch {}
  if (known === null) return last ?? 'anon';
  if (last !== known) {
    await store?.clear();
    try {
      storage.setItem(CACHE_WHO_KEY, known);
    } catch {}
  }
  return known;
}

/** True when the server no longer holds something it held when the copy was written. */
export function serverLostHistory(confirmed: Uint8Array, server: Uint8Array): boolean {
  const have = Y.decodeStateVector(server);
  for (const [client, clock] of Y.decodeStateVector(confirmed)) {
    if ((have.get(client) ?? 0) < clock) return true;
  }
  return false;
}

interface PageEvents {
  addEventListener(type: string, fn: () => void): void;
  removeEventListener(type: string, fn: () => void): void;
}

export interface PersistOptions {
  ydoc: Y.Doc;
  docId: string;
  who: string;
  meta: DocMeta;
  store: DocCacheStore;
  /** The copy this doc was seeded from, if any. */
  seededFrom: CachedDoc | null;
  /** Page-hide and visibility events, so a closing tab writes its last edits. */
  page?: PageEvents;
  delayMs?: number;
}

export interface DocPersistence {
  /** Whether this doc may answer a server whose state vector is this. Once
   *  false, false for good: the copy it would have pushed is still in the doc. */
  acceptServerState(serverStateVector: Uint8Array): boolean;
  setMeta(meta: DocMeta): void;
}

/** Debounce for writing the copy after an edit. */
export const PERSIST_DELAY_MS = 800;

/**
 * Keep `ydoc`'s copy current until the doc is destroyed. Writes nothing until
 * a server has opened a sync on this page or the doc was seeded from a copy,
 * so every copy carries the vector rule 1 checks.
 */
export function persistDoc(o: PersistOptions): DocPersistence {
  const { ydoc, docId, who, store, page } = o;
  const delay = o.delayMs ?? PERSIST_DELAY_MS;
  let meta = o.meta;
  let confirmed: Uint8Array | null = o.seededFrom?.serverStateVector ?? null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let refused = false;

  const write = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (confirmed === null || refused) return;
    void store.put(docId, {
      who,
      state: Y.encodeStateAsUpdate(ydoc),
      serverStateVector: confirmed,
      meta,
      savedAt: Date.now(),
    });
  };
  const schedule = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(write, delay);
  };
  const onHide = (): void => {
    if (timer !== null) write();
  };
  ydoc.on('update', schedule);
  page?.addEventListener('pagehide', onHide);
  page?.addEventListener('visibilitychange', onHide);
  ydoc.once('destroy', () => {
    onHide();
    ydoc.off('update', schedule);
    page?.removeEventListener('pagehide', onHide);
    page?.removeEventListener('visibilitychange', onHide);
  });

  return {
    acceptServerState(serverStateVector) {
      if (refused) return false;
      if (confirmed !== null && serverLostHistory(confirmed, serverStateVector)) {
        if (timer !== null) clearTimeout(timer);
        timer = null;
        confirmed = null;
        refused = true;
        void store.delete(docId);
        return false;
      }
      confirmed = serverStateVector;
      schedule();
      return true;
    },
    setMeta(next) {
      meta = next;
      schedule();
    },
  };
}

/** Seed a fresh doc from its copy. Applied before the socket opens, so sync
 *  step 1 already names what this browser holds. */
export function seedFromCopy(ydoc: Y.Doc, copy: CachedDoc): void {
  Y.applyUpdate(ydoc, copy.state, 'doc-cache');
}
