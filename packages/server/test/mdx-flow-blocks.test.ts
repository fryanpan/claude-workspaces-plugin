/**
 * An `.mdx` doc holds each JSX component, `{…}` expression and import run as
 * one block of its exact source — through the real doors: `attachFileAsync`
 * (what `attach_markdown` calls), `findAndReplace`, the debounced write-back,
 * the reparse and a re-attach over a doc read under the old grammar.
 *
 * Read as markdown, a component was a paragraph. An edit to words inside it
 * re-serialized that paragraph onto one line, and a doc bound before this
 * change must not be rewritten on disk just because it now reads differently.
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
import { pastWriteBack, waitForFileToBe } from './wait-for.ts';

const CHART = `<LineChart
  title="Harborlight ferry riders"
  data={[
    { x: 1, y: 120 },
    { x: 2, y: 135 },
  ]}
/>`;

const POST = `import { LineChart } from '../components/LineChart'
import Callout from '../components/Callout'

# A year of Harborlight ferries

Ridership climbed all year.

${CHART}

{/* TODO: the October numbers */}

<Callout type="note">
  The last sailing moved to 21:30.
</Callout>

The next post looks at where those riders went.
`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('.mdx components are blocks of their own source', () => {
  let root: string;
  let dataDir: string;
  let docStore: DocStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cw-mdx-'));
    dataDir = mkdtempSync(join(tmpdir(), 'cw-mdx-data-'));
    docStore = new DocStore({
      dataDir,
      sse: new SseBus(),
      webhooks: createWebhookDispatcher({ onLog: () => {} }),
      decorateDocMeta: (m) => ({ ...m, reviewUrl: `http://test/review/${m.docId}` }),
    });
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

  /** Each top-level block: an MDX block's source, or the node name. */
  function blocksOf(docId: string): string[] {
    return (fragmentOf(docId).toArray() as Y.XmlElement[]).map((b) =>
      b.getAttribute('language') === prose.MDX_FLOW_LANGUAGE
        ? b.toArray().map(String).join('')
        : b.nodeName,
    );
  }

  /** A file dated an hour ago, so any write moves its mtime. */
  function writeOld(name: string, text: string): string {
    const path = join(root, name);
    writeFileSync(path, text);
    const past = new Date(Date.now() - 3_600_000);
    utimesSync(path, past, past);
    return path;
  }

  it('binds a component, an expression and the imports as blocks of their exact lines', async () => {
    const path = writeOld('post.mdx', POST);
    docStore.getOrCreate('post.mdx', { type: 'markdown', sourceUrl: path });
    expect((await docStore.attachFileAsync('post.mdx', path)).ok).toBe(true);
    expect(blocksOf('post.mdx')).toEqual([
      `import { LineChart } from '../components/LineChart'\nimport Callout from '../components/Callout'`,
      'heading',
      'paragraph',
      CHART,
      '{/* TODO: the October numbers */}',
      '<Callout type="note">\n  The last sailing moved to 21:30.\n</Callout>',
      'paragraph',
    ]);
  });

  it('an edit to the prose beside a component leaves every component byte on disk', async () => {
    const path = writeOld('post.mdx', POST);
    docStore.getOrCreate('post.mdx', { type: 'markdown', sourceUrl: path });
    expect((await docStore.attachFileAsync('post.mdx', path)).ok).toBe(true);
    expect(
      docStore.findAndReplace('post.mdx', { find: 'all year', replace: 'every month' }).ok,
    ).toBe(true);
    await waitForFileToBe(path, POST.replace('all year', 'every month'));
  });

  it('an edit to the words inside a component keeps its tags on their own lines', async () => {
    const path = writeOld('post.mdx', POST);
    docStore.getOrCreate('post.mdx', { type: 'markdown', sourceUrl: path });
    expect((await docStore.attachFileAsync('post.mdx', path)).ok).toBe(true);
    expect(docStore.findAndReplace('post.mdx', { find: '21:30', replace: '22:00' }).ok).toBe(true);
    await waitForFileToBe(path, POST.replace('21:30', '22:00'));
  });

  it('a doc read before the MDX grammar becomes blocks on re-attach, and the file is not written', async () => {
    const path = writeOld('post.mdx', POST);
    const before = statSync(path).mtimeMs;
    const doc = docStore.getOrCreate('post.mdx', { type: 'markdown', sourceUrl: path });
    // What the .ydoc of a doc bound under the old parser holds.
    doc.ydoc.transact(() => {
      prose.getProseFragment(doc.ydoc).push(prose.parseMarkdownBlocks(POST));
    });
    expect(blocksOf('post.mdx')).not.toContain(CHART);
    // Its .ydoc is newer than the file, as it is at every boot: the attach
    // then treats the doc as the side to reassert, which is the branch that
    // would rewrite the file.
    writeFileSync(join(dataDir, 'post.mdx.ydoc'), Y.encodeStateAsUpdate(doc.ydoc));

    expect((await docStore.attachFileAsync('post.mdx', path)).ok).toBe(true);
    expect(blocksOf('post.mdx')).toContain(CHART);

    // timed: proving the write-back never fires, so nothing to poll for.
    await sleep(pastWriteBack());
    expect(readFileSync(path, 'utf8')).toBe(POST);
    expect(statSync(path).mtimeMs).toBe(before);
  });

  it('an agent rewrite of an .mdx doc reads its components as blocks too', async () => {
    const path = writeOld('post.mdx', POST);
    docStore.getOrCreate('post.mdx', { type: 'markdown', sourceUrl: path });
    expect((await docStore.attachFileAsync('post.mdx', path)).ok).toBe(true);
    const next = POST.replace('all year', 'every month');
    expect(docStore.setDocContent('post.mdx', next).ok).toBe(true);
    expect(blocksOf('post.mdx')).toContain(CHART);
    await waitForFileToBe(path, next);
  });

  it('a reparse keeps the blocks and does not write the file', async () => {
    const path = writeOld('post.mdx', POST);
    docStore.getOrCreate('post.mdx', { type: 'markdown', sourceUrl: path });
    expect((await docStore.attachFileAsync('post.mdx', path)).ok).toBe(true);
    const before = statSync(path).mtimeMs;
    expect(docStore.reparseFromDisk('post.mdx').ok).toBe(true);
    expect(blocksOf('post.mdx')).toContain(CHART);
    // timed: proving the write-back never fires, so nothing to poll for.
    await sleep(pastWriteBack());
    expect(statSync(path).mtimeMs).toBe(before);
  });

  it('a comment on a component stays on its text through an edit beside it', async () => {
    const path = writeOld('post.mdx', POST);
    const doc = docStore.getOrCreate('post.mdx', { type: 'markdown', sourceUrl: path });
    expect((await docStore.attachFileAsync('post.mdx', path)).ok).toBe(true);
    const found = prose.resolveTextRangeFromFind(doc.ydoc, { find: 'Harborlight ferry riders' });
    if (!found.ok) throw new Error(`anchor: ${found.error}`);
    createThread(doc.ydoc, {
      threadId: 't-chart',
      anchor: {
        kind: 'text-range',
        startRel: found.startRel,
        endRel: found.endRel,
        snippet: { text: 'Harborlight ferry riders' },
      },
      createdBy: { id: 'u-reader', name: 'Reader', kind: 'known', color: '#336699' },
      firstComment: { id: 'c-chart', text: 'Start the axis at zero?' },
    });

    expect(
      docStore.findAndReplace('post.mdx', { find: 'all year', replace: 'every month' }).ok,
    ).toBe(true);
    await waitForFileToBe(path, POST.replace('all year', 'every month'));

    const start = Y.createAbsolutePositionFromRelativePosition(
      Y.decodeRelativePosition(found.startRel),
      doc.ydoc,
    );
    const block = start?.type.parent as Y.XmlElement | null;
    expect(block?.getAttribute('language')).toBe(prose.MDX_FLOW_LANGUAGE);
    const text = String(start?.type ?? '');
    expect(text.slice(start?.index ?? 0).startsWith('Harborlight ferry riders')).toBe(true);
    expect(docStore.listThreads('post.mdx').map((t) => t.id)).toEqual(['t-chart']);
  });
});
