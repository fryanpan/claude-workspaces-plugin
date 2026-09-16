/**
 * Waking a dormant doc must not cost the file on disk.
 *
 * The 2026-09-16 incident: ~7,000 read-only threads GETs across every board
 * hydrated every dormant doc binding on the server (residentDocs 2,246→7,114,
 * bindings 586→3,134, 281MB RSS, ~95s not answering) — and the bindings they
 * woke flushed their cached `.ydoc` content to the files they were still
 * bound to. Three tracked files in another repo were rewritten from a doc-set
 * three weeks old, which had 404'd from the API for weeks and still held a
 * live binding.
 *
 * Three independent failures, one per describe below:
 *   1. a `liveWins` claim read off an index row outranked a file that was
 *      demonstrably newer than the `.ydoc` the claim described;
 *   2. reading a doc's THREADS armed a full write-back binding, so a fan-out
 *      over a board woke every binding on it;
 *   3. a superseded doc-set kept writing to a path a newer set also binds.
 *
 * All fixtures synthetic, under temp dirs. No production data is touched.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DocStore } from '../src/doc-store.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { SseBus } from '../src/sse.ts';
import { createWebhookDispatcher } from '../src/webhooks.ts';
import { pastWriteBack, waitFor } from './wait-for.ts';
import { seedBoard } from './workspace-seed.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const DOC = `# Harborlight ferry

The first crossing leaves at dawn.
`;

/** What a person edits the file to while the doc-set is dormant. */
const ON_DISK_NOW = `# Harborlight ferry

The first crossing leaves at dawn.

Winter timetable: the first crossing leaves at nine.
`;

describe('hydrating a dormant binding', () => {
  const stores: DocStore[] = [];
  let root = '';
  let dataDir = '';

  function makeStore(): DocStore {
    const store = new DocStore({
      dataDir,
      sse: new SseBus(),
      webhooks: createWebhookDispatcher({ onLog: () => {} }),
      decorateDocMeta: (m) => ({ ...m, reviewUrl: `http://test/review/${m.docId}` }),
    });
    stores.push(store);
    return store;
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cw-hydrate-clobber-'));
    dataDir = mkdtempSync(join(tmpdir(), 'cw-hydrate-clobber-data-'));
  });

  afterEach(() => {
    for (const store of stores.splice(0)) store.stop();
    rmSync(root, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  });

  /** Every file the clobber backups hold, as text. */
  function backups(): string[] {
    const dir = join(dataDir, 'clobber-backups');
    if (!existsSync(dir)) return [];
    return readdirSync(dir).map((f) => readFileSync(join(dir, f), 'utf8'));
  }

  it('refuses a weeks-old write-back claim when the file on disk is newer', async () => {
    const docId = 'ferry-notes';
    const path = join(root, 'ferry-notes.md');
    writeFileSync(path, DOC);

    // A doc that was edited and then died INSIDE its write-back window: the
    // `.ydoc` holds the edit, the `.md` never got it, and the index row says
    // a write is still owed. That row is the `liveWins` claim, and it lasts
    // as long as the `.ydoc` does.
    const first = makeStore();
    first.getOrCreate(docId, { type: 'markdown', sourceUrl: path });
    expect((await first.attachFileAsync(docId, path)).ok).toBe(true);
    const ydoc = join(dataDir, `${docId}.ydoc`);
    await waitFor(() => existsSync(ydoc) || undefined, { describe: 'the first .ydoc snapshot' });
    const persistedAt = statSync(ydoc).mtimeMs;
    expect(
      first.findAndReplace(docId, { find: 'leaves at dawn', replace: 'leaves at first light' }).ok,
    ).toBe(true);
    await waitFor(() => statSync(ydoc).mtimeMs > persistedAt || undefined, {
      describe: 'the edit to reach the .ydoc',
    });
    first.simulateCrash();
    // The edit never reached the file: that is what the row is owed for.
    expect(readFileSync(path, 'utf8')).toBe(DOC);

    // Weeks pass. A person edits the file; nothing edits the doc.
    writeFileSync(path, ON_DISK_NOW);
    // Stamped rather than raced: on a fast machine the whole fixture runs
    // inside one millisecond, and "newer" is the thing under test.
    const weekLater = new Date(statSync(ydoc).mtimeMs + 7 * 24 * 60 * 60 * 1000);
    utimesSync(path, weekLater, weekLater);
    expect(statSync(path).mtimeMs).toBeGreaterThan(statSync(ydoc).mtimeMs);

    // Somebody opens the doc again.
    const second = makeStore();
    expect(second.get(docId)).toBeDefined();
    await waitFor(() => second.boundPathOf(docId) === path || undefined, {
      describe: 'the hydrate to bind the file',
    });
    // timed: a reasserted write-back would have landed inside this window.
    await sleep(pastWriteBack());

    // The file a person edited is still theirs, byte for byte.
    expect(readFileSync(path, 'utf8')).toBe(ON_DISK_NOW);
    // The doc reads the newer side too, and the version it had been holding
    // is recoverable rather than gone.
    expect(second.getDoc(docId)?.plainText ?? '').toContain('Winter timetable');
    expect(backups().some((b) => b.includes('leaves at first light'))).toBe(true);
    // And it says why, rather than reporting a write that never happened.
    expect(second.getSyncError(docId)?.message ?? '').toContain('newer');
  });

  it('refuses a claim left outstanding for a month, even when the file moved a minute later', async () => {
    // The other order, and the one a gap-only rule misses: the person edited
    // the file a minute after the doc's last save, and then nobody opened the
    // doc for a month. The two writes are a minute apart forever; what is
    // stale is the CLAIM.
    const docId = 'ferry-month';
    const path = join(root, 'ferry-month.md');
    writeFileSync(path, DOC);
    const first = makeStore();
    first.getOrCreate(docId, { type: 'markdown', sourceUrl: path });
    expect((await first.attachFileAsync(docId, path)).ok).toBe(true);
    const ydoc = join(dataDir, `${docId}.ydoc`);
    await waitFor(() => existsSync(ydoc) || undefined, { describe: 'the first .ydoc snapshot' });
    const persistedAt = statSync(ydoc).mtimeMs;
    expect(
      first.findAndReplace(docId, { find: 'leaves at dawn', replace: 'leaves at first light' }).ok,
    ).toBe(true);
    await waitFor(() => statSync(ydoc).mtimeMs > persistedAt || undefined, {
      describe: 'the edit to reach the .ydoc',
    });
    first.simulateCrash();

    writeFileSync(path, ON_DISK_NOW);
    // A month ago: the save, then the person's edit a minute after it.
    const monthAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const saved = new Date(monthAgo);
    const edited = new Date(monthAgo + 60 * 1000);
    utimesSync(ydoc, saved, saved);
    utimesSync(path, edited, edited);

    const second = makeStore();
    expect(second.get(docId)).toBeDefined();
    await waitFor(() => second.boundPathOf(docId) === path || undefined, {
      describe: 'the hydrate to bind the file',
    });
    // timed: a reasserted write-back would have landed inside this window.
    await sleep(pastWriteBack());
    expect(readFileSync(path, 'utf8')).toBe(ON_DISK_NOW);
  });

  it('still reasserts a crashed write when the file is the older side', async () => {
    // The control for the case above: same shape, except nobody touched the
    // file. The write-back is genuinely owed and must still land — this is
    // the behaviour the refusal above must not have broken.
    const docId = 'ferry-control';
    const path = join(root, 'ferry-control.md');
    writeFileSync(path, DOC);
    const first = makeStore();
    first.getOrCreate(docId, { type: 'markdown', sourceUrl: path });
    expect((await first.attachFileAsync(docId, path)).ok).toBe(true);
    const ydoc = join(dataDir, `${docId}.ydoc`);
    await waitFor(() => existsSync(ydoc) || undefined, { describe: 'the first .ydoc snapshot' });
    const persistedAt = statSync(ydoc).mtimeMs;
    expect(
      first.findAndReplace(docId, { find: 'leaves at dawn', replace: 'leaves at first light' }).ok,
    ).toBe(true);
    await waitFor(() => statSync(ydoc).mtimeMs > persistedAt || undefined, {
      describe: 'the edit to reach the .ydoc',
    });
    first.simulateCrash();
    expect(readFileSync(path, 'utf8')).toBe(DOC);

    const second = makeStore();
    expect(second.get(docId)).toBeDefined();
    await waitFor(() => readFileSync(path, 'utf8').includes('leaves at first light') || undefined, {
      describe: 'the owed write-back to reach the file',
    });
  });
});

describe('GET a dormant doc’s threads', () => {
  let handle: ServerHandle;
  let dataDir = '';
  let root = '';
  let base = '';
  let WS = '';
  let docId = '';
  let path = '';

  const get = (p: string, accept = '*/*') =>
    fetch(`${base}${p}`, { headers: { host: `localhost:${handle.port}`, accept } });
  const post = (p: string, body: unknown) =>
    fetch(`${base}${p}`, {
      method: 'POST',
      headers: { host: `localhost:${handle.port}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'cw-threads-read-data-'));
    root = mkdtempSync(join(tmpdir(), 'cw-threads-read-'));
    path = join(root, 'ferry.md');
    writeFileSync(path, DOC);
    handle = createServer({ port: 0, dataDir });
    base = `http://127.0.0.1:${handle.port}`;
    WS = await seedBoard(base);
    const made = await post(`/workspaces/${WS}/docs`, {
      docId: 'ferry',
      sourceUrl: path,
      title: 'Ferry',
    });
    docId = ((await made.json()) as { docId: string }).docId;
    await post(`/workspaces/${WS}/docs/${docId}/threads`, {
      author: { id: 'known-reviewer', name: 'Reviewer', kind: 'known', color: '#2e7dd7' },
      text: 'Is the dawn crossing still running?',
      anchor: { kind: 'subject' },
    });
    await waitFor(() => handle.docStore.boundPathOf(docId) === path || undefined, {
      describe: 'the doc to bind its file',
    });
    await handle.stop();

    // The state the fan-out finds: the doc is on disk and nothing is
    // resident. The file is the OLDER side and differs from the doc, which
    // is exactly the shape that makes a waking binding reassert.
    writeFileSync(path, `${DOC}\nA line the doc has never held.\n`);
    const old = new Date(Date.now() - 60 * 60 * 1000);
    utimesSync(path, old, old);
    handle = createServer({ port: 0, dataDir });
    base = `http://127.0.0.1:${handle.port}`;
  });

  afterEach(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  it('reads the threads without binding the file or writing to it', async () => {
    const before = readFileSync(path, 'utf8');
    const res = await get(`/workspaces/${WS}/docs/${docId}/threads`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { threads: { comments: { text: string }[] }[] };
    expect(body.threads).toHaveLength(1);
    expect(body.threads[0]?.comments[0]?.text).toContain('dawn crossing');

    // No binding was armed, so nothing is owed to the file and the sweep has
    // nothing to visit for this doc.
    expect(handle.docStore.boundPathOf(docId)).toBeUndefined();
    // timed: a write-back armed by the read would have landed inside this window.
    await sleep(pastWriteBack());
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it('binds when the same route is asked to WRITE — the same fixture, the control', async () => {
    // The positive control for the case above: the binding machinery is live
    // in this fixture, and the very same URL binds when the method is one
    // that can change the doc. So the case above measures the read, not a
    // fixture that could never have bound anything.
    const res = await post(`/workspaces/${WS}/docs/${docId}/threads`, {
      author: { id: 'known-reviewer', name: 'Reviewer', kind: 'known', color: '#2e7dd7' },
      text: 'Adding one after the restart.',
      anchor: { kind: 'subject' },
    });
    expect(res.status).toBe(200);
    await waitFor(() => handle.docStore.boundPathOf(docId) === path || undefined, {
      describe: 'the write to bind the file',
    });
  });
});
