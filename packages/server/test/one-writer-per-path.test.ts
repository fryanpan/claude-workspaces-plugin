/**
 * One writer per path.
 *
 * Two doc-sets can end up bound to the same file — a refreshed diff review
 * over a repo an older review still covers — and the older set keeps a live
 * binding long after its set stops answering the API. Waking it (a threads
 * read was enough) flushed a weeks-old `.ydoc` over the file the newer set
 * was showing: the 2026-09-16 incident, in which three tracked files in
 * another repo were rewritten from content committed three weeks earlier.
 *
 * The rule under test: the NEWEST WRITER bound to a path owns the
 * write-back, every other writer on it is suspended (serving from its
 * `.ydoc`, still reading disk→doc, writing nothing), read-only bindings are
 * not owners at all, and the path is settled again whenever a binding leaves
 * it, so a doc is never left as the only writer with write-back off.
 *
 * Split out of `hydrate-clobber.test.ts`, which the two files together cover;
 * the fixtures are fictional and live under temp dirs.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readDocIndex } from '../src/doc-index.ts';
import { DocStore } from '../src/doc-store.ts';
import { SseBus } from '../src/sse.ts';
import { createWebhookDispatcher } from '../src/webhooks.ts';
import { pastWriteBack, waitFor } from './wait-for.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const DOC = `# Harborlight ferry

The first crossing leaves at dawn.
`;

describe('two doc-sets over one path', () => {
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
    root = mkdtempSync(join(tmpdir(), 'cw-two-sets-'));
    dataDir = mkdtempSync(join(tmpdir(), 'cw-two-sets-data-'));
  });

  afterEach(() => {
    // `simulateCrash` rather than `stop`: a stopped store still holds its
    // debounced `.ydoc` persist, which fires into a data dir this teardown
    // has already removed and prints a failure nobody caused.
    for (const store of stores.splice(0)) store.simulateCrash();
    rmSync(root, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('gives the write-back to the newer set and suspends the superseded one', async () => {
    const path = join(root, 'shared.md');
    writeFileSync(path, DOC);
    const store = makeStore();

    // The superseded set's doc, created a fortnight ago.
    const older = store.getOrCreate('set-august', { type: 'markdown', sourceUrl: path });
    older.meta.createdAt = Date.now() - 14 * 24 * 60 * 60 * 1000;
    expect((await store.attachFileAsync('set-august', path)).ok).toBe(true);

    // The set that supersedes it binds the same file.
    const newer = store.getOrCreate('set-today', { type: 'markdown', sourceUrl: path });
    newer.meta.createdAt = Date.now();
    expect((await store.attachFileAsync('set-today', path)).ok).toBe(true);

    // The older set edits: nothing reaches the file, and the doc says so.
    expect(
      store.findAndReplace('set-august', { find: 'leaves at dawn', replace: 'was cancelled' }).ok,
    ).toBe(true);
    // timed: the suspended set's write-back would have landed inside this window.
    await sleep(pastWriteBack());
    expect(readFileSync(path, 'utf8')).toBe(DOC);
    expect(store.getSyncError('set-august')?.message ?? '').toContain('newer doc');

    // The newer set edits: the file follows it. Same fixture, so this is the
    // control that the write path is live at all.
    expect(
      store.findAndReplace('set-today', { find: 'leaves at dawn', replace: 'leaves at noon' }).ok,
    ).toBe(true);
    await waitFor(() => readFileSync(path, 'utf8').includes('leaves at noon') || undefined, {
      describe: "the newer set's write-back to reach the file",
    });
    expect(readFileSync(path, 'utf8')).not.toContain('was cancelled');

    // And the suspended set is not left owing a write that a later boot would
    // carry out with nobody around to suspend it again.
    expect(store.pendingFileWrites().map((p) => p.docId)).not.toContain('set-august');
  });

  it('retires the superseded set’s owed write, so a later boot does not carry it out', async () => {
    // Codex's case: the older set already had a flush ARMED when the newer
    // set took the path. Cancelling only the timer leaves `pendingFileWrite`
    // on the index row, and the next boot opens that doc alone — with no
    // newer binding resident to suspend it — and writes its stale content.
    const path = join(root, 'owed.md');
    writeFileSync(path, DOC);
    const store = makeStore();

    const older = store.getOrCreate('owed-august', { type: 'markdown', sourceUrl: path });
    older.meta.createdAt = Date.now() - 14 * 24 * 60 * 60 * 1000;
    expect((await store.attachFileAsync('owed-august', path)).ok).toBe(true);
    // Arm its write-back, and make sure it really is armed before the newer
    // set arrives — the state under test is "a flush was already owed".
    expect(
      store.findAndReplace('owed-august', { find: 'leaves at dawn', replace: 'was cancelled' }).ok,
    ).toBe(true);
    expect(store.pendingFileWrites().map((p) => p.docId)).toContain('owed-august');
    // And on the row a later boot reads, which is the copy that outlives the
    // process. Written by the `.ydoc` persist, which runs ahead of the flush.
    await waitFor(() => readDocIndex(dataDir, 'owed-august')?.pendingFileWrite === true, {
      describe: "the index row to record the older set's owed write",
    });

    const newer = store.getOrCreate('owed-today', { type: 'markdown', sourceUrl: path });
    newer.meta.createdAt = Date.now();
    expect((await store.attachFileAsync('owed-today', path)).ok).toBe(true);

    // The owed write is not merely deferred — it is retired, on the row the
    // next boot reads as well as in this process.
    expect(store.pendingFileWrites().map((p) => p.docId)).not.toContain('owed-august');
    expect(readDocIndex(dataDir, 'owed-august')?.pendingFileWrite).toBeUndefined();
    // timed: the cancelled flush would have landed inside this window.
    await sleep(pastWriteBack());
    expect(readFileSync(path, 'utf8')).not.toContain('was cancelled');
  });

  it('flushes what the suspended set wrote while it was out, once it is back', async () => {
    // Codex's case: while suspended, every edit returns from the scheduler
    // having armed nothing. Simply clearing the flag on resume leaves those
    // edits in the doc and never on disk — they land only if somebody
    // happens to edit again, which is a silently lost save.
    const path = join(root, 'accumulated.md');
    writeFileSync(path, DOC);
    const store = makeStore();

    const older = store.getOrCreate('acc-older', { type: 'markdown', sourceUrl: path });
    older.meta.createdAt = Date.now() - 14 * 24 * 60 * 60 * 1000;
    expect((await store.attachFileAsync('acc-older', path)).ok).toBe(true);
    const newer = store.getOrCreate('acc-newer', { type: 'markdown', sourceUrl: path });
    newer.meta.createdAt = Date.now();
    expect((await store.attachFileAsync('acc-newer', path)).ok).toBe(true);

    // The edit is made WHILE suspended, and stays off the file.
    expect(
      store.findAndReplace('acc-older', { find: 'leaves at dawn', replace: 'leaves at dusk' }).ok,
    ).toBe(true);
    // timed: the suspended set's write-back would have landed inside this window.
    await sleep(pastWriteBack());
    expect(readFileSync(path, 'utf8')).toBe(DOC);

    // The newer set goes; nothing else edits anything. The edit made during
    // the suspension is what has to reach the file.
    expect(store.evictDoc('acc-newer')).toBe(true);
    await waitFor(() => readFileSync(path, 'utf8').includes('leaves at dusk') || undefined, {
      describe: 'the edit made during suspension to reach the file on resume',
    });
  });

  it('hands the write-back back when the newer set rebinds to another file', async () => {
    // A set does not have to be evicted to let a path go: repointing its
    // binding leaves the path behind just as completely, and the doc still
    // bound there is then the only writer left.
    const path = join(root, 'released.md');
    const elsewhere = join(root, 'elsewhere.md');
    writeFileSync(path, DOC);
    writeFileSync(elsewhere, DOC);
    const store = makeStore();

    const older = store.getOrCreate('rel-older', { type: 'markdown', sourceUrl: path });
    older.meta.createdAt = Date.now() - 14 * 24 * 60 * 60 * 1000;
    expect((await store.attachFileAsync('rel-older', path)).ok).toBe(true);
    const newer = store.getOrCreate('rel-newer', { type: 'markdown', sourceUrl: path });
    newer.meta.createdAt = Date.now();
    expect((await store.attachFileAsync('rel-newer', path)).ok).toBe(true);
    expect(store.getSyncError('rel-older')?.message ?? '').toContain('newer doc');

    // The newer set repoints at a different file. Nothing was evicted.
    expect((await store.attachFileAsync('rel-newer', elsewhere)).ok).toBe(true);
    expect(store.boundPathOf('rel-newer')).toBe(elsewhere);

    expect(
      store.findAndReplace('rel-older', { find: 'leaves at dawn', replace: 'leaves at ten' }).ok,
    ).toBe(true);
    await waitFor(() => readFileSync(path, 'utf8').includes('leaves at ten') || undefined, {
      describe: 'the resumed write-back to reach the file the newer set released',
    });
  });

  it('picks the newest WRITER when a path is settled again, not a read-only watcher', async () => {
    // The re-arbitration half of the rule above: a newer read-only binding
    // must not be chosen as the path's owner when the writer that held it
    // goes, or the one doc left that can write is suspended forever.
    const path = join(root, 'settled.ts');
    writeFileSync(path, 'export const dawn = 6;\n');
    const store = makeStore();

    const olderWriter = store.getOrCreate('settle-writer', { type: 'code', sourceUrl: path });
    olderWriter.meta.createdAt = Date.now() - 14 * 24 * 60 * 60 * 1000;
    expect(store.attachFlatFile('settle-writer', path, { writeBack: true }).ok).toBe(true);
    const newerWriter = store.getOrCreate('settle-newer', { type: 'code', sourceUrl: path });
    newerWriter.meta.createdAt = Date.now() - 60 * 1000;
    expect(store.attachFlatFile('settle-newer', path, { writeBack: true }).ok).toBe(true);
    // The newest binding of all, and read-only.
    const reader = store.getOrCreate('settle-reader', { type: 'code', sourceUrl: path });
    reader.meta.createdAt = Date.now();
    expect(store.attachFlatFile('settle-reader', path).ok).toBe(true);

    // The writer that owned the path goes; the older writer must get it.
    expect(store.evictDoc('settle-newer')).toBe(true);
    store.get('settle-writer')?.ydoc.getText('content').insert(0, '// first light\n');
    await waitFor(() => readFileSync(path, 'utf8').includes('// first light') || undefined, {
      describe: 'the remaining writer to reach the file',
    });
  });

  it('a read-only binding on the path never takes the write-back from a writer', async () => {
    // Codex's case: a code member, a pinned diff and a mockup watcher are
    // disk→doc only. Counting a newer one as the path's owner would suspend
    // the only binding that writes, decided by nothing but hydrate order.
    const path = join(root, 'member.ts');
    writeFileSync(path, 'export const dawn = 6;\n');
    const store = makeStore();

    // The NEWER binding is read-only — a second review's pinned copy of the
    // same member — and it hydrates FIRST, which is the order that decides it.
    const reader = store.getOrCreate('member-reader', { type: 'code', sourceUrl: path });
    reader.meta.createdAt = Date.now();
    expect(store.attachFlatFile('member-reader', path).ok).toBe(true);

    const writer = store.getOrCreate('member-writer', { type: 'code', sourceUrl: path });
    writer.meta.createdAt = Date.now() - 60 * 60 * 1000;
    expect(store.attachFlatFile('member-writer', path, { writeBack: true }).ok).toBe(true);

    expect(store.getSyncError('member-writer')?.message ?? '').not.toContain('newer doc');
    const content = store.get('member-writer')?.ydoc.getText('content');
    content?.insert(0, '// first light\n');
    await waitFor(() => readFileSync(path, 'utf8').includes('// first light') || undefined, {
      describe: "the writer's edit to reach the file",
    });
  });

  it('hands the write-back back when the newer set lets the file go', async () => {
    const path = join(root, 'handover.md');
    writeFileSync(path, DOC);
    const store = makeStore();

    const older = store.getOrCreate('set-older', { type: 'markdown', sourceUrl: path });
    older.meta.createdAt = Date.now() - 14 * 24 * 60 * 60 * 1000;
    expect((await store.attachFileAsync('set-older', path)).ok).toBe(true);
    const newer = store.getOrCreate('set-newer', { type: 'markdown', sourceUrl: path });
    newer.meta.createdAt = Date.now();
    expect((await store.attachFileAsync('set-newer', path)).ok).toBe(true);

    // The newer set goes out of memory. The older one is now the only doc
    // bound to this file, so suspending it forever would mean a doc that
    // takes edits and writes none of them.
    expect(store.evictDoc('set-newer')).toBe(true);
    expect(
      store.findAndReplace('set-older', { find: 'leaves at dawn', replace: 'leaves at midnight' })
        .ok,
    ).toBe(true);
    await waitFor(() => readFileSync(path, 'utf8').includes('leaves at midnight') || undefined, {
      describe: 'the resumed write-back to reach the file',
    });
  });
});
