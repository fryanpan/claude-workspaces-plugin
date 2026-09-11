/**
 * A hydrate while the pool is backed up parks its doc instead of opening the
 * file.
 *
 * `busy` is the pool's own refusal: `BOUND_READ_MAX_OVERDUE` reads have blown
 * their deadline and still hold their threads, so some bound path has stopped
 * answering and nobody knows which. A path with no quarantine on it is not
 * known-good in that state — it may be the next bad one — and `busy` leaves
 * no mark on it, which is how a hydrate once read "not quarantined" as "safe
 * to open on the main thread".
 *
 * `slow-fs.test.ts` proves the pool refuses; this proves the hydrate listens,
 * at both doors: an ordinary `get`, and the boot pass that reasserts an owed
 * write — the one hydrate still allowed to read on the main thread.
 *
 * FIFOs with no writer are the sick files. The fifth file is one too, with a
 * valve that ends a main-thread open a moment late, so a regression fails its
 * assertions rather than hanging the runner. The paths are invented.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readDocIndex, writeDocIndex } from '../src/doc-index.ts';
import { DOC_STORE_TIMINGS } from '../src/doc-store-timings.ts';
import { DocStore } from '../src/doc-store.ts';
import { BOUND_READ_MAX_OVERDUE, boundFiles } from '../src/slow-fs.ts';
import { SseBus } from '../src/sse.ts';
import { createWebhookDispatcher } from '../src/webhooks.ts';
import { armFifoValve, makeFifo, releaseFifo, releaseFifosIn } from './fifo.ts';
import { waitFor } from './wait-for.ts';

const DOC_ID = 'brief-behind-a-queue';
const FIRST = '# Brief\n\nThe version the .ydoc holds.\n';
/** Well past the read deadline — see `armFifoValve`. */
const VALVE_MS = DOC_STORE_TIMINGS.boundReadDeadlineMs * 6;

function newStore(dataDir: string): DocStore {
  return new DocStore({
    dataDir,
    sse: new SseBus(),
    webhooks: createWebhookDispatcher({ onLog: () => {} }),
    decorateDocMeta: (m) => ({ ...m, reviewUrl: `http://test/review/${m.docId}` }),
  });
}

describe('a hydrate while bound-file reads are backed up', () => {
  let dataDir: string;
  let scratch: string;
  let stallDir: string;
  let briefPath: string;
  let store: DocStore | undefined;
  const disarm: Array<() => void> = [];

  beforeEach(async () => {
    boundFiles.reset();
    dataDir = mkdtempSync(join(tmpdir(), 'busy-hydrate-data-'));
    scratch = mkdtempSync(join(tmpdir(), 'busy-hydrate-files-'));
    stallDir = join(scratch, 'stalled');
    mkdirSync(stallDir);
    briefPath = join(scratch, 'brief.md');
    writeFileSync(briefPath, FIRST);

    // Round one: the file answers, and the doc is bound and persisted.
    const first = newStore(dataDir);
    first.getOrCreate(DOC_ID, { type: 'markdown', sourceUrl: briefPath });
    expect(first.attachFile(DOC_ID, briefPath).ok).toBe(true);
    first.flush();
    first.stop();

    // The fifth path goes bad too — but nothing ever reads it, so it earns
    // no quarantine. Only the pool's state can refuse it.
    unlinkSync(briefPath);
    makeFifo(briefPath);
    disarm.push(armFifoValve(briefPath, VALVE_MS, 'write'));

    // Four OTHER paths that never answer, read until each blows its deadline.
    await Promise.all(
      Array.from({ length: BOUND_READ_MAX_OVERDUE }, (_, i) =>
        boundFiles.read(makeFifo(join(stallDir, `stall-${i}.md`))),
      ),
    );
    expect(boundFiles.busy()).toBe(true);
    expect(boundFiles.quarantined(briefPath)).toBe(false);
  });

  afterEach(async () => {
    for (const off of disarm.splice(0)) off();
    store?.stop();
    store = undefined;
    await releaseFifosIn(stallDir);
    await releaseFifosIn(scratch);
    boundFiles.reset();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  });

  const text = () => store?.getDoc(DOC_ID)?.plainText ?? '';

  /** What a main-thread open would have changed, asserted as not changed. */
  function expectParkedUnopened(): void {
    expect(store?.boundPathOf(DOC_ID)).toBeUndefined();
    expect(text()).toContain('The version the .ydoc holds.');
    expect(store?.getDocStatus(DOC_ID)?.sourceParked?.reason).toContain('backed up');
    // Nobody holds the pipe's read end: the file was never opened, on the
    // main thread or the pool.
    expect(releaseFifo(briefPath)).toBe(false);
  }

  it('an ordinary hydrate parks the doc on its .ydoc', () => {
    store = newStore(dataDir);
    expect(store.get(DOC_ID)).toBeDefined();
    expectParkedUnopened();
  });

  it('the boot pass that reasserts an owed write parks it too, and still owes the write', () => {
    const row = readDocIndex(dataDir, DOC_ID);
    if (!row) throw new Error('round one wrote no index row');
    writeDocIndex(dataDir, DOC_ID, { ...row, pendingFileWrite: true });

    // Boot hydrates this doc at once, and that hydrate may read on the main
    // thread — unless the pool says reads are backed up.
    store = newStore(dataDir);
    expectParkedUnopened();
    // Parked is not paid: the next boot still owes the file this write.
    expect(readDocIndex(dataDir, DOC_ID)?.pendingFileWrite).toBe(true);
  });

  it('positive control: once the stalled reads drain, the parked doc binds on its own', async () => {
    store = newStore(dataDir);
    store.get(DOC_ID);
    expectParkedUnopened();

    // The four stalled reads land and give their threads back, and the fifth
    // file answers again. Nobody touches the doc.
    for (const off of disarm.splice(0)) off();
    await releaseFifosIn(stallDir);
    unlinkSync(briefPath);
    writeFileSync(briefPath, FIRST);
    await waitFor(() => !boundFiles.busy(), { describe: 'the stalled reads to drain' });

    await waitFor(() => store?.boundPathOf(DOC_ID) === briefPath, {
      describe: 'the parked doc to re-bind once the reads drained',
    });
    expect(store.getDocStatus(DOC_ID)?.sourceParked).toBeUndefined();
  });
});
