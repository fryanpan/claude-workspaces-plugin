/**
 * An edit made while a doc was parked survives the doc being evicted.
 *
 * A parked doc keeps its edits in the `.ydoc` and writes nothing to its file,
 * so for as long as the park lasts the file is owed those edits. While the
 * doc is resident the park remembers that (`editedBefore`), and the bind
 * that ends the park reasserts the doc over the file. Eviction drops the
 * park, so the next hydrate has only the two mtimes to go on — and a file
 * touched after the `.ydoc`'s last save (a sync client re-materialising it,
 * say) reads as the newer side and is pulled in over the edit.
 *
 * A FIFO with no writer is the sick file: `stat` answers, `open` never
 * returns. The doc and its text are invented.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as Y from 'yjs';
import { getProseFragment, serializeFragmentToMarkdown } from '../../core/src/prose.ts';
import { SHORT_KEEP_MS } from '../src/doc-residency.ts';
import { DocStore } from '../src/doc-store.ts';
import { boundFiles } from '../src/slow-fs.ts';
import { SseBus } from '../src/sse.ts';
import { createWebhookDispatcher } from '../src/webhooks.ts';
import { makeFifo, releaseFifosIn } from './fifo.ts';
import { waitFor, waitForFile } from './wait-for.ts';

const DOC_ID = 'parked-evicted';
const FIRST = '# Survey\n\nHarborlight pier.\n\nRiverbend mill.\n\nSaltmarsh dyke.\n';

describe('a parked doc edited, then evicted', () => {
  let dataDir: string;
  let boundPath: string;
  let store: DocStore | undefined;
  let storeNow = Date.now();

  const newStore = () =>
    new DocStore({
      dataDir,
      sse: new SseBus(),
      webhooks: createWebhookDispatcher({ onLog: () => {} }),
      decorateDocMeta: (m) => ({ ...m, reviewUrl: `http://test/review/${m.docId}` }),
      now: () => storeNow,
    });

  /** What the `.ydoc` on disk holds, read without loading it into a store. */
  const persistedBody = (): string => {
    const ydoc = new Y.Doc();
    Y.applyUpdate(ydoc, readFileSync(join(dataDir, `${DOC_ID}.ydoc`)));
    return serializeFragmentToMarkdown(getProseFragment(ydoc));
  };

  beforeEach(() => {
    boundFiles.reset();
    storeNow = Date.now();
    dataDir = mkdtempSync(join(tmpdir(), 'park-evict-data-'));
    boundPath = join(dataDir, 'survey.mdx');
    writeFileSync(boundPath, FIRST);
    const first = newStore();
    first.getOrCreate(DOC_ID, { type: 'markdown', sourceUrl: boundPath });
    expect(first.attachFile(DOC_ID, boundPath).ok).toBe(true);
    first.flush();
    first.stop();
    unlinkSync(boundPath);
    makeFifo(boundPath);
  });

  afterEach(async () => {
    store?.stop();
    store = undefined;
    await releaseFifosIn(dataDir);
    boundFiles.reset();
    rmSync(dataDir, { recursive: true, force: true });
  });

  /** Park the doc, delete a block in it, evict it, then bring the file back
   *  holding `fileText`, written after the `.ydoc`'s save, and re-open it. */
  const editParkEvictReopen = async (fileText: string): Promise<DocStore> => {
    const live = newStore();
    store = live;
    live.get(DOC_ID);
    await waitFor(() => live.getDocStatus(DOC_ID)?.sourceParked?.reason.includes('quarantined'), {
      describe: 'the doc to park on its quarantined file',
    });

    const cut = live.docEdits.deleteBlocksInRange(DOC_ID, {
      startFind: 'Riverbend mill.',
      endFind: 'Riverbend mill.',
    });
    expect(cut.ok).toBe(true);
    // The `.ydoc` save is what eviction would otherwise hold for; settle it
    // so the eviction below is the ordinary idle one.
    live.flush();

    storeNow += SHORT_KEEP_MS + 1;
    expect(await live.evictIdleDocs()).toContain(DOC_ID);
    // Eviction itself loses nothing: the `.ydoc` it left holds the edit.
    expect(persistedBody()).not.toContain('Riverbend mill.');

    await releaseFifosIn(dataDir);
    unlinkSync(boundPath);
    writeFileSync(boundPath, fileText);
    boundFiles.reset();

    live.get(DOC_ID);
    await waitFor(() => live.boundPathOf(DOC_ID), { describe: 'the doc to bind again' });
    return live;
  };

  const backups = (): string[] => {
    const dir = join(dataDir, 'clobber-backups');
    return existsSync(dir) ? readdirSync(dir).map((f) => readFileSync(join(dir, f), 'utf8')) : [];
  };

  it('writes the edit to the file when it comes back, rather than reading the file over it', async () => {
    // The file is touched without its content changing.
    const live = await editParkEvictReopen(FIRST);
    expect(live.readMarkdownBody(DOC_ID)).not.toContain('Riverbend mill.');
    await waitForFile(boundPath, (text) => !text.includes('Riverbend mill.'));
  });

  it('keeps a copy of a file a person edited meanwhile before writing over it', async () => {
    // Somebody edited the file in another editor while the doc was parked.
    const theirs = FIRST.replace('Saltmarsh dyke.', 'Saltmarsh dyke, raised in spring.');
    const live = await editParkEvictReopen(theirs);
    expect(live.readMarkdownBody(DOC_ID)).not.toContain('Riverbend mill.');
    await waitForFile(boundPath, (text) => !text.includes('Riverbend mill.'));
    // Their version is not lost: it is in clobber-backups/ byte for byte.
    expect(backups()).toContain(theirs);
  });
});
