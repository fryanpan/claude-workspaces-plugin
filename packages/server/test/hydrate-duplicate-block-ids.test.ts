import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
/**
 * A doc that already holds one block id on several blocks gets fresh ids for
 * the copies when it loads — and loading writes nothing to disk for it.
 *
 * The browser editor used to copy a block's id onto the block Enter made, so
 * docs saved before that was fixed carry the copies in their `.ydoc`. The
 * outline hands an id out as an address, and an address naming two blocks
 * sends an edit to whichever a lookup meets first.
 *
 * Fixtures are fictional. The repo is public.
 */
import { initDocMeta, prose } from '@claude-workspaces/core';
import * as Y from 'yjs';
import { DocStore } from '../src/doc-store.ts';
import { SseBus } from '../src/sse.ts';
import { createWebhookDispatcher } from '../src/webhooks.ts';
import { pastWriteBack, waitFor } from './wait-for.ts';

const DOC_ID = 'd-notes';

/** A saved prose doc whose bullets carry the copies Enter used to make: the
 *  first three items share one id and an agent's authorship. */
function seed(dataDir: string): string {
  const doc = new Y.Doc();
  initDocMeta(doc, { docId: DOC_ID, type: 'markdown', createdAt: 1, title: 'Riverbend' });
  const fragment = prose.getProseFragment(doc);
  fragment.push(prose.parseMarkdownBlocks('## Riverbend\n\n- dock\n- ferry\n- kiln\n- tide\n'));
  prose.ensureBlockIds(doc);
  const items = prose.addressableBlocks(fragment).filter((el) => el.nodeName === 'listItem');
  const first = prose.readBlockId(items[0] as Y.XmlElement) as string;
  for (const item of items.slice(0, 3)) {
    item.setAttribute(prose.BLOCK_ID_ATTR, first);
    prose.setBlockAuthor(item, 'agent:harborlight');
  }
  const path = join(dataDir, `${DOC_ID}.ydoc`);
  writeFileSync(path, Y.encodeStateAsUpdate(doc));
  writeFileSync(
    join(dataDir, `${DOC_ID}.index.json`),
    JSON.stringify({
      v: 1,
      meta: { docId: DOC_ID, type: 'markdown', createdAt: 1, title: 'Riverbend' },
      threads: { open: 0, total: 0 },
    }),
  );
  return path;
}

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
  it('gives the extra copies fresh ids and writes nothing to disk', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'cw-dup-ids-'));
    const path = seed(dataDir);
    const before = readFileSync(path);
    const onDisk = new Y.Doc();
    Y.applyUpdate(onDisk, new Uint8Array(before));
    const saved = itemIds(onDisk);
    // The fixture really holds the copies.
    expect(new Set(saved.map(([id]) => id)).size).toBe(2);

    const doc = store(dataDir).get(DOC_ID);
    if (!doc) throw new Error('doc did not hydrate');
    const loaded = itemIds(doc.ydoc);
    const ids = loaded.map(([id]) => id);
    expect(new Set(ids).size).toBe(4);
    // The first holder keeps its address and its author; the copies lose both.
    expect(loaded[0]).toEqual(saved[0] as [string, string]);
    expect(loaded[1]?.[1]).toBeUndefined();
    expect(loaded[2]?.[1]).toBeUndefined();
    expect(loaded[3]).toEqual(saved[3] as [string, string]);

    // timed: past the persist and write-back debounces — nothing may land.
    await Bun.sleep(pastWriteBack());
    expect(readFileSync(path).equals(before)).toBe(true);

    // Positive control: the same store DOES save this doc when it changes, so
    // the unchanged bytes above are the absence of a write, not a dead path.
    const fragment = prose.getProseFragment(doc.ydoc);
    doc.ydoc.transact(() => fragment.push(prose.parseMarkdownBlocks('Saltmarsh.\n')), 'agent');
    await waitFor(() => !readFileSync(path).equals(before), {
      describe: 'the edited doc to be persisted',
    });
  });
});
