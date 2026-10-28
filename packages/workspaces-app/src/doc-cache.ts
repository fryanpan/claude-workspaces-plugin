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
  /** The copy, with every edit appended since its last full write folded in. */
  get(docId: string): Promise<CachedDoc | null>;
  /** Write the copy in full, then drop the appended edits this store has
   *  written or read for the doc: the full state covers them. */
  put(docId: string, doc: CachedDoc): Promise<void>;
  /** Keep one edit at once, without waiting for the next full write. `who`
   *  is the identity it was made under: a copy folds in only its own. */
  append(docId: string, who: string, update: Uint8Array): void;
  /** Send every edit still waiting on the database, for a page about to go. */
  flush(): void;
  delete(docId: string): Promise<void>;
  clear(): Promise<void>;
}

const DB_NAME = 'cw-doc-cache';
const STORE = 'docs';
/**
 * The appended edits live in a database of their own, so adding them needed
 * no version upgrade of `cw-doc-cache`: a tab still open on the old bundle
 * holds that database open, and an upgrade would wait on it with no copy at
 * all for the new page. Keys are `[docId, pageId, n]`, so one range covers a
 * doc and each page drops only the edits it knows its full write holds.
 */
const UPDATES_DB_NAME = 'cw-doc-cache-updates';
const UPDATES = 'updates';
/** A reader opens a few dozen docs; past this the oldest copies go. */
export const MAX_CACHED_DOCS = 60;

function done<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

/** Every appended key of one doc, whoever wrote it. */
const docRange = (docId: string): IDBKeyRange => IDBKeyRange.bound([docId], [docId, []]);

interface Entry {
  key: IDBValidKey;
  value: unknown;
}

/** One appended edit, as stored. */
interface AppendedEdit {
  who: string;
  update: Uint8Array;
}

const editOf = (v: unknown, who: string): Uint8Array[] => {
  const e = v as Partial<AppendedEdit> | null;
  return e && e.who === who && e.update instanceof Uint8Array ? [e.update] : [];
};

type Run = <T>(
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest<T>,
) => Promise<T | null>;

/** One database with one store, opened lazily; every failure reads as null. */
function openOne(
  idb: IDBFactory,
  name: string,
  store: string,
  upgrade: (db: IDBDatabase) => void,
): {
  run: Run;
  now: () => IDBDatabase | null;
  ready: Promise<unknown>;
  entries: (range: IDBKeyRange) => Promise<Entry[]>;
} {
  let ready: IDBDatabase | null = null;
  let db: Promise<IDBDatabase | null>;
  try {
    const open = idb.open(name, 1);
    open.onupgradeneeded = () => upgrade(open.result);
    db = done(open).then(
      (d) => {
        // A database somebody created without the store reads as none.
        ready = d.objectStoreNames.contains(store) ? d : null;
        return ready;
      },
      () => null,
    );
  } catch {
    db = Promise.resolve(null);
  }
  const run: Run = async (mode, fn) => {
    try {
      const d = await db;
      if (!d) return null;
      return await done(fn(d.transaction(store, mode).objectStore(store)));
    } catch {
      return null;
    }
  };
  /** Every key and value in `range`, read in one transaction. */
  const entries = async (range: IDBKeyRange): Promise<Entry[]> => {
    try {
      const d = await db;
      if (!d) return [];
      const cursor = d.transaction(store, 'readonly').objectStore(store).openCursor(range);
      return await new Promise<Entry[]>((resolve, reject) => {
        const out: Entry[] = [];
        cursor.onsuccess = () => {
          const c = cursor.result;
          if (!c) return resolve(out);
          out.push({ key: c.primaryKey, value: c.value });
          c.continue();
        };
        cursor.onerror = () => reject(cursor.error);
      });
    } catch {
      return [];
    }
  };
  return { run, now: () => ready, ready: db, entries };
}

/** The IndexedDB-backed store, or null where the browser has none. */
export function openDocCacheStore(
  idb: IDBFactory | undefined = globalThis.indexedDB,
): DocCacheStore | null {
  if (!idb) return null;
  const docs = openOne(idb, DB_NAME, STORE, (d) => {
    d.createObjectStore(STORE).createIndex('savedAt', 'savedAt');
  });
  const updates = openOne(idb, UPDATES_DB_NAME, UPDATES, (d) => {
    d.createObjectStore(UPDATES);
  });
  const run = docs.run;
  /** Names this page's keys apart from another tab's on the same doc. */
  const pageId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  let seq = 0;
  /** Per doc, the appended keys this store wrote or read: what a full write
   *  made from this page's doc covers. */
  const known = new Map<string, IDBValidKey[]>();
  const remember = (docId: string, keys: IDBValidKey[]): void => {
    const list = known.get(docId);
    if (list) list.push(...keys);
    else known.set(docId, [...keys]);
  };
  /** Edits not yet handed to a transaction: only while the database opens. */
  const waiting: Array<{ key: IDBValidKey; edit: AppendedEdit }> = [];
  /**
   * Hand every waiting edit to one transaction, opened and committed in this
   * task. `commit()` matters on a busy page: without it the transaction ends
   * only once the page has run the put's success event, and a reload before
   * that aborted it, so the edit was lost with its write already sent.
   * False when the database is not open yet.
   */
  const send = (): boolean => {
    const d = updates.now();
    if (!d) return false;
    if (waiting.length === 0) return true;
    const batch = waiting.splice(0);
    try {
      const tx = d.transaction(UPDATES, 'readwrite');
      const s = tx.objectStore(UPDATES);
      for (const w of batch) s.put(w.edit, w.key);
      tx.commit();
    } catch {}
    return true;
  };
  const dropAppended = (docId: string) =>
    updates.run('readwrite', (s) => s.delete(docRange(docId)));
  const prune = async (): Promise<void> => {
    const n = await run('readonly', (s) => s.count());
    if (n === null || n <= MAX_CACHED_DOCS) return;
    const oldest = await run('readonly', (s) =>
      s.index('savedAt').getAllKeys(null, n - MAX_CACHED_DOCS),
    );
    for (const key of oldest ?? []) {
      await run('readwrite', (s) => s.delete(key));
      if (typeof key === 'string') await dropAppended(key);
    }
  };
  return {
    async get(docId) {
      // The edits before the copy: a full write that lands between the two
      // reads covers whatever it dropped, so nothing falls in the gap.
      const edits = await updates.entries(docRange(docId));
      const rec = await run('readonly', (s) => s.get(docId) as IDBRequest<CachedDoc | undefined>);
      if (!rec) return null;
      remember(
        docId,
        edits.map((e) => e.key),
      );
      // An edit left by another identity (written after a sign-out cleared
      // the store) is never folded into this one's copy.
      const appended = edits.flatMap((e) => editOf(e.value, rec.who));
      if (appended.length === 0) return rec;
      try {
        return { ...rec, state: Y.mergeUpdates([rec.state, ...appended]) };
      } catch {
        return rec;
      }
    },
    async put(docId, doc) {
      const covered = known.get(docId) ?? [];
      known.delete(docId);
      if ((await run('readwrite', (s) => s.put(doc, docId))) === null) {
        // Not written: the edits are still the only record of themselves.
        remember(docId, covered);
        return;
      }
      await prune();
      const last = covered.pop();
      if (last === undefined) return;
      await updates.run('readwrite', (s) => {
        for (const key of covered) s.delete(key);
        return s.delete(last);
      });
    },
    append(docId, who, update) {
      const key: IDBValidKey = [docId, pageId, seq++];
      remember(docId, [key]);
      waiting.push({ key, edit: { who, update } });
      // A database that never opens keeps nothing: drop what waited on it.
      if (!send()) void updates.ready.then(() => send() || waiting.splice(0));
    },
    flush() {
      send();
    },
    async delete(docId) {
      known.delete(docId);
      await run('readwrite', (s) => s.delete(docId));
      await dropAppended(docId);
    },
    async clear() {
      known.clear();
      await run('readwrite', (s) => s.clear());
      await updates.run('readwrite', (s) => s.clear());
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

/** Debounce for writing the copy in full after an edit. Each edit made here
 *  is appended at once (`append`); the full write folds them in. */
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
  /** Whether a full copy exists for appended edits to land on. */
  let written = o.seededFrom !== null;

  const write = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (confirmed === null || refused) return;
    written = true;
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
    store.flush();
    if (timer !== null) write();
  };
  const onVisibility = (): void => {
    if (globalThis.document?.visibilityState !== 'visible') onHide();
  };
  // An edit made on this page is kept at once: a reload inside the debounce
  // used to lose it on a slow device, where the write on page hide did not
  // land first. What the server sent is on the server, so it waits.
  const onUpdate = (update: Uint8Array, _origin: unknown, _doc: Y.Doc, tr: Y.Transaction): void => {
    if (tr.local && confirmed !== null && !refused) {
      if (!written) {
        write();
        return;
      }
      store.append(docId, who, update);
    }
    schedule();
  };
  ydoc.on('update', onUpdate);
  page?.addEventListener('pagehide', onHide);
  page?.addEventListener('visibilitychange', onVisibility);
  ydoc.once('destroy', () => {
    onHide();
    ydoc.off('update', onUpdate);
    page?.removeEventListener('pagehide', onHide);
    page?.removeEventListener('visibilitychange', onVisibility);
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
