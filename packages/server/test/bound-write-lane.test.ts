/**
 * The write half of the bound-file gate: what a doc→disk write-back may cost
 * the process, and what it may claim afterwards.
 *
 * The read half has `slow-fs.test.ts` and `hydrate-wedge.test.ts`. This file
 * covers the two ways the write side can go wrong once the write itself runs
 * on the thread pool: a shutdown that cannot see it, and a failure that
 * punishes the wrong operation.
 *
 * The pool write is held open by replacing `boundFiles.write` with one that
 * waits on a promise this file resolves. That is deliberate — the alternative
 * is a real unresponsive path, and the write side of that is what hung a
 * runner once already. Every test restores the method in a `finally`.
 *
 * Paths and contents are invented.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DOC_STORE_TIMINGS } from '../src/doc-store-timings.ts';
import { DocStore } from '../src/doc-store.ts';
import { type BoundStatResult, boundFiles } from '../src/slow-fs.ts';
import { SseBus } from '../src/sse.ts';
import { createWebhookDispatcher } from '../src/webhooks.ts';
import { armFifoValve, makeFifo, releaseFifosIn } from './fifo.ts';
import { waitFor } from './wait-for.ts';

type PoolWrite = (path: string, text: string) => Promise<BoundStatResult>;

/**
 * `boundFiles` with its write seen as replaceable, so a test can hold one
 * open. Restoring assigns the original back rather than deleting the
 * property: an own `write` of `undefined` would shadow the class method and
 * break every later caller in the suite, which shares this one object.
 */
const patchable = boundFiles as unknown as { write?: PoolWrite };

/** Well past the read deadline — see `armFifoValve`. */
const VALVE_MS = DOC_STORE_TIMINGS.boundReadDeadlineMs * 6;

describe('the bound-file write lane', () => {
  let dataDir: string;
  let path: string;
  let docStore: DocStore;
  const original: PoolWrite = boundFiles.write.bind(boundFiles);
  const disarm: Array<() => void> = [];

  beforeEach(() => {
    boundFiles.reset();
    dataDir = mkdtempSync(join(tmpdir(), 'cw-write-lane-'));
    path = join(dataDir, 'Notes.md');
    writeFileSync(path, 'first line\n');
    docStore = new DocStore({
      dataDir,
      sse: new SseBus(),
      webhooks: createWebhookDispatcher({ onLog: () => {} }),
      decorateDocMeta: (m) => ({ ...m, reviewUrl: `http://test/review/${m.docId}` }),
    });
    docStore.getOrCreate('n1', { type: 'code', sourceUrl: path });
    expect(docStore.attachFlatFile('n1', path, { writeBack: true }).ok).toBe(true);
  });

  afterEach(async () => {
    // Belt and braces: a leaked patch would break every later test file, since
    // the whole server suite shares one process and one `boundFiles`.
    patchable.write = original;
    for (const off of disarm.splice(0)) off();
    docStore.stop();
    // A write stuck on a planted pipe owns a pool thread until it is let go.
    await releaseFifosIn(dataDir);
    boundFiles.reset();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('counts a write still on the pool as pending, and flushes it on the way down', async () => {
    // The bug: a write-back that has STARTED has no timer any more — the
    // timer is what started it — so every question about pending writes
    // answered no while the bytes were still in the air. `flush()` skipped
    // the doc, and SIGTERM took the edit with it.
    let started = 0;
    let open!: () => void;
    const held = new Promise<void>((resolve) => {
      open = resolve;
    });
    patchable.write = async (p, text) => {
      started++;
      await held;
      return original(p, text);
    };

    try {
      docStore.get('n1')?.ydoc.getText('content').insert(0, 'an unsaved sentence\n');
      // Before the debounce fires this is pending because a timer is armed —
      // the positive control for the assertion below, which must hold for a
      // different reason.
      expect(docStore.pendingFileWrites()).toHaveLength(1);

      await waitFor(() => started === 1, { describe: 'the write-back to reach the pool' });
      // No timer now, and nothing on disk yet. This is the state that used to
      // read as "nothing to do".
      expect(readFileSync(path, 'utf8')).toBe('first line\n');
      expect(docStore.pendingFileWrites().map((w) => w.docId)).toEqual(['n1']);

      // `flush()` cannot await the pool, so it writes synchronously. What it
      // must not do is skip.
      docStore.flush();
      expect(readFileSync(path, 'utf8')).toContain('an unsaved sentence');
    } finally {
      open();
      patchable.write = original;
    }
  });

  it('flushes through a temp file of its own while a pool write is stuck inside its own', async () => {
    // A REGRESSION test for the two lanes' temp names. Both writers can be
    // live at once — SIGTERM while a write-back sits on the pool is the case
    // the sync flush exists for — and when they shared one temp path, the
    // flush wrote into the file the pool writer was still filling, and the
    // rename published whatever the two had made of it.
    //
    // Holding a writer INSIDE its write is what that needs, and a pipe does
    // it with no seam in production code: plant one where the pool writer's
    // temp file goes, and its `writeFile` blocks in `open` — mid-write, temp
    // path claimed, rename not yet run. A flush sharing that path would open
    // the same pipe and publish it over the document (the valve ends that
    // open a moment late, so a regression fails here rather than hanging).
    const poolTemp = `${path}.cw-pool-write~`;
    makeFifo(poolTemp);
    disarm.push(armFifoValve(poolTemp, VALVE_MS, 'read'));
    let started = 0;
    let settled = false;
    patchable.write = (p, text) => {
      started++;
      const landing = original(p, text);
      void landing.finally(() => {
        settled = true;
      });
      return landing;
    };

    const doc = docStore.get('n1')?.ydoc.getText('content');
    doc?.insert(0, 'version one\n');
    await waitFor(() => started === 1, { describe: 'the first write to reach the pool' });
    // A second edit while the first is stuck, and the flush that carries it
    // out. It has to run inside the read deadline: past it the stuck write
    // quarantines the path, and the flush rightly skips a quarantined file.
    doc?.insert(0, 'version two\n');
    docStore.flush();

    // The document is a FILE holding the flushed version — asked of `stat`
    // first, because reading a pipe that took its place would block.
    expect(statSync(path).isFile()).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe('version two\nversion one\nfirst line\n');
    // The flush's own temp file was renamed away, and the pool write is still
    // stuck in the other one: the two lanes really were live together.
    expect(readdirSync(dataDir).filter((f) => f.endsWith('.cw-flush~'))).toEqual([]);
    expect(settled).toBe(false);
  });

  it('does not quarantine a readable path because a write to it failed', async () => {
    // A write fails for reasons that say nothing about reading: no
    // permission, a read-only volume, no space, a parent directory renamed
    // away. Parking every READ of the file for the backoff would turn a
    // failed save into a doc that cannot even be opened.
    const orphan = join(dataDir, 'gone', 'Child.md');
    const failed = await boundFiles.write(orphan, 'never lands\n');
    expect(failed).toEqual({ status: 'unavailable', reason: 'error' });
    expect(boundFiles.quarantined(orphan)).toBe(false);

    // Positive control, on the same reader in the same test: a READ that
    // fails for a reason other than "not there" still does earn the backoff.
    // Without this the assertion above would also pass on a reader whose
    // quarantine had stopped working altogether.
    const dir = join(dataDir, 'a-directory');
    mkdirSync(dir);
    const unreadable = await boundFiles.read(dir);
    expect(unreadable).toEqual({ status: 'unavailable', reason: 'error' });
    expect(boundFiles.quarantined(dir)).toBe(true);
  });

  it('refuses to bind a flat doc whose path is quarantined', async () => {
    // `attachFlatFile` is the door the folder-bind loop walks, and it had no
    // quarantine check at all: a known-hostile file was opened on the main
    // thread once per member of the bound tree.
    const member = join(dataDir, 'Member.kt');
    // Quarantine the path while it is unreadable, then make it a perfectly
    // ordinary file. The refusal has to come from what the reader knows, not
    // from the file being unreadable at the moment of the attach.
    mkdirSync(member);
    expect((await boundFiles.read(member)).status).toBe('unavailable');
    expect(boundFiles.quarantined(member)).toBe(true);
    rmSync(member, { recursive: true, force: true });
    writeFileSync(member, 'fun member() {}\n');

    docStore.getOrCreate('m1', { type: 'code', sourceUrl: member });
    expect(docStore.attachFlatFile('m1', member)).toMatchObject({
      ok: false,
      error: 'read-failed',
    });
    // Refused means unbound and unseeded — the doc keeps its .ydoc content.
    expect(docStore.get('m1')?.ydoc.getText('content').toString()).toBe('');

    // Positive control: the same call on the same file succeeds once the
    // backoff is forgotten, so the refusal above is the quarantine talking
    // and not something else about this path.
    boundFiles.reset();
    expect(docStore.attachFlatFile('m1', member).ok).toBe(true);
    expect(docStore.get('m1')?.ydoc.getText('content').toString()).toBe('fun member() {}\n');
  });
});
