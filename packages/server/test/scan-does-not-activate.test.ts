/**
 * Enumerating docs is not reaching for one.
 *
 * `docStore.get` marks a doc as accessed, which puts its file binding in the
 * poll's fast lane (a stat every 500ms) for `FILE_POLL_ACTIVE_MS`. That is
 * right for a reader opening a doc and wrong for a route that reads
 * `meta.title` for every docId on a board: one such scan drags the whole
 * corpus into the fast lane, and a client polling that route keeps it there.
 *
 * Measured on a copy of the production data directory: a single `GET /`
 * touched 144 docs and moved `activeBindings` from 0 to 122, and production
 * itself reported all 2,549 bound docs active five minutes after boot with
 * nobody connected. `docStore.peek` is the same lookup without the access.
 *
 * Synthetic fixtures, port 0. No production server is touched.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { User } from '@claude-workspaces/core';
import { DocStore } from '../src/doc-store.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { SseBus } from '../src/sse.ts';
import { createWebhookDispatcher } from '../src/webhooks.ts';
import { waitFor } from './wait-for.ts';
import { seedBoard } from './workspace-seed.ts';

/** The board this file's docs, tasks and reviews are filed under. */
let WS = '';

describe('a scan does not activate the docs it enumerates', () => {
  let dataDir: string;
  let srcDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'scan-data-'));
    srcDir = mkdtempSync(join(tmpdir(), 'scan-src-'));
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(srcDir, { recursive: true, force: true });
  });

  it('peek reads a doc without putting it in the fast lane; get still does', () => {
    const docStore = new DocStore({
      dataDir,
      sse: new SseBus(),
      webhooks: createWebhookDispatcher({ onLog: () => {} }),
    });
    const docIds: string[] = [];
    for (let i = 0; i < 6; i++) {
      const docId = `scan-${i}`;
      const path = join(srcDir, `${docId}.md`);
      writeFileSync(path, `# Doc ${i}\n\nbody\n`);
      docStore.getOrCreate(docId, { type: 'markdown' });
      docStore.attachFile(docId, path);
      docIds.push(docId);
    }
    expect(docStore.stats().bindings).toBe(6);

    // Control FIRST: this fixture can be activated at all, and `get` is what
    // does it. Without this the assertion below would pass on a fixture whose
    // bindings could never go active for some unrelated reason.
    docStore.resetDerivedCaches();
    expect(docStore.stats().activeBindings).toBe(0);
    expect(docStore.get(docIds[0])).toBeDefined();
    expect(docStore.stats().activeBindings).toBe(1);

    docStore.resetDerivedCaches();
    expect(docStore.stats().activeBindings).toBe(0);
    // The scan: every doc's metadata read, nothing activated.
    for (const docId of docIds) expect(docStore.peek(docId)?.meta).toBeDefined();
    expect(docStore.stats().activeBindings).toBe(0);
  });

  it('peek resolves the same ids and aliases as get', () => {
    const docStore = new DocStore({
      dataDir,
      sse: new SseBus(),
      webhooks: createWebhookDispatcher({ onLog: () => {} }),
    });
    // `get` now routes through `peek`, so alias resolution has exactly one
    // implementation — this pins that it is the RIGHT one. A peek that
    // missed an alias would 404 every readable URL ever handed out.
    docStore.getOrCreate('minted-id', { type: 'markdown', alias: 'readable-name' });
    // Positive control: the two strings differ, so the assertions below
    // cannot pass by the alias simply BEING the id.
    expect(docStore.peek('readable-name')?.docId).toBe('minted-id');
    expect(docStore.peek('readable-name')?.docId).toBe(docStore.get('readable-name')?.docId);
    expect(docStore.peek('minted-id')?.docId).toBe('minted-id');
    expect(docStore.peek('no-such-doc')).toBeUndefined();
  });

  describe('over HTTP', () => {
    let handle: ServerHandle;
    let base: string;

    beforeEach(async () => {
      handle = createServer({ port: 0, dataDir });
      base = `http://127.0.0.1:${handle.port}`;
      WS = await seedBoard(base);
    });
    afterEach(async () => {
      await handle.stop();
    });

    const local = (path: string) =>
      fetch(`${base}${path}`, { headers: { host: `localhost:${handle.port}` } });

    const post = (path: string, body: unknown) =>
      fetch(`${base}${path}`, {
        method: 'POST',
        headers: { host: `localhost:${handle.port}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    it('a board-wide listing leaves every bound doc idle', async () => {
      const ws = (await (await post('/workspaces', { name: 'scan-board' })).json()) as {
        workspace: { id: string };
      };
      const docIds: string[] = [];
      for (let i = 0; i < 5; i++) {
        const docId = `scan-http-${i}`;
        const path = join(srcDir, `${docId}.md`);
        writeFileSync(path, `# Doc ${i}\n\nbody\n`);
        expect(
          (await post(`/workspaces/${WS}/docs`, { docId, type: 'markdown', sourceUrl: path }))
            .status,
        ).toBe(200);
        // On the board, which is what makes it part of the listing the
        // review-items builder walks.
        expect((await post(`/workspaces/${ws.workspace.id}/docs:attach`, { docId })).status).toBe(
          200,
        );
        docIds.push(docId);
      }

      // Control: a doc CAN be activated through HTTP alone, and reading one
      // is what does it. Creating a doc deliberately does not — hydration
      // binds the whole corpus at boot and warming it there was the storm
      // this change exists to remove — so the control has to be a read.
      handle.docStore.resetDerivedCaches();
      expect((await local(`/workspaces/${WS}/docs/${docIds[0]}?format=json`)).status).toBe(200);
      const opened = (await (await local('/api/metrics')).json()) as { activeBindings: number };
      expect(opened.activeBindings).toBe(1);

      // Control: the scan below has something to enumerate. A board holding
      // no docs would make the assertion vacuous. (The board stores the ids
      // the server MINTED; `scan-http-N` is the readable alias each doc also
      // answers to, which is exactly why `peek` must resolve aliases too.)
      const holder = handle.tasks.getWorkspace(ws.workspace.id);
      expect(holder?.docIds.length).toBe(docIds.length);
      if (!holder) throw new Error('workspace missing');

      handle.docStore.resetDerivedCaches();
      const idle = (await (await local('/api/metrics')).json()) as { activeBindings: number };
      expect(idle.activeBindings).toBe(0);

      // The two routes that read every docId on a board: the landing page and
      // the review-items builder behind it.
      expect((await local('/')).status).toBe(200);
      expect(
        (await local(`/workspaces/${encodeURIComponent(holder.id)}/review-items`)).status,
      ).toBe(200);

      const after = (await (await local('/api/metrics')).json()) as { activeBindings: number };
      expect(after.activeBindings).toBe(0);
    });
  });
});

/**
 * Reading a doc's THREADS is not reaching for the doc.
 *
 * The case above is about `peek` vs `get` — metadata. This one is about the
 * request an agent auditing comments actually makes, `GET …/docs/:id/threads`,
 * and it has to clear a higher bar than "does not activate": it must arm no
 * file binding at all. Threads live in the `.ydoc`, so the file is not needed
 * to answer, and the read path hydrates with `bind: false` for exactly that
 * reason (`DocStore.getForRead`).
 *
 * Two regression sites, one per test: `DocStore.listThreads`, which resolves
 * read-only, and `routes/docs.ts`, which picks `getForRead` over `get` from
 * the method and the subroute. A change at either turns "auditing comments is
 * cheap" back into "auditing comments wakes every dormant binding on the
 * board, which then flushes weeks-old content over files on disk".
 *
 * Synthetic fixtures, port 0. No production server is touched.
 */
describe('reading a doc thread does not wake its file binding', () => {
  const AUDITOR: User = {
    id: 'agent-harborlight-audit',
    name: 'Harborlight Audit',
    kind: 'known',
    color: '#4488aa',
  };

  let dataDir: string;
  let srcDir: string;
  const stores: DocStore[] = [];

  const makeStore = (): DocStore => {
    const store = new DocStore({
      dataDir,
      sse: new SseBus(),
      webhooks: createWebhookDispatcher({ onLog: () => {} }),
    });
    stores.push(store);
    return store;
  };

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'thread-read-data-'));
    srcDir = mkdtempSync(join(tmpdir(), 'thread-read-src-'));
  });
  afterEach(() => {
    for (const store of stores.splice(0)) store.stop();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(srcDir, { recursive: true, force: true });
  });

  /** A file-bound doc carrying one thread, in a store that is about to die. */
  const seedBoundDocWithThread = async (
    store: DocStore,
    docId: string,
    file: string,
    line: string,
    find: string,
    comment: string,
  ): Promise<string> => {
    const path = join(srcDir, file);
    writeFileSync(path, `# ${docId}\n\n${line}\n`);
    store.getOrCreate(docId, { type: 'markdown', sourceUrl: path });
    expect((await store.attachFileAsync(docId, path)).ok).toBe(true);
    const made = await store.createThreadByFind(docId, { find }, AUDITOR, comment);
    expect(made.ok).toBe(true);
    await waitFor(() => existsSync(join(dataDir, `${docId}.ydoc`)) || undefined, {
      describe: `the .ydoc snapshot the next process hydrates ${docId} from`,
    });
    return path;
  };

  it('answers from the .ydoc of a dormant doc, arming no binding and no fast lane', async () => {
    const first = makeStore();
    // Two docs in the same state, so the assertion below has a control that
    // is a peer in TIME as well as in kind. A hydrate that needs bytes it
    // does not hold defers its bind to a read pool, so "no binding a
    // microsecond later" is a claim about scheduling, not about binding: the
    // control doc's bind landing is what proves the pool ran at all and got
    // past the moment the read under test sat at.
    await seedBoundDocWithThread(
      first,
      'harborlight-plan',
      'harborlight-plan.md',
      'The ferry service runs hourly.',
      'runs hourly',
      'Is the winter timetable the same?',
    );
    const controlPath = await seedBoundDocWithThread(
      first,
      'harborlight-ledger',
      'harborlight-ledger.md',
      'The lock keeper opens at dawn.',
      'opens at dawn',
      'Does that hold in winter?',
    );

    // A restart: both docs are on disk with a sourceUrl, nothing is resident,
    // and both bindings are dormant — the state every doc on a board is in
    // when an agent starts walking it.
    first.simulateCrash();
    const second = makeStore();
    expect(second.stats().bindings).toBe(0);

    // The read under test.
    const threads = second.listThreads('harborlight-plan');
    // Non-vacuous: the `.ydoc` alone really did answer. Without this the
    // assertions below would pass just as well on a read that found nothing.
    expect(threads.map((t) => t.comments[0]?.text)).toEqual(['Is the winter timetable the same?']);

    // The control, queued after it: a CONTENT read of the other doc, which is
    // supposed to bind. Waiting for it to land is what makes the zero below
    // mean "never bound" rather than "not bound yet".
    expect(second.get('harborlight-ledger')).toBeDefined();
    await waitFor(() => second.boundPathOf('harborlight-ledger') === controlPath || undefined, {
      describe: 'the content read to bind the doc it was dormant against',
    });
    expect(second.stats().bindings).toBe(1);
    expect(second.stats().activeBindings).toBe(1);

    // And the doc whose threads were read is the one still unbound.
    expect(second.boundPathOf('harborlight-plan')).toBeUndefined();
  });

  describe('over HTTP', () => {
    let handle: ServerHandle;
    let base: string;
    let ws = '';

    beforeEach(async () => {
      handle = createServer({ port: 0, dataDir });
      base = `http://127.0.0.1:${handle.port}`;
      ws = await seedBoard(base);
    });
    afterEach(async () => {
      await handle.stop();
    });

    const local = (path: string) =>
      fetch(`${base}${path}`, { headers: { host: `localhost:${handle.port}` } });

    const post = (path: string, body: unknown) =>
      fetch(`${base}${path}`, {
        method: 'POST',
        headers: { host: `localhost:${handle.port}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    it('leaves a bound doc idle when an agent lists its threads', async () => {
      const docId = 'riverbend-notes';
      const path = join(srcDir, 'riverbend-notes.md');
      writeFileSync(path, '# Riverbend notes\n\nThe lock keeper opens at dawn.\n');
      expect(
        (await post(`/workspaces/${ws}/docs`, { docId, type: 'markdown', sourceUrl: path })).status,
      ).toBe(200);
      expect(
        (
          await post(`/workspaces/${ws}/docs/${docId}/threads/by_find`, {
            author: AUDITOR,
            text: 'Does that hold in winter?',
            find: 'opens at dawn',
          })
        ).status,
      ).toBe(200);

      const metrics = async () =>
        (await (await local('/api/metrics')).json()) as { activeBindings: number };

      // Control: reading this doc's CONTENT over the same HTTP surface does
      // activate it. The threads assertion below is only worth something
      // because this one is on the same doc, through the same server.
      handle.docStore.resetDerivedCaches();
      expect((await local(`/workspaces/${ws}/docs/${docId}?format=json`)).status).toBe(200);
      expect((await metrics()).activeBindings).toBe(1);

      handle.docStore.resetDerivedCaches();
      expect((await metrics()).activeBindings).toBe(0);

      // The request `list_threads` makes.
      const res = await local(`/workspaces/${ws}/docs/${docId}/threads`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        threads: Array<{ id: string; comments: Array<{ text: string }> }>;
      };
      // Non-vacuous: the route answered with the thread, not with an empty list.
      expect(body.threads.map((t) => t.comments[0]?.text)).toEqual(['Does that hold in winter?']);
      expect((await metrics()).activeBindings).toBe(0);

      // `get_thread` takes the same read-only path, and is the other half of
      // an audit: the list, then the thread it is worth opening.
      const threadId = body.threads[0]?.id ?? '';
      expect(threadId).not.toBe('');
      handle.docStore.resetDerivedCaches();
      expect((await local(`/workspaces/${ws}/docs/${docId}/threads/${threadId}`)).status).toBe(200);
      expect((await metrics()).activeBindings).toBe(0);
    });
  });
});
