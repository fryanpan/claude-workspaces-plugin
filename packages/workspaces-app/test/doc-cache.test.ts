/**
 * The doc copy's three rules (doc-cache.ts), driven against an in-memory
 * store: it never pushes history the server shed, it belongs to one
 * identity, and it is written only once a server has confirmed a state.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import {
  CACHE_WHO_KEY,
  type CachedDoc,
  type DocCacheStore,
  cacheIdentity,
  persistDoc,
  seedFromCopy,
  serverLostHistory,
  settleCacheIdentity,
} from '../src/doc-cache.ts';
import type { DocMeta } from '../src/mount-context.ts';

function memoryStore(): DocCacheStore & {
  map: Map<string, CachedDoc>;
  appended: Uint8Array[];
} {
  const map = new Map<string, CachedDoc>();
  const appended: Uint8Array[] = [];
  return {
    map,
    appended,
    append: (_id, _who, update) => void appended.push(update),
    get: async (id) => map.get(id) ?? null,
    put: async (id, doc) => {
      map.set(id, doc);
    },
    delete: async (id) => {
      map.delete(id);
    },
    clear: async () => {
      map.clear();
    },
  };
}

function memoryStorage(): {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
} {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) };
}

const META = { docType: 'markdown', sourceUrl: '', workspaceId: '' } as unknown as DocMeta;

describe('cacheIdentity', () => {
  it('names a signed-in user by id, anyone else as anon', () => {
    expect(cacheIdentity({ authenticated: true, user: { id: 'u-riverbend' } })).toBe(
      'user:u-riverbend',
    );
    expect(cacheIdentity({ authenticated: false })).toBe('anon');
  });
  it('reads no answer as unknown, not as anon', () => {
    expect(cacheIdentity(null)).toBeNull();
  });
});

describe('settleCacheIdentity', () => {
  it('clears every copy when a different identity answers', async () => {
    const store = memoryStore();
    store.map.set('d1', {} as CachedDoc);
    const storage = memoryStorage();
    storage.setItem(CACHE_WHO_KEY, 'user:alice');
    expect(await settleCacheIdentity('user:bob', storage, store)).toBe('user:bob');
    expect(store.map.size).toBe(0);
    expect(storage.getItem(CACHE_WHO_KEY)).toBe('user:bob');
  });

  it('keeps the copies when the same identity answers', async () => {
    const store = memoryStore();
    store.map.set('d1', {} as CachedDoc);
    const storage = memoryStorage();
    storage.setItem(CACHE_WHO_KEY, 'user:alice');
    await settleCacheIdentity('user:alice', storage, store);
    expect(store.map.size).toBe(1);
  });

  it('offline (unknown) falls back to the last confirmed identity and clears nothing', async () => {
    const store = memoryStore();
    store.map.set('d1', {} as CachedDoc);
    const storage = memoryStorage();
    storage.setItem(CACHE_WHO_KEY, 'user:alice');
    expect(await settleCacheIdentity(null, storage, store)).toBe('user:alice');
    expect(store.map.size).toBe(1);
  });
});

describe('serverLostHistory', () => {
  it('is false when the server holds at least what it held then', () => {
    const doc = new Y.Doc();
    doc.getText('t').insert(0, 'harborlight');
    const then = Y.encodeStateVector(doc);
    doc.getText('t').insert(0, 'more ');
    expect(serverLostHistory(then, Y.encodeStateVector(doc))).toBe(false);
  });

  it('is true when the server was rebuilt without it', () => {
    const doc = new Y.Doc();
    doc.getText('t').insert(0, 'harborlight');
    const rebuilt = new Y.Doc();
    rebuilt.getText('t').insert(0, 'harborlight');
    expect(serverLostHistory(Y.encodeStateVector(doc), Y.encodeStateVector(rebuilt))).toBe(true);
  });
});

describe('persistDoc', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('writes nothing until a server has confirmed a state', async () => {
    const store = memoryStore();
    const ydoc = new Y.Doc();
    persistDoc({ ydoc, docId: 'd1', who: 'anon', meta: META, store, seededFrom: null });
    ydoc.getText('t').insert(0, 'typed before any sync');
    await vi.runAllTimersAsync();
    expect(store.map.has('d1')).toBe(false);
  });

  it('after a sync, an edit lands in the copy with the confirmed vector', async () => {
    const store = memoryStore();
    const server = new Y.Doc();
    server.getText('t').insert(0, 'saltmarsh');
    const ydoc = new Y.Doc();
    Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(server));
    const p = persistDoc({ ydoc, docId: 'd1', who: 'anon', meta: META, store, seededFrom: null });
    expect(p.acceptServerState(Y.encodeStateVector(server))).toBe(true);
    ydoc.getText('t').insert(0, 'offline edit ');
    await vi.runAllTimersAsync();
    const copy = store.map.get('d1') as CachedDoc;
    expect(copy.serverStateVector).toEqual(Y.encodeStateVector(server));
    const reread = new Y.Doc();
    seedFromCopy(reread, copy);
    expect(reread.getText('t').toString()).toBe('offline edit saltmarsh');
  });

  it('refuses and deletes the copy when the server lost what the copy recorded', async () => {
    const store = memoryStore();
    const original = new Y.Doc();
    original.getText('t').insert(0, 'riverbend');
    const copy: CachedDoc = {
      who: 'anon',
      state: Y.encodeStateAsUpdate(original),
      serverStateVector: Y.encodeStateVector(original),
      meta: META,
      savedAt: 0,
    };
    store.map.set('d1', copy);
    const ydoc = new Y.Doc();
    seedFromCopy(ydoc, copy);
    const p = persistDoc({ ydoc, docId: 'd1', who: 'anon', meta: META, store, seededFrom: copy });
    const rebuilt = new Y.Doc();
    rebuilt.getText('t').insert(0, 'riverbend');
    expect(p.acceptServerState(Y.encodeStateVector(rebuilt))).toBe(false);
    await vi.runAllTimersAsync();
    expect(store.map.has('d1')).toBe(false);
  });

  it('an edit made on this page is appended at once, before the full write', async () => {
    const store = memoryStore();
    const server = new Y.Doc();
    server.getText('t').insert(0, 'saltmarsh');
    const ydoc = new Y.Doc();
    Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(server));
    const p = persistDoc({ ydoc, docId: 'd1', who: 'anon', meta: META, store, seededFrom: null });
    p.acceptServerState(Y.encodeStateVector(server));
    await vi.runAllTimersAsync();
    const full = store.map.get('d1') as CachedDoc;
    ydoc.getText('t').insert(0, 'typed ');
    // No timer has run: the edit is kept already.
    expect(store.appended).toHaveLength(1);
    expect(store.map.get('d1')).toBe(full);
    const reread = new Y.Doc();
    Y.applyUpdate(reread, Y.mergeUpdates([full.state, ...store.appended]));
    expect(reread.getText('t').toString()).toBe('typed saltmarsh');
  });

  it('what the server sends is not appended, only written in full later', async () => {
    const store = memoryStore();
    const server = new Y.Doc();
    const ydoc = new Y.Doc();
    const p = persistDoc({ ydoc, docId: 'd1', who: 'anon', meta: META, store, seededFrom: null });
    p.acceptServerState(Y.encodeStateVector(server));
    server.getText('t').insert(0, 'riverbend');
    Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(server), 'socket');
    expect(store.appended).toHaveLength(0);
    await vi.runAllTimersAsync();
    const reread = new Y.Doc();
    seedFromCopy(reread, store.map.get('d1') as CachedDoc);
    expect(reread.getText('t').toString()).toBe('riverbend');
  });

  it('the first edit on a doc with no copy yet writes the copy in full at once', () => {
    const store = memoryStore();
    const ydoc = new Y.Doc();
    const p = persistDoc({ ydoc, docId: 'd1', who: 'anon', meta: META, store, seededFrom: null });
    p.acceptServerState(Y.encodeStateVector(new Y.Doc()));
    ydoc.getText('t').insert(0, 'harborlight');
    expect(store.appended).toHaveLength(0);
    const reread = new Y.Doc();
    seedFromCopy(reread, store.map.get('d1') as CachedDoc);
    expect(reread.getText('t').toString()).toBe('harborlight');
  });

  it('a hidden page writes its pending edit at once', async () => {
    const store = memoryStore();
    const listeners = new Map<string, () => void>();
    const page = {
      addEventListener: (t: string, fn: () => void) => void listeners.set(t, fn),
      removeEventListener: () => {},
    };
    const ydoc = new Y.Doc();
    const p = persistDoc({
      ydoc,
      docId: 'd1',
      who: 'anon',
      meta: META,
      store,
      seededFrom: null,
      page,
    });
    p.acceptServerState(Y.encodeStateVector(new Y.Doc()));
    await vi.runAllTimersAsync();
    store.map.clear();
    ydoc.getText('t').insert(0, 'last words');
    listeners.get('pagehide')?.();
    await Promise.resolve();
    expect(store.map.has('d1')).toBe(true);
  });
});
