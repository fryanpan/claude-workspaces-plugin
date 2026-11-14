/**
 * What the store answers about a doc without opening it, driven directly
 * rather than through a `DocStore`. It came out of `doc-store.ts` as a pure
 * move, so the listing, alias and index paths already had coverage through
 * the store; what they lacked was a test that can fail for the catalog's own
 * reasons — which copy of a row wins, when the index is trusted over the
 * live doc, and that a readable name is never repointed. One fake host and a
 * temporary data directory, no HTTP.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type DocMeta, type User, createThread } from '@claude-workspaces/core';
import * as Y from 'yjs';
import { DocCatalog, type DocCatalogHost } from '../src/doc-catalog.ts';
import { DOC_INDEX_VERSION, type DocIndexEntry } from '../src/doc-index.ts';
import { DiskDocStateStore } from '../src/doc-state/disk.ts';
import type { LiveDoc } from '../src/doc-store.ts';

const harborlight: User = {
  id: 'harborlight',
  name: 'Harborlight',
  kind: 'known',
  color: '#000000',
};

function meta(docId: string, extra: Partial<DocMeta> = {}): DocMeta {
  return { docId, type: 'markdown', createdAt: 1_000, ...extra } as DocMeta;
}

function row(docId: string, threads = { open: 0, total: 0 }, extra: Partial<DocMeta> = {}) {
  return { v: DOC_INDEX_VERSION, meta: meta(docId, extra), threads } satisfies DocIndexEntry;
}

function liveDoc(docId: string, extra: Partial<DocMeta> = {}): LiveDoc {
  return { docId, ydoc: new Y.Doc(), meta: meta(docId, extra) } as LiveDoc;
}

function addThread(doc: LiveDoc, threadId: string): void {
  createThread(doc.ydoc, {
    threadId,
    anchor: {
      kind: 'element',
      fingerprint: {
        tag: 'P',
        stableAttrs: {},
        classes: [],
        text: 'x',
        path: 'P[0]',
        dataAttrs: {},
      },
      snippet: { text: 'x' },
    },
    createdBy: harborlight,
    firstComment: { id: `${threadId}-c1`, text: 'a point' },
  });
}

let dataDir: string;
let resident: Map<string, LiveDoc>;
let pendingSaves: Set<string>;
let changes: { docId: string; prev?: DocIndexEntry; next?: DocIndexEntry }[];
let owed: boolean;

function makeCatalog(): DocCatalog {
  const host: DocCatalogHost = {
    dataDir: () => dataDir,
    docState: () => new DiskDocStateStore(dataDir),
    residentDoc: (docId) => resident.get(docId),
    residentDocs: () => resident.values(),
    hasPendingSave: (docId) => pendingSaves.has(docId),
    fileWriteOwed: () => owed,
    hydrateBlocking: () => {},
    evict: () => {},
    indexChanged: (docId, prev, next) => {
      changes.push({ docId, ...(prev ? { prev } : {}), ...(next ? { next } : {}) });
    },
  };
  return new DocCatalog(host);
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'doc-catalog-'));
  resident = new Map();
  pendingSaves = new Set();
  changes = [];
  owed = false;
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('DocCatalog', () => {
  it('lists a resident doc from memory and every other doc from its row', () => {
    const catalog = makeCatalog();
    catalog.setIndex('riverbend', row('riverbend', undefined, { title: 'old title' }));
    catalog.setIndex('saltmarsh', row('saltmarsh'));
    resident.set('riverbend', liveDoc('riverbend', { title: 'new title' }));

    const titles = new Map(catalog.list().map((m) => [m.docId, m.title]));
    expect(titles.get('riverbend')).toBe('new title');
    expect(titles.has('saltmarsh')).toBe(true);
    // The index-only listing refuses to consult the resident doc.
    const fromIndex = new Map(catalog.listFromIndex().map((m) => [m.docId, m.title]));
    expect(fromIndex.get('riverbend')).toBe('old title');
  });

  it('reports the .ydoc mtime as activity, or createdAt with no file', () => {
    const catalog = makeCatalog();
    catalog.setIndex('riverbend', row('riverbend'));
    catalog.setIndex('saltmarsh', row('saltmarsh'));
    const path = join(dataDir, 'riverbend.ydoc');
    writeFileSync(path, '');
    utimesSync(path, 5_000, 5_000);

    expect(catalog.activityAt('riverbend')).toBe(5_000_000);
    expect(catalog.activityAt('saltmarsh')).toBe(1_000);
    expect(catalog.activityAt('nowhere')).toBeUndefined();
  });

  it('trusts the row for thread counts unless a save is pending', () => {
    const catalog = makeCatalog();
    const doc = liveDoc('riverbend');
    addThread(doc, 't1');
    addThread(doc, 't2');
    resident.set('riverbend', doc);
    catalog.setIndex('riverbend', row('riverbend', { open: 1, total: 1 }));

    expect(catalog.threadCounts('riverbend')).toEqual({ open: 1, total: 1 });
    pendingSaves.add('riverbend');
    expect(catalog.threadCounts('riverbend')).toEqual({ open: 2, total: 2 });
    expect(catalog.threadCounts('nowhere')).toEqual({ open: 0, total: 0 });
  });

  it('never repoints an alias, and forgets it when the doc goes', () => {
    const catalog = makeCatalog();
    catalog.claimAlias('harbor-notes', 'riverbend');
    catalog.claimAlias('harbor-notes', 'saltmarsh');
    expect(catalog.aliasTarget('harbor-notes')).toBe('riverbend');

    catalog.releaseAliases('riverbend');
    expect(catalog.aliasTarget('harbor-notes')).toBeUndefined();
  });

  it('leaves a name to the resident doc whose primary id it is', () => {
    const catalog = makeCatalog();
    resident.set('harbor-notes', liveDoc('harbor-notes'));
    catalog.claimAlias('harbor-notes', 'riverbend');
    expect(catalog.aliasTarget('harbor-notes')).toBeUndefined();
  });

  it('tells indexChanged about setIndex but not about setQuietly', () => {
    const catalog = makeCatalog();
    const first = row('riverbend');
    catalog.setIndex('riverbend', first);
    catalog.setQuietly('riverbend', row('riverbend', { open: 3, total: 3 }));
    catalog.setIndex('riverbend', undefined);

    expect(changes).toEqual([
      { docId: 'riverbend', next: first },
      { docId: 'riverbend', prev: row('riverbend', { open: 3, total: 3 }) },
    ]);
    expect(catalog.has('riverbend')).toBe(false);
  });

  it('builds a row from the live doc with its counts and the owed write', () => {
    const catalog = makeCatalog();
    const doc = liveDoc('riverbend');
    addThread(doc, 't1');
    owed = true;

    const entry = catalog.indexEntryFor(doc);
    expect(entry.threads).toEqual({ open: 1, total: 1 });
    expect(entry.pendingFileWrite).toBe(true);
    expect(entry.lastThreadActivityAt).toBeNumber();
    // A copy: later edits to the live meta do not rewrite the row.
    doc.meta.title = 'changed';
    expect(entry.meta.title).toBeUndefined();
  });
});
