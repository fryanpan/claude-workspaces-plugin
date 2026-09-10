/**
 * What the disk→doc poll calls "unchanged".
 *
 * The poll detects an external edit by stat'ing the bound file and comparing
 * against the stamp it recorded last time. For as long as that stamp was the
 * mtime ALONE, a write that landed in the same filesystem timestamp granule
 * as the stamp was invisible — and invisible FOREVER, because the mtime it
 * found is the mtime it left, so no later tick ever sees a change either. The
 * doc silently stops tracking its file, and nothing is logged.
 *
 * That is not a hypothetical granule. `statSync().mtimeMs` moves in whole
 * milliseconds under Bun, so two writes less than a millisecond apart already
 * collided; it is what made `git-ops-vs-bound.test.ts` time out on CI at
 * ~5.02s while passing locally, and it is why four test files each carried a
 * `writeExternal` helper that pushed every external write's mtime seconds
 * into the future by hand. All four are gone: the poll can see the writes
 * where they actually landed.
 *
 * The stamp is now (mtime, size), and the mtime is read from the file's
 * NANOSECOND stamp — six distinct values where `mtimeMs` gave one. These
 * tests pin all three: the size half, the nanosecond half, and the echo
 * suppression both halves also serve.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DocStore } from '../src/doc-store.ts';
import { SseBus } from '../src/sse.ts';
import { createWebhookDispatcher } from '../src/webhooks.ts';
import { waitFor } from './wait-for.ts';

const DOC = `# Design note

Intro paragraph on main.

## Section

Keep this sentence intact.
`;

describe('the poll’s change detection', () => {
  let root: string;
  let dataDir: string;
  let path: string;
  let docStore: DocStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cw-stamp-'));
    dataDir = mkdtempSync(join(tmpdir(), 'cw-stamp-data-'));
    path = join(root, 'doc.md');
    writeFileSync(path, DOC);
    docStore = new DocStore({
      dataDir,
      sse: new SseBus(),
      webhooks: createWebhookDispatcher({ onLog: () => {} }),
      decorateDocMeta: (m) => ({ ...m, reviewUrl: `http://test/review/${m.docId}` }),
    });
    docStore.getOrCreate('d1', { type: 'markdown', sourceUrl: path });
    expect(docStore.attachFile('d1', path).ok).toBe(true);
  });

  afterEach(() => {
    // Stop before the directories go: a live store keeps sweeping and keeps
    // firing write-backs into a data dir that is no longer there.
    docStore.stop();
    rmSync(root, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  });

  const liveText = () => docStore.getDoc('d1')?.plainText ?? '';
  const untilLive = (needle: string) =>
    waitFor(() => liveText().includes(needle), {
      describe: `the live doc to hold ${needle}`,
      timeout: 3000,
    });

  /**
   * POSITIVE CONTROL. Everything below asserts that a write with a COLLIDING
   * mtime still lands; a harness where no write ever reached the doc would
   * report the same success on the negative-sounding half.
   */
  it('positive control: an ordinary write with a fresh mtime reaches the doc', async () => {
    writeFileSync(path, DOC.replace('Intro paragraph on main.', 'An ordinary save.'));
    await untilLive('An ordinary save.');
  });

  it('sees a write that left the mtime exactly where it found it', async () => {
    // What `armFileWatcher` recorded a moment ago, in beforeEach.
    const recorded = statSync(path);
    writeFileSync(path, DOC.replace('Intro paragraph on main.', 'Working-tree scratch.'));
    // Pin the mtime back — which is what a filesystem whose granularity is
    // coarser than the gap does on its own, for free.
    utimesSync(path, recorded.atime, recorded.mtime);

    // The premise the test rests on: the mtime really is unchanged, and the
    // size really did move. Assert it, or a platform that quietly refuses the
    // utimes would make this pass without ever building the case.
    expect(statSync(path).mtimeMs).toBe(recorded.mtimeMs);
    expect(statSync(path).size).not.toBe(recorded.size);

    await untilLive('Working-tree scratch.');
  });

  it('sees a write that landed in the same millisecond and changed the length by nothing', async () => {
    // The hole the size half left open, and the one this file's header used
    // to call "far smaller". A same-length write inside the previous stamp's
    // millisecond moves neither half of an (mtimeMs, size) stamp, so the poll
    // returns early forever and the doc silently stops tracking its file.
    //
    // Built by hand rather than by racing two writes: `utimesSync` takes
    // fractional seconds at nanosecond resolution, so the two states can be
    // placed 500us apart INSIDE one millisecond every run, on any machine.
    const sameMs = Math.floor(Date.now() / 1000) + 0.25;
    const halfMsLater = sameMs + 0.0005;
    const first = DOC.replace('Intro paragraph on main.', 'Same length, line A.');
    const second = DOC.replace('Intro paragraph on main.', 'Same length, line B.');

    writeFileSync(path, first);
    utimesSync(path, sameMs, sameMs);
    // Records this stamp as the poll's baseline, synchronously, so the case
    // does not depend on which sweep tick got there first.
    expect(docStore.reconcileNow('d1')).toBe('apply');
    await untilLive('Same length, line A.');
    const before = statSync(path, { bigint: true });

    writeFileSync(path, second);
    utimesSync(path, halfMsLater, halfMsLater);
    const after = statSync(path, { bigint: true });

    // The premise, asserted rather than assumed: a millisecond stamp cannot
    // tell these two states apart, and neither can the length.
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.size).toBe(before.size);
    // ...but the filesystem itself can, which is the only reason there is
    // anything to read. A volume that coarsens the stamp fails here instead
    // of passing the test below for the wrong reason.
    expect(after.mtimeNs).not.toBe(before.mtimeNs);

    await untilLive('Same length, line B.');
  });

  it('still suppresses the echo of its own write-back', async () => {
    // The stamp's other job. A doc→disk flush must not read back as an
    // external edit — that arm backs the user's own document up as though a
    // stranger had written it.
    expect(
      docStore.findAndReplace('d1', {
        find: 'Keep this sentence intact.',
        replace: 'Edited in the live doc.',
      }).ok,
    ).toBe(true);
    await waitFor(
      () => require('node:fs').readFileSync(path, 'utf8').includes('Edited in the live doc.'),
      { describe: 'the write-back to reach disk', timeout: 3000 },
    );
    // Give the poll several ticks to misread our own bytes.
    await new Promise((r) => setTimeout(r, 400));
    expect(docStore.getSyncError('d1')).toBeUndefined();
    expect(liveText()).toContain('Edited in the live doc.');
  });
});
