/**
 * The router's two hooks with the doc copy in front (doc-cache-boot.ts): a
 * copy lets the doc mount without the network, and a copy that belongs to
 * somebody else, or to a surface that is not cached, is never used.
 */
import type { FeedbackClient } from '@claude-workspaces/core';
import * as encoding from 'lib0/encoding';
import { describe, expect, it } from 'vitest';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import { cachedDocs, serverStateVectorOf } from '../src/doc-cache-boot.ts';
import type { CachedDoc, DocCacheStore } from '../src/doc-cache.ts';
import type { DocMeta } from '../src/mount-context.ts';

const META = { docType: 'markdown', sourceUrl: '/x.md', workspaceId: 'w-1' } as unknown as DocMeta;
const FALLBACK = { docType: 'markdown', sourceUrl: '', workspaceId: '' } as unknown as DocMeta;

function copyOf(text: string, who: string, meta: DocMeta = META): CachedDoc {
  const d = new Y.Doc();
  d.getText('t').insert(0, text);
  return {
    who,
    state: Y.encodeStateAsUpdate(d),
    serverStateVector: Y.encodeStateVector(d),
    meta,
    savedAt: 0,
  };
}

function storeWith(entries: Record<string, CachedDoc>): DocCacheStore {
  const m = new Map(Object.entries(entries));
  return {
    get: async (id) => m.get(id) ?? null,
    put: async (id, d) => void m.set(id, d),
    delete: async (id) => void m.delete(id),
    clear: async () => m.clear(),
  };
}

function fakeConnect() {
  const calls: Array<{ url: string; hasAccept: boolean }> = [];
  const accepts: Array<(frame: Uint8Array) => boolean> = [];
  const connect = (url: string, _p?: unknown, acceptSync?: (frame: Uint8Array) => boolean) => {
    calls.push({ url, hasAccept: typeof acceptSync === 'function' });
    if (acceptSync) accepts.push(acceptSync);
    const ydoc = new Y.Doc();
    // Never synced: the server is not there.
    return { ydoc, onReset: () => {}, onReady: () => {} } as unknown as FeedbackClient;
  };
  return { calls, accepts, connect };
}

describe('cachedDocs', () => {
  it('with a copy: mounts from it without waiting on the network meta', async () => {
    const { connect } = fakeConnect();
    const docs = cachedDocs({
      store: storeWith({ d1: copyOf('harborlight', 'anon') }),
      who: Promise.resolve('anon'),
      readMeta: () => new Promise(() => {}),
      fallbackMeta: () => FALLBACK,
      connect,
      onCopyRefused: () => {},
    });
    expect(await docs.fetchMeta('d1')).toEqual(META);
    const client = docs.connect('d1', 'markdown', 'ws://x/d1');
    expect(client.ydoc.getText('t').toString()).toBe('harborlight');
    // The content is there, so whatever waits for it runs without a server.
    let ready = 0;
    client.onReady(() => {
      ready++;
    });
    expect(ready).toBe(1);
  });

  it("another identity's copy is not used", async () => {
    const { connect } = fakeConnect();
    const fresh = { ...META, sourceUrl: '/fresh.md' } as DocMeta;
    const docs = cachedDocs({
      store: storeWith({ d1: copyOf('riverbend', 'user:alice') }),
      who: Promise.resolve('user:bob'),
      readMeta: async () => fresh,
      fallbackMeta: () => FALLBACK,
      connect,
      onCopyRefused: () => {},
    });
    expect(await docs.fetchMeta('d1')).toEqual(fresh);
    const client = docs.connect('d1', 'markdown', 'ws://x/d1');
    expect(client.ydoc.getText('t').toString()).toBe('');
    let ready = 0;
    client.onReady(() => {
      ready++;
    });
    expect(ready).toBe(0);
  });

  it('no copy and no network: the fallback meta, and a plain socket', async () => {
    const { calls, connect } = fakeConnect();
    const docs = cachedDocs({
      store: storeWith({}),
      who: Promise.resolve('anon'),
      readMeta: async () => null,
      fallbackMeta: () => FALLBACK,
      connect,
      onCopyRefused: () => {},
    });
    expect(await docs.fetchMeta('d1')).toEqual(FALLBACK);
    docs.connect('d1', 'markdown', 'ws://x/d1');
    expect(calls).toEqual([{ url: 'ws://x/d1', hasAccept: false }]);
  });

  it('a markdown doc read from the network is persisted; a code doc is not', async () => {
    const { calls, connect } = fakeConnect();
    const docs = cachedDocs({
      store: storeWith({}),
      who: Promise.resolve('anon'),
      readMeta: async () => META,
      fallbackMeta: () => FALLBACK,
      connect,
      onCopyRefused: () => {},
    });
    await docs.fetchMeta('d1');
    docs.connect('d1', 'markdown', 'ws://x/d1');
    await docs.fetchMeta('d2');
    docs.connect('d2', 'code', 'ws://x/d2');
    expect(calls.map((c) => c.hasAccept)).toEqual([true, false]);
  });

  it("a server that lost the copy's history: refused unanswered, remounted, and not seeded again", async () => {
    const { accepts, connect } = fakeConnect();
    const copy = copyOf('saltmarsh', 'anon');
    let remounts = 0;
    const docs = cachedDocs({
      store: storeWith({ d1: copy }),
      who: Promise.resolve('anon'),
      readMeta: async () => META,
      fallbackMeta: () => FALLBACK,
      connect,
      onCopyRefused: () => {
        remounts++;
      },
    });
    await docs.fetchMeta('d1');
    docs.connect('d1', 'markdown', 'ws://x/d1');
    const rebuilt = new Y.Doc();
    rebuilt.getText('t').insert(0, 'saltmarsh');
    expect(accepts[0]?.(step1(rebuilt))).toBe(false);
    expect(remounts).toBe(1);
    // The remount reads the doc again, and the store may still hold the copy.
    await docs.fetchMeta('d1');
    const again = docs.connect('d1', 'markdown', 'ws://x/d1');
    expect(again.ydoc.getText('t').toString()).toBe('');
  });

  it('a server that holds the history: accepted', async () => {
    const { accepts, connect } = fakeConnect();
    const original = new Y.Doc();
    original.getText('t').insert(0, 'riverbend');
    const copy: CachedDoc = {
      who: 'anon',
      state: Y.encodeStateAsUpdate(original),
      serverStateVector: Y.encodeStateVector(original),
      meta: META,
      savedAt: 0,
    };
    const docs = cachedDocs({
      store: storeWith({ d1: copy }),
      who: Promise.resolve('anon'),
      readMeta: async () => META,
      fallbackMeta: () => FALLBACK,
      connect,
      onCopyRefused: () => {
        throw new Error('not refused');
      },
    });
    await docs.fetchMeta('d1');
    docs.connect('d1', 'markdown', 'ws://x/d1');
    original.getText('t').insert(0, 'more ');
    expect(accepts[0]?.(step1(original))).toBe(true);
  });
});

function step1(doc: Y.Doc): Uint8Array {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, 0);
  syncProtocol.writeSyncStep1(enc, doc);
  return encoding.toUint8Array(enc);
}

describe('serverStateVectorOf', () => {
  it("reads a step 1's vector, and nothing else", () => {
    const doc = new Y.Doc();
    doc.getText('t').insert(0, 'harborlight');
    expect(serverStateVectorOf(step1(doc))).toEqual(Y.encodeStateVector(doc));
    const update = encoding.createEncoder();
    encoding.writeVarUint(update, 0);
    syncProtocol.writeUpdate(update, Y.encodeStateAsUpdate(doc));
    expect(serverStateVectorOf(encoding.toUint8Array(update))).toBeNull();
    expect(serverStateVectorOf(new Uint8Array([1, 0]))).toBeNull();
    expect(serverStateVectorOf(new Uint8Array([0]))).toBeNull();
  });
});
