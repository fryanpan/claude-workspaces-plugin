/**
 * The idle sweep hands the loop back between docs, and a doc somebody reaches
 * while it is handed back stays resident.
 *
 * One sweep can have thousands of docs to drop — every doc a boot's fan-out
 * read, thirty minutes on — so it yields on a time budget. A yield is a window
 * in which a request can reach a doc the sweep has already judged idle, or a
 * person can open it. These tests drive the sweep with a slice whose yields
 * are scripted, so what happens inside a window is a fact of the test rather
 * than a race against the clock.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DocStore } from '../src/doc-store.ts';
import { type TimeSlice, timeSlice } from '../src/event-loop.ts';
import { type BoundStatResult, boundFiles } from '../src/slow-fs.ts';
import { SseBus } from '../src/sse.ts';
import { createWebhookDispatcher } from '../src/webhooks.ts';
import { waitFor } from './wait-for.ts';

const HOUR = 60 * 60 * 1000;

type PoolWrite = (path: string, text: string) => Promise<BoundStatResult>;
const patchable = boundFiles as unknown as { write: PoolWrite };
const poolWrite: PoolWrite = boundFiles.write.bind(boundFiles);

/** A slice that yields before every doc and runs `during(n)` inside yield n. */
function scriptedSlice(during: (n: number) => void): TimeSlice {
  let count = 0;
  return {
    async yieldIfDue() {
      count++;
      during(count);
      await new Promise<void>((resolve) => setImmediate(resolve));
    },
    yields: () => count,
  };
}

describe('the idle sweep yields between docs', () => {
  let dataDir: string;
  let srcDir: string;
  let docStore: DocStore;
  let clock: number;

  beforeEach(() => {
    clock = Date.now();
    dataDir = mkdtempSync(join(tmpdir(), 'evict-yield-data-'));
    srcDir = mkdtempSync(join(tmpdir(), 'evict-yield-src-'));
    docStore = new DocStore({
      dataDir,
      sse: new SseBus(),
      webhooks: createWebhookDispatcher({ onLog: () => {} }),
      now: () => clock,
    });
  });
  afterEach(() => {
    patchable.write = poolWrite;
    docStore.stop();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(srcDir, { recursive: true, force: true });
  });

  /** Bound markdown docs named in order, flushed, then left idle an hour. */
  function idleBound(...ids: string[]): void {
    for (const id of ids) {
      const path = join(srcDir, `${id}.md`);
      writeFileSync(path, `# ${id}\n\nHarborlight notes\n`);
      docStore.getOrCreate(id, { type: 'markdown', title: id });
      expect(docStore.attachFile(id, path).ok).toBe(true);
    }
    docStore.flush();
    clock += HOUR;
  }

  const resident = (docId: string) => docStore.peek(docId) !== undefined;

  it('hands the loop back mid-pass and still evicts every idle doc', async () => {
    const ids = Array.from({ length: 12 }, (_, i) => `riverbend-${i}`);
    idleBound(...ids);
    // Another task on the loop, re-arming itself until the pass ends. It can
    // only run while the pass is handed back, so a count it reads between
    // "all resident" and "none" is proof of a yield mid-pass.
    const seen: number[] = [];
    let done = false;
    const watch = () => {
      seen.push(docStore.residentCount());
      if (!done) setImmediate(watch);
    };
    setImmediate(watch);
    const slice = timeSlice(0);

    const gone = await docStore.evictIdleDocs(slice);
    done = true;

    expect(gone.sort()).toEqual([...ids].sort());
    expect(docStore.residentCount()).toBe(0);
    expect(slice.yields()).toBeGreaterThan(0);
    expect(seen.some((n) => n > 0 && n < ids.length)).toBe(true);
  });

  it('keeps a doc an agent reached while the sweep was handed back', async () => {
    idleBound('harborlight', 'riverbend', 'saltmarsh');
    // Yield 2 comes before the second doc: `riverbend` is read inside it,
    // after the snapshot judged it idle.
    const slice = scriptedSlice((n) => {
      if (n === 2) expect(docStore.get('riverbend')).toBeDefined();
    });

    const gone = await docStore.evictIdleDocs(slice);

    expect(gone.sort()).toEqual(['harborlight', 'saltmarsh']);
    expect(resident('riverbend')).toBe(true);
    // Control: the read is the only thing holding it. Idle it again and the
    // next sweep, with no read inside it, drops it.
    clock += HOUR;
    expect(await docStore.evictIdleDocs(scriptedSlice(() => {}))).toEqual(['riverbend']);
  });

  it('keeps a doc a person opened while the sweep was handed back', async () => {
    idleBound('harborlight', 'riverbend', 'saltmarsh');
    const slice = scriptedSlice((n) => {
      // A live editor socket, as the upgrade adds one: the `connected` hold.
      if (n === 3) (docStore.peek('saltmarsh') as { conns: Set<unknown> }).conns.add({});
    });

    const gone = await docStore.evictIdleDocs(slice);

    expect(gone.sort()).toEqual(['harborlight', 'riverbend']);
    expect(resident('saltmarsh')).toBe(true);
  });

  it('flushes an edit made while the sweep was handed back rather than dropping it', async () => {
    idleBound('harborlight', 'riverbend');
    const slice = scriptedSlice((n) => {
      if (n === 1) {
        expect(
          docStore.docEdits.findAndReplace('riverbend', {
            find: 'Harborlight notes',
            replace: 'edited',
          }).ok,
        ).toBe(true);
      }
    });

    // The edit's write-back goes to the thread pool once its debounce runs
    // out. Hold that write open, so `flush()` below always meets it in
    // flight: on a loaded runner the debounce can run out before the test
    // reaches the flush, and that is the order this test has to survive.
    let release = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    patchable.write = async (path, text) => {
      await released;
      return poolWrite(path, text);
    };

    const gone = await docStore.evictIdleDocs(slice);

    // The edit reached for the doc, so the sweep leaves it where the edit is.
    expect(gone).toEqual(['harborlight']);
    expect(resident('riverbend')).toBe(true);
    await waitFor(() => docStore.fileMoves.inFlight('riverbend'), {
      describe: 'the write-back to reach the pool',
    });
    // And when it does go, the edit goes to disk with it. A write still on
    // the pool holds the doc (`pending-write`), so the sweep waits for it to
    // land rather than racing it.
    docStore.flush();
    release();
    await waitFor(() => !docStore.fileMoves.pendingWrite('riverbend'), {
      describe: 'the pool write to land',
    });
    clock += HOUR;
    expect(await docStore.evictIdleDocs()).toEqual(['riverbend']);
    expect(readFileSync(join(srcDir, 'riverbend.md'), 'utf8')).toContain('edited');
  });

  it('a stopped store evicts nothing more once it is handed back', async () => {
    idleBound('harborlight', 'riverbend', 'saltmarsh');
    const slice = scriptedSlice((n) => {
      if (n === 2) docStore.stop();
    });

    const gone = await docStore.evictIdleDocs(slice);

    expect(gone).toEqual(['harborlight']);
  });
});
