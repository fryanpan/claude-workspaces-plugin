import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
/**
 * A doc that already holds one block id on several blocks gets fresh ids for
 * the copies when it loads — and loading writes nothing to disk for it: not
 * the bound `.md`, not the `.ydoc`.
 *
 * The browser editor used to copy a block's id onto the block Enter made, so
 * docs saved before that was fixed carry the copies in their `.ydoc`. The
 * outline hands an id out as an address, and an address naming two blocks
 * sends an edit to whichever a lookup meets first.
 *
 * Fixtures are fictional. The repo is public.
 */
import { prose } from '@claude-workspaces/core';
import type * as Y from 'yjs';
import { DocStore } from '../src/doc-store.ts';
import { SseBus } from '../src/sse.ts';
import { createWebhookDispatcher } from '../src/webhooks.ts';
import { pastWriteBack, waitFor } from './wait-for.ts';

const DOC_ID = 'd-notes';

function store(dataDir: string): DocStore {
  return new DocStore({
    dataDir,
    sse: new SseBus(),
    webhooks: createWebhookDispatcher({ onLog: () => {} }),
  });
}

function itemIds(ydoc: Y.Doc): Array<[string | undefined, string | undefined]> {
  return prose
    .addressableBlocks(prose.getProseFragment(ydoc))
    .filter((el) => el.nodeName === 'listItem')
    .map((el) => [prose.readBlockId(el), prose.readBlockAuthor(el)]);
}

describe('hydrating a doc that holds duplicate block ids', () => {
  it('gives the extra copies fresh ids, the first copy keeps its own, and nothing is written', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'cw-dup-ids-data-'));
    const srcDir = mkdtempSync(join(tmpdir(), 'cw-dup-ids-src-'));
    const mdPath = join(srcDir, 'notes.md');
    const ydocPath = join(dataDir, `${DOC_ID}.ydoc`);
    writeFileSync(mdPath, '## Riverbend\n\n- dock\n- ferry\n- kiln\n- tide\n');

    // The first boot: a bound doc whose first three bullets share one id and
    // an agent's authorship, the way Enter used to leave them.
    const first = store(dataDir);
    let saved: Array<[string | undefined, string | undefined]>;
    try {
      const doc = first.getOrCreate(DOC_ID, { type: 'markdown', title: 'Riverbend' });
      expect(first.attachFile(DOC_ID, mdPath).ok).toBe(true);
      prose.ensureBlockIds(doc.ydoc);
      const items = prose
        .addressableBlocks(prose.getProseFragment(doc.ydoc))
        .filter((el) => el.nodeName === 'listItem');
      const shared = prose.readBlockId(items[0] as Y.XmlElement) as string;
      doc.ydoc.transact(() => {
        for (const item of items.slice(0, 3)) {
          item.setAttribute(prose.BLOCK_ID_ATTR, shared);
          prose.setBlockAuthor(item, 'agent:harborlight');
        }
      }, 'agent');
      saved = itemIds(doc.ydoc);
      first.flush();
    } finally {
      first.stop();
    }
    // The fixture really holds the copies, on disk.
    expect(new Set(saved.map(([id]) => id)).size).toBe(2);
    const mdBefore = readFileSync(mdPath);
    const mdMtime = statSync(mdPath).mtimeMs;
    const ydocBefore = readFileSync(ydocPath);

    const second = store(dataDir);
    try {
      const doc = second.get(DOC_ID);
      if (!doc) throw new Error('doc did not hydrate');
      await waitFor(() => second.boundPathOf(DOC_ID) === mdPath, {
        describe: 'the hydrated doc to re-bind its .md',
      });
      const loaded = itemIds(doc.ydoc);
      expect(new Set(loaded.map(([id]) => id)).size).toBe(4);
      // The first copy in document order keeps its address and its author;
      // the later copies lose both; the untouched bullet is untouched.
      expect(loaded[0]).toEqual(saved[0] as [string, string]);
      expect(loaded[1]?.[1]).toBeUndefined();
      expect(loaded[2]?.[1]).toBeUndefined();
      expect(loaded[3]).toEqual(saved[3] as [string, string]);

      // timed: past the persist and write-back debounces — nothing may land.
      await Bun.sleep(pastWriteBack());
      expect(readFileSync(mdPath).equals(mdBefore)).toBe(true);
      expect(statSync(mdPath).mtimeMs).toBe(mdMtime);
      expect(readFileSync(ydocPath).equals(ydocBefore)).toBe(true);

      // Positive control: this store DOES write both files when the doc
      // changes, so the unchanged bytes above are an absence of writes, not a
      // binding that was never live.
      expect(second.findAndReplace(DOC_ID, { find: 'tide', replace: 'Saltmarsh' }).ok).toBe(true);
      await waitFor(() => readFileSync(mdPath, 'utf8').includes('Saltmarsh'), {
        describe: 'the edit to be written back to the .md',
      });
      await waitFor(() => !readFileSync(ydocPath).equals(ydocBefore), {
        describe: 'the edit to be persisted to the .ydoc',
      });
    } finally {
      second.stop();
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(srcDir, { recursive: true, force: true });
    }
  });
});
