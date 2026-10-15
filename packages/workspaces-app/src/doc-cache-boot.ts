/**
 * The doc editor's two router hooks — read a doc's meta, open its socket —
 * with this browser's copy of the doc (doc-cache.ts) put in front of both.
 *
 * With a copy, the meta comes from it and the socket's doc is seeded from it,
 * so the editor mounts without waiting on the network; the meta is re-read in
 * the background and stored for next time. Without one, both hooks do what
 * they did before. Markdown docs only: the code and diff surfaces are not
 * cached.
 */
import type { AcceptSync, FeedbackClient } from '@claude-workspaces/core';
import * as decoding from 'lib0/decoding';
import {
  type CachedDoc,
  type DocCacheStore,
  type DocPersistence,
  cacheIdentity,
  openDocCacheStore,
  persistDoc,
  seedFromCopy,
  settleCacheIdentity,
} from './doc-cache.ts';
import { fallbackDocMeta, readDocMetaOrNull } from './doc-meta.ts';
import { docIdFromPathOrNull } from './doc-path.ts';
import type { DocMeta } from './mount-context.ts';
import { WRITE_ACCESS_LOOKUP_MS, readSessionBody } from './signin/write-gate.ts';

interface PageEvents {
  addEventListener(type: string, fn: () => void): void;
  removeEventListener(type: string, fn: () => void): void;
}

/** `connect` from core, as the boot calls it. */
export type DocBootConnect = (
  url: string,
  protocol?: () => string | undefined,
  acceptSync?: AcceptSync,
) => FeedbackClient;

export interface DocBootOptions {
  pathname: string;
  /** Absent in a test that passes none, which boots with no copies. */
  indexedDB?: IDBFactory | undefined;
  storage: { getItem(k: string): string | null; setItem(k: string, v: string): void };
  connect: DocBootConnect;
  page?: PageEvents;
  onCopyRefused: () => void;
}

/**
 * Everything the first mount needs from the network, started together: the
 * session (asked once, shared by the write gate and the identity), the first
 * doc's meta, and its local copy. They used to run one after another, three
 * round trips before the socket opened.
 *
 * `session` is bounded once, and every reader takes this bounded answer: a
 * session that never answers is an unknown identity (null), not a page that
 * never mounts. Each reader used to start its own 4s bound in series, so a
 * stalled link waited 8s for one unanswered read.
 */
export function startDocBoot(o: DocBootOptions): {
  session: Promise<unknown>;
  docs: CachedDocs;
} {
  const store = o.indexedDB ? openDocCacheStore(o.indexedDB) : null;
  const session = Promise.race([
    readSessionBody(),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), WRITE_ACCESS_LOOKUP_MS)),
  ]);
  const who = session.then((body) => settleCacheIdentity(cacheIdentity(body), o.storage, store));
  const firstDocId = docIdFromPathOrNull(o.pathname);
  let firstMeta = firstDocId ? readDocMetaOrNull(firstDocId) : null;
  const docs = cachedDocs({
    store,
    who,
    readMeta: (docId) => {
      const early = docId === firstDocId ? firstMeta : null;
      firstMeta = null;
      return early ?? readDocMetaOrNull(docId);
    },
    fallbackMeta: fallbackDocMeta,
    connect: o.connect,
    ...(o.page ? { page: o.page } : {}),
    onCopyRefused: o.onCopyRefused,
  });
  return { session, docs };
}

export interface CachedDocsOptions {
  store: DocCacheStore | null;
  /** The identity copies belong to, once the session has answered. */
  who: Promise<string>;
  /** Null when the server could not be read. */
  readMeta: (docId: string) => Promise<DocMeta | null>;
  /** What the router mounts when there is neither a copy nor an answer. */
  fallbackMeta: () => DocMeta;
  connect: DocBootConnect;
  page?: PageEvents;
  /**
   * The copy was refused by the server's history: remount from the server.
   * Must close this doc's client before it returns (the router's remount
   * disposes the old mount synchronously): the socket answers no more frames
   * once it is closed, and the refused one goes unanswered.
   */
  onCopyRefused: () => void;
}

export interface CachedDocs {
  fetchMeta(docId: string): Promise<DocMeta>;
  connect(docId: string, docType: string, url: string): FeedbackClient;
}

export function cachedDocs(o: CachedDocsOptions): CachedDocs {
  const { store } = o;
  /** What `fetchMeta` found, waiting for the `connect` that follows it. */
  const pending = new Map<string, { copy: CachedDoc | null; meta: DocMeta | null; who: string }>();
  const live = new Map<string, DocPersistence>();
  /** Docs whose copy the server's history refused: not seeded again this page,
   *  even before the store's delete lands. */
  const refused = new Set<string>();

  return {
    async fetchMeta(docId) {
      const who = await o.who;
      const found = store ? await store.get(docId) : null;
      const copy =
        found && found.who === who && found.meta.docType === 'markdown' && !refused.has(docId)
          ? found
          : null;
      const fresh = o.readMeta(docId);
      if (copy) {
        pending.set(docId, { copy, meta: copy.meta, who });
        void fresh.then((meta) => {
          if (meta) live.get(docId)?.setMeta(meta);
        });
        return copy.meta;
      }
      const meta = await fresh;
      pending.set(docId, { copy: null, meta, who });
      return meta ?? o.fallbackMeta();
    },

    connect(docId, docType, url) {
      const found = pending.get(docId);
      pending.delete(docId);
      if (!store || !found || docType !== 'markdown' || !found.meta) return o.connect(url);
      let persistence: DocPersistence | null = null;
      const client = o.connect(url, undefined, (frame) => {
        const sv = serverStateVectorOf(frame);
        if (!sv || !persistence || persistence.acceptServerState(sv)) return true;
        refused.add(docId);
        o.onCopyRefused();
        return false;
      });
      if (found.copy) seedFromCopy(client.ydoc, found.copy);
      persistence = persistDoc({
        ydoc: client.ydoc,
        docId,
        who: found.who,
        meta: found.meta,
        store,
        seededFrom: found.copy,
        ...(o.page ? { page: o.page } : {}),
      });
      const mine = persistence;
      live.set(docId, mine);
      client.ydoc.once('destroy', () => {
        if (live.get(docId) === mine) live.delete(docId);
      });
      return found.copy ? readyFromCopy(client) : client;
    },
  };
}

/** The SYNC message kind, and its step-1 sub-kind, from y-protocols. */
const MSG_SYNC = 0;
const SYNC_STEP_1 = 0;

/**
 * The server's state vector, when `frame` is the server opening a sync (step
 * 1); null for any other frame, or one that does not parse.
 */
export function serverStateVectorOf(frame: Uint8Array): Uint8Array | null {
  try {
    const dec = decoding.createDecoder(frame);
    if (decoding.readVarUint(dec) !== MSG_SYNC) return null;
    if (decoding.readVarUint(dec) !== SYNC_STEP_1) return null;
    return decoding.readVarUint8Array(dec);
  } catch {
    return null;
  }
}

/**
 * The client, with `onReady` answered at once. Every mount hook that waits on
 * it (the doc label, the comment list, a `?thread=` reveal) waits for the
 * doc's content to be there, and a seeded doc's content is there before any
 * socket opens. Offline the server's first sync never comes, and without this
 * the page showed the prose with no label and no comments.
 */
function readyFromCopy(client: FeedbackClient): FeedbackClient {
  return Object.create(client, {
    onReady: { value: (cb: () => void) => cb() },
  }) as FeedbackClient;
}
