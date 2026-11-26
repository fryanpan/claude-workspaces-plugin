/**
 * The Library's "made here" flag is settled by an asynchronous `git ls-files`
 * after a doc's first bind. The answer can arrive after the doc has lost the
 * path to a newer doc, or has been archived. A late answer must then change
 * nothing: no flag flip, no persist into a data dir the doc no longer owns.
 *
 * All fixtures synthetic.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DocStore } from '../src/doc-store.ts';
import { SseBus } from '../src/sse.ts';
import { createWebhookDispatcher } from '../src/webhooks.ts';
import { waitFor } from './wait-for.ts';

const DOC = '# Riverbend quay\n\nThe quay opens in spring.\n';

describe("a late git answer on a doc's first bind", () => {
  const stores: DocStore[] = [];
  let repo = '';
  let dataDir = '';

  function makeStore(): DocStore {
    const store = new DocStore({
      dataDir,
      sse: new SseBus(),
      webhooks: createWebhookDispatcher({ onLog: () => {} }),
    });
    stores.push(store);
    return store;
  }

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'cw-late-git-'));
    dataDir = mkdtempSync(join(tmpdir(), 'cw-late-git-data-'));
    execFileSync('git', ['-C', repo, 'init', '-q']);
  });

  afterEach(() => {
    for (const store of stores.splice(0)) store.simulateCrash();
    rmSync(repo, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('leaves a doc that lost the path to a newer doc as it was', async () => {
    const path = join(repo, 'quay-plan.md');
    writeFileSync(path, DOC);
    const store = makeStore();
    const older = store.getOrCreate('quay-august', { type: 'markdown', sourceUrl: path });
    older.meta.createdAt = Date.now() - 14 * 24 * 60 * 60 * 1000;
    const newer = store.getOrCreate('quay-today', { type: 'markdown', sourceUrl: path });
    newer.meta.createdAt = Date.now();

    // Both binds in one tick, so neither git answer can arrive in between:
    // the older doc is superseded before its answer is read.
    expect(store.attachFile('quay-august', path).ok).toBe(true);
    expect(store.attachFile('quay-today', path).ok).toBe(true);

    // Positive control: the answer for the newer doc arrives and flips it, so
    // the older doc's answer has arrived by then too (same repo, same file).
    await waitFor(() => (newer.meta.seededFromFile === false ? true : undefined), {
      describe: "the newer doc's git answer",
    });
    expect(older.meta.seededFromFile).toBe(true);
  });

  it('writes nothing for a doc archived before the answer came', async () => {
    const path = join(repo, 'quay-plan.md');
    const control = join(repo, 'harbour-plan.md');
    writeFileSync(path, DOC);
    writeFileSync(control, DOC);
    const store = makeStore();
    store.getOrCreate('quay-archived', { type: 'markdown', sourceUrl: path });
    const witness = store.getOrCreate('quay-witness', { type: 'markdown', sourceUrl: control });

    expect(store.attachFile('quay-archived', path).ok).toBe(true);
    expect(store.attachFile('quay-witness', control).ok).toBe(true);
    expect(store.workspaces.archiveDoc('quay-archived', { archivedBy: 'Alice' }).ok).toBe(true);

    await waitFor(() => (witness.meta.seededFromFile === false ? true : undefined), {
      describe: "the witness doc's git answer",
    });
    // Nothing was written back into the live data dir for the archived doc.
    expect(existsSync(join(dataDir, 'quay-archived.private.json'))).toBe(false);
    expect(existsSync(join(dataDir, 'quay-archived.ydoc'))).toBe(false);
  });
});
