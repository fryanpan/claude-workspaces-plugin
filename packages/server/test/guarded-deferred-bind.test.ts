/**
 * A doc bound to a file under a walled lead's project binds again after a
 * hydrate that had to read it off the main thread.
 *
 * Every hydrate but boot reads a bound file in the pool and binds when the
 * read lands (`bindAfterRead`). The bind takes the read's bytes back through
 * `boundFiles.takeFresh`, which hands nothing over for a path a guard covers,
 * so for a file under a walled lead's roots the bind found no bytes, parked the
 * doc again and read the file again, every poll tick, for good. The doc stayed
 * `bound: false` with "being read" as its reason, and no edit reached the file.
 *
 * The guard here covers the test's folder and admits everything, which is what
 * a walled lead's roots look like to a file inside them. Names are invented.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PathGuard } from '../src/bound-path-guard.ts';
import { DocStore } from '../src/doc-store.ts';
import { boundFiles } from '../src/slow-fs.ts';
import { SseBus } from '../src/sse.ts';
import { createWebhookDispatcher } from '../src/webhooks.ts';
import { waitFor, waitForFile } from './wait-for.ts';

const DOC_ID = 'harborlight-notes';
const FIRST = '# Harborlight notes\n\nThe first line of the plan.\n';

function makeStore(dataDir: string): DocStore {
  return new DocStore({
    dataDir,
    sse: new SseBus(),
    webhooks: createWebhookDispatcher({ onLog: () => {} }),
    decorateDocMeta: (m) => ({ ...m, reviewUrl: `http://test/review/${m.docId}` }),
  });
}

/** A guard over `root` that admits every path in it, as a lead's roots do. */
function guardOver(root: string, refuse = false): PathGuard {
  const inside = (p: string) => p === root || p.startsWith(`${root}/`);
  return {
    covers: inside,
    admits: (p) => !(refuse && inside(p)),
    landsInside: (_p, real) => inside(real),
  };
}

describe('a guarded bound doc hydrated off the main thread', () => {
  let dataDir: string;
  let project: string;
  let mdPath: string;
  let store: DocStore | undefined;
  let removeGuard: (() => void) | undefined;

  beforeEach(() => {
    boundFiles.reset();
    dataDir = mkdtempSync(join(tmpdir(), 'guarded-bind-data-'));
    project = realpathSync(mkdtempSync(join(tmpdir(), 'guarded-bind-project-')));
    mdPath = join(project, 'notes.md');
    writeFileSync(mdPath, FIRST);
    // Bind once with no guard, then shut down, so the next store must
    // hydrate the doc from its `.ydoc` — as a restart or an eviction does.
    const first = makeStore(dataDir);
    first.getOrCreate(DOC_ID, { type: 'markdown', sourceUrl: mdPath });
    expect(first.attachFile(DOC_ID, mdPath).ok).toBe(true);
    first.flush();
    first.stop();
  });

  afterEach(() => {
    store?.flush();
    store?.stop();
    store = undefined;
    removeGuard?.();
    removeGuard = undefined;
    boundFiles.reset();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });

  it('binds by itself and writes a live edit to the file', async () => {
    removeGuard = boundFiles.guards.add(guardOver(project));
    store = makeStore(dataDir);
    store.get(DOC_ID);
    // The seam: the read went to the pool, so the doc is parked for now.
    expect(store.getDocStatus(DOC_ID)?.sourceParked?.reason).toContain('being read');

    await waitFor(() => store?.boundPathOf(DOC_ID) !== undefined, {
      describe: 'the guarded doc to bind once its read lands',
    });
    expect(store.getDocStatus(DOC_ID)?.sourceParked).toBeUndefined();

    const edited = store.findAndReplace(DOC_ID, { find: 'first line', replace: 'edited line' });
    expect(edited.ok).toBe(true);
    await waitForFile(mdPath, (text) => text.includes('The edited line of the plan.'));
  });

  it('keeps an edit made while the read was in flight, and writes it to the file', async () => {
    removeGuard = boundFiles.guards.add(guardOver(project));
    store = makeStore(dataDir);
    store.get(DOC_ID);
    expect(store.boundPathOf(DOC_ID)).toBeUndefined();
    // The edit lands in the gap, before the pool read can come back.
    const edited = store.findAndReplace(DOC_ID, { find: 'first line', replace: 'gap line' });
    expect(edited.ok).toBe(true);

    await waitFor(() => store?.boundPathOf(DOC_ID) !== undefined, {
      describe: 'the guarded doc to bind once its read lands',
    });
    await waitForFile(mdPath, (text) => text.includes('The gap line of the plan.'));
  });

  it('says why when the guard refuses the file, rather than "being read"', async () => {
    removeGuard = boundFiles.guards.add(guardOver(project, true));
    store = makeStore(dataDir);
    store.get(DOC_ID);
    await waitFor(
      () => {
        const reason = store?.getDocStatus(DOC_ID)?.sourceParked?.reason ?? '';
        return reason !== '' && !reason.includes('being read');
      },
      { describe: 'the park to name the refusal' },
    );
    const park = store.getDocStatus(DOC_ID)?.sourceParked;
    expect(park?.reason).toContain('refused');
    // And the file is untouched: a parked doc writes nothing.
    expect(readFileSync(mdPath, 'utf8')).toBe(FIRST);
  });
});
