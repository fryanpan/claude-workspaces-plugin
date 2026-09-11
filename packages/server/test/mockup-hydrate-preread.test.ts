/**
 * A mockup hydrate arms its poll from the pool's stat, not one of its own.
 *
 * Every hydrate but boot reads its file on the pool first (`prereadFor`), and
 * the prose and flat doors hand those bytes and that stat to the attach. The
 * mockup door dropped them, so arming the mockup's poll ran `existsSync` and
 * `statSync` on the main thread — a stat on a provider that has stopped
 * answering parks the loop exactly as a read does, and a hydrate has proved
 * nothing about the path on this thread.
 *
 * The file here answers; what is counted is who asked it. The mockup and its
 * path are invented.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import * as fs from 'node:fs';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DocStore } from '../src/doc-store.ts';
import { boundFiles } from '../src/slow-fs.ts';
import { SseBus } from '../src/sse.ts';
import { createWebhookDispatcher } from '../src/webhooks.ts';
import { waitFor } from './wait-for.ts';

const DOC_ID = 'mock-checkout-flow';

function newStore(dataDir: string): DocStore {
  return new DocStore({
    dataDir,
    sse: new SseBus(),
    webhooks: createWebhookDispatcher({ onLog: () => {} }),
    decorateDocMeta: (m) => ({ ...m, reviewUrl: `http://test/review/${m.docId}` }),
  });
}

describe('a mockup doc hydrated off the main thread', () => {
  let dataDir: string;
  let htmlPath: string;
  let store: DocStore | undefined;
  const restores: Array<() => void> = [];

  beforeEach(() => {
    boundFiles.reset();
    dataDir = mkdtempSync(join(tmpdir(), 'mock-hydrate-data-'));
    htmlPath = join(dataDir, 'checkout.html');
    writeFileSync(htmlPath, '<main>Checkout, step one</main>\n');
    const first = newStore(dataDir);
    first.getOrCreate(DOC_ID, { type: 'mockup', sourceUrl: htmlPath });
    expect(first.attachMockupFile(DOC_ID, htmlPath).ok).toBe(true);
    first.flush();
    first.stop();
  });

  afterEach(() => {
    for (const restore of restores.splice(0)) restore();
    store?.stop();
    store = undefined;
    boundFiles.reset();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('binds without a main-thread stat of its source', async () => {
    // Every synchronous existence or stat question about the source, from
    // anybody in this process, from here on.
    let asked = 0;
    const realExists = fs.existsSync;
    const realStat = fs.statSync;
    const exists = spyOn(fs, 'existsSync').mockImplementation(((p: fs.PathLike) => {
      if (String(p) === htmlPath) asked++;
      return realExists(p);
    }) as typeof fs.existsSync);
    const stat = spyOn(fs, 'statSync').mockImplementation(((p: fs.PathLike, o?: object) => {
      if (String(p) === htmlPath) asked++;
      return realStat(p, o as fs.StatSyncOptions);
    }) as typeof fs.statSync);
    restores.push(
      () => exists.mockRestore(),
      () => stat.mockRestore(),
    );

    store = newStore(dataDir);
    store.get(DOC_ID);
    await waitFor(() => store?.boundPathOf(DOC_ID) === htmlPath, {
      describe: 'the deferred mockup bind to land',
    });
    expect(asked).toBe(0);
  });
});
