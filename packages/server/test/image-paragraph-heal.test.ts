/**
 * A doc whose image line sits in a paragraph as text shows the image, and the
 * agent edits that used to put it there now write an image node.
 *
 * The shape is the one a bound blog draft reached: two `![alt](file.png)`
 * lines held as paragraph text. Such a paragraph serializes to the same `.md`
 * line as an image node, so the attach and every reparse saw doc and file in
 * sync and never rebuilt it. The repair is in the doc, on load, and leaves
 * the file's bytes alone (`packages/core/src/prose-image-line.ts`).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createThread, prose } from '@claude-workspaces/core';
import * as Y from 'yjs';
import { DocStore } from '../src/doc-store.ts';
import { SseBus } from '../src/sse.ts';
import { createWebhookDispatcher } from '../src/webhooks.ts';
import { pastWriteBack } from './wait-for.ts';

const DRAFT = `# Harborlight in a week

The board on day one.

PLACEHOLDER-ONE

The board on day five.

PLACEHOLDER-TWO

Riverbend shipped it.
`;

const FIRST = '![The board on day one](board-day-one.png)';
const SECOND = '![The board on day five](board-day-five.png "Day five")';

const READER = { id: 'u-reader', name: 'Reader', kind: 'known' as const, color: '#336699' };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('an image line held as paragraph text', () => {
  let root: string;
  let dataDir: string;
  let docStore: DocStore;

  const makeStore = () =>
    new DocStore({
      dataDir,
      sse: new SseBus(),
      webhooks: createWebhookDispatcher({ onLog: () => {} }),
      decorateDocMeta: (m) => ({ ...m, reviewUrl: `http://test/review/${m.docId}` }),
    });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cw-image-heal-'));
    dataDir = mkdtempSync(join(tmpdir(), 'cw-image-heal-data-'));
    docStore = makeStore();
  });

  afterEach(() => {
    docStore.stop();
    rmSync(root, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  });

  function fragmentOf(docId: string): Y.XmlFragment {
    const doc = docStore.get(docId);
    if (!doc) throw new Error('doc missing');
    return prose.getProseFragment(doc.ydoc);
  }

  /** Each top-level block: an image's src, or the node name. */
  function blocksOf(docId: string): string[] {
    return (fragmentOf(docId).toArray() as Y.XmlElement[]).map((b) =>
      b.nodeName === 'image' ? `image:${b.getAttribute('src')}` : b.nodeName,
    );
  }

  /** Write `line` into the paragraph holding `placeholder` AS TEXT — the
   *  state the edit paths left before this fix, built without them. */
  function writeAsText(doc: Y.Doc, placeholder: string, line: string): void {
    const fragment = prose.getProseFragment(doc);
    for (const el of fragment.toArray() as Y.XmlElement[]) {
      const text = el.toArray()[0];
      if (el.nodeName !== 'paragraph' || !(text instanceof Y.XmlText)) continue;
      if (text.toString() !== placeholder) continue;
      doc.transact(() => {
        text.delete(0, text.length);
        text.insert(0, line);
      });
      return;
    }
    throw new Error(`no paragraph holds ${placeholder}`);
  }

  /**
   * The draft as it sat: a `.ydoc` holding both image lines as paragraph
   * text, block ids on every block, and a file the write-back last wrote from
   * that doc, dated an hour ago.
   */
  function brokenDraft(docId: string): { path: string; disk: string; ids: string[] } {
    const path = join(root, `${docId}.md`);
    const doc = docStore.getOrCreate(docId, { type: 'markdown', sourceUrl: path });
    doc.ydoc.transact(() => {
      prose.getProseFragment(doc.ydoc).push(prose.parseMarkdownBlocks(DRAFT));
    });
    prose.ensureBlockIds(doc.ydoc);
    writeAsText(doc.ydoc, 'PLACEHOLDER-ONE', FIRST);
    writeAsText(doc.ydoc, 'PLACEHOLDER-TWO', SECOND);
    const fragment = prose.getProseFragment(doc.ydoc);
    const disk = prose.serializeFragmentToMarkdown(fragment);
    writeFileSync(path, disk);
    const past = new Date(Date.now() - 3_600_000);
    utimesSync(path, past, past);
    const ids = (fragment.toArray() as Y.XmlElement[]).map((b) => prose.readBlockId(b) ?? '');
    writeFileSync(join(dataDir, `${docId}.ydoc`), Y.encodeStateAsUpdate(doc.ydoc));
    return { path, disk, ids };
  }

  /** A second store over the same data dir: the doc comes back off disk. */
  function reload(): void {
    docStore.stop();
    docStore = makeStore();
  }

  it('loads as image nodes, keeping each block id, and the file does not change', async () => {
    const { path, disk, ids } = brokenDraft('draft');
    // The premise: the file already holds both lines, and the doc holds them as text.
    expect(disk).toContain(`\n${FIRST}\n`);
    expect(disk).toContain(`\n${SECOND}\n`);
    expect(blocksOf('draft').filter((b) => b.startsWith('image:'))).toEqual([]);
    const before = statSync(path).mtimeMs;

    reload();
    expect(blocksOf('draft')).toEqual([
      'heading',
      'paragraph',
      'image:board-day-one.png',
      'paragraph',
      'image:board-day-five.png',
      'paragraph',
    ]);
    const blocks = fragmentOf('draft').toArray() as Y.XmlElement[];
    expect(blocks.map((b) => prose.readBlockId(b) ?? '')).toEqual(ids);
    expect(blocks[4]?.getAttribute('title')).toBe('Day five');

    expect((await docStore.attachFileAsync('draft', path)).ok).toBe(true);
    // timed: proving the write-back never rewrites the file, so nothing to poll for.
    await sleep(pastWriteBack());
    expect(readFileSync(path, 'utf8')).toBe(disk);
    expect(statSync(path).mtimeMs).toBe(before);
  });

  it('an open thread in the paragraph keeps it as text until that thread is resolved', () => {
    brokenDraft('draft');
    const doc = docStore.get('draft');
    if (!doc) throw new Error('doc missing');
    const found = prose.resolveTextRangeFromFind(doc.ydoc, { find: 'board-day-one.png' });
    if (!found.ok) throw new Error(`anchor: ${found.error}`);
    createThread(doc.ydoc, {
      threadId: 't-image',
      anchor: {
        kind: 'text-range',
        startRel: found.startRel,
        endRel: found.endRel,
        snippet: { text: 'board-day-one.png' },
      },
      createdBy: READER,
      firstComment: { id: 'c-image', text: 'This shows as text' },
    });
    writeFileSync(join(dataDir, 'draft.ydoc'), Y.encodeStateAsUpdate(doc.ydoc));

    reload();
    // The thread's paragraph waits; the other image line does not.
    expect(blocksOf('draft')).toEqual([
      'heading',
      'paragraph',
      'paragraph',
      'paragraph',
      'image:board-day-five.png',
      'paragraph',
    ]);
    expect(docStore.listThreads('draft', { status: 'open' }).map((t) => t.id)).toEqual(['t-image']);

    expect(docStore.resolve('draft', 't-image', READER)).not.toBeNull();
    expect(blocksOf('draft')[2]).toBe('image:board-day-one.png');
    expect(docStore.listThreads('draft').map((t) => t.id)).toEqual(['t-image']);
  });

  it('find_and_replace writing an image line over a paragraph writes an image node', async () => {
    const path = join(root, 'post.md');
    writeFileSync(path, DRAFT);
    docStore.getOrCreate('post', { type: 'markdown', sourceUrl: path });
    expect((await docStore.attachFileAsync('post', path)).ok).toBe(true);

    const res = docStore.findAndReplace('post', { find: 'PLACEHOLDER-ONE', replace: FIRST });

    expect(res.ok).toBe(true);
    expect(blocksOf('post')[2]).toBe('image:board-day-one.png');
  });

  it('edit_at_anchor replacing a paragraph with an image line writes an image node', async () => {
    const path = join(root, 'post.md');
    writeFileSync(path, DRAFT);
    docStore.getOrCreate('post', { type: 'markdown', sourceUrl: path });
    expect((await docStore.attachFileAsync('post', path)).ok).toBe(true);
    const anchor = docStore.createAgentAnchor('post', { find: 'PLACEHOLDER-TWO' });
    if (!anchor.anchorId) throw new Error(`anchor: ${anchor.error}`);

    const res = docStore.editAtAgentAnchor('post', anchor.anchorId, {
      kind: 'replace',
      text: SECOND,
    });

    expect(res.ok).toBe(true);
    expect(blocksOf('post')[4]).toBe('image:board-day-five.png');
  });
});
