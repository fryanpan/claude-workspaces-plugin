/**
 * An `.mdx` doc bound before its components were blocks — and flushed since,
 * so its file holds each component joined onto one line — comes back with
 * every component and import run as a block, its pending suggestions intact
 * and its file untouched. JSX an agent inserts lands as a block too.
 *
 * The shape is the one a real post reached: the old parser read each
 * component as a paragraph and joined its lines with spaces, the write-back
 * put that joined line on disk, and from then on the doc and the file
 * serialized to the same text. The attach took that for "in sync" and never
 * re-read the doc under the MDX grammar.
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
import { pastReanchor, pastWriteBack, waitFor } from './wait-for.ts';

const POST = `import { LineChart } from '../components/LineChart'
import Chart from '../components/Chart'

# A year of Riverbend ferries

Ridership climbed all year.

<LineChart
  title="Harborlight ferry riders"
  data={[
    { x: 1, y: 120 },
    { x: 2, y: 135 },
  ]}
/>

<Chart title="Saltmarsh crossings" />

The next post looks at where those riders went.
`;

const SUGGESTER = { id: 'a-editor', name: 'Editor', color: '#336699' };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('an .mdx doc read before the MDX grammar', () => {
  let root: string;
  let dataDir: string;
  let docStore: DocStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cw-mdx-retype-'));
    dataDir = mkdtempSync(join(tmpdir(), 'cw-mdx-retype-data-'));
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
        ? `mdx: ${b.toArray().map(String).join('')}`
        : b.nodeName,
    );
  }

  /**
   * The state the post was in: a `.ydoc` holding the old parse, a pending
   * suggestion in the prose, and a file the write-back last wrote from that
   * doc, dated an hour ago.
   */
  async function legacyDoc(docId: string): Promise<{ path: string; disk: string }> {
    const path = join(root, `${docId}.mdx`);
    const doc = docStore.getOrCreate(docId, { type: 'markdown', sourceUrl: path });
    doc.ydoc.transact(() => {
      prose.getProseFragment(doc.ydoc).push(prose.parseMarkdownBlocks(POST));
    });
    const disk = prose.serializeFragmentToMarkdown(prose.getProseFragment(doc.ydoc));
    writeFileSync(path, disk);
    const past = new Date(Date.now() - 3_600_000);
    utimesSync(path, past, past);
    const suggested = docStore.createSuggestion(docId, {
      find: 'climbed all year',
      replace: 'climbed every month',
      author: SUGGESTER,
    });
    expect(suggested.ok).toBe(true);
    writeFileSync(join(dataDir, `${docId}.ydoc`), Y.encodeStateAsUpdate(doc.ydoc));
    return { path, disk };
  }

  it('re-attaching turns every component and import run into a block, and writes nothing', async () => {
    const { path, disk } = await legacyDoc('post');
    // The premise: the file holds each component on one line.
    expect(disk).toContain('<LineChart title="Harborlight ferry riders" data={[');
    expect(blocksOf('post').filter((b) => b.startsWith('mdx:'))).toEqual([]);
    const before = statSync(path).mtimeMs;

    expect((await docStore.attachFileAsync('post', path)).ok).toBe(true);

    expect(blocksOf('post')).toEqual([
      "mdx: import { LineChart } from '../components/LineChart' import Chart from '../components/Chart'",
      'heading',
      'paragraph',
      'mdx: <LineChart title="Harborlight ferry riders" data={[ { x: 1, y: 120 }, { x: 2, y: 135 }, ]} />',
      'mdx: <Chart title="Saltmarsh crossings" />',
      'paragraph',
    ]);
    expect(docStore.listSuggestions('post')).toHaveLength(1);
    // timed: proving the write-back never fires, so nothing to poll for.
    await sleep(pastWriteBack());
    expect(readFileSync(path, 'utf8')).toBe(disk);
    expect(statSync(path).mtimeMs).toBe(before);
  });

  it('a comment on a chart that was a paragraph follows it into its block', async () => {
    const { path } = await legacyDoc('post');
    const doc = docStore.get('post');
    if (!doc) throw new Error('doc missing');
    const found = prose.resolveTextRangeFromFind(doc.ydoc, { find: 'Saltmarsh crossings' });
    if (!found.ok) throw new Error(`anchor: ${found.error}`);
    createThread(doc.ydoc, {
      threadId: 't-chart',
      anchor: {
        kind: 'text-range',
        startRel: found.startRel,
        endRel: found.endRel,
        snippet: { text: 'Saltmarsh crossings' },
      },
      createdBy: { id: 'u-reader', name: 'Reader', kind: 'known', color: '#336699' },
      firstComment: { id: 'c-chart', text: 'Start the axis at zero?' },
    });
    writeFileSync(join(dataDir, 'post.ydoc'), Y.encodeStateAsUpdate(doc.ydoc));

    expect((await docStore.attachFileAsync('post', path)).ok).toBe(true);

    await waitFor(
      () => {
        const thread = (doc.ydoc.getMap('threads') as Y.Map<Y.Map<unknown>>).get('t-chart');
        const anchor = thread?.get('anchor') as { startRel?: Uint8Array } | undefined;
        if (!anchor?.startRel) return false;
        const at = Y.createAbsolutePositionFromRelativePosition(
          Y.decodeRelativePosition(anchor.startRel),
          doc.ydoc,
        );
        const block = at?.type.parent as Y.XmlElement | null;
        return (
          block?.getAttribute('language') === prose.MDX_FLOW_LANGUAGE &&
          String(at?.type).slice(at?.index).startsWith('Saltmarsh crossings')
        );
      },
      { timeout: pastReanchor() * 20, describe: 'the thread anchored in the chart block' },
    );
  });

  it('a reparse of that doc keeps its pending suggestion', async () => {
    const { path } = await legacyDoc('post');
    expect((await docStore.attachFileAsync('post', path)).ok).toBe(true);
    expect(docStore.reparseFromDisk('post').ok).toBe(true);
    expect(blocksOf('post')).toContain('mdx: <Chart title="Saltmarsh crossings" />');
    expect(docStore.listSuggestions('post')).toHaveLength(1);
  });

  it('JSX inserted after a thread lands as a block of its exact lines, on disk too', async () => {
    const { path } = await legacyDoc('post');
    expect((await docStore.attachFileAsync('post', path)).ok).toBe(true);
    const doc = docStore.get('post');
    if (!doc) throw new Error('doc missing');
    const found = prose.resolveTextRangeFromFind(doc.ydoc, { find: 'where those riders went' });
    if (!found.ok) throw new Error(`anchor: ${found.error}`);
    createThread(doc.ydoc, {
      threadId: 't-add',
      anchor: {
        kind: 'text-range',
        startRel: found.startRel,
        endRel: found.endRel,
        snippet: { text: 'where those riders went' },
      },
      createdBy: { id: 'u-reader', name: 'Reader', kind: 'known', color: '#336699' },
      firstComment: { id: 'c-add', text: 'Add the winter chart here' },
    });
    const winter = '<BarChart\n  title="Winter sailings"\n  data={[{ x: 1, y: 40 }]}\n/>';

    expect(docStore.insertBlocksAfterThread('post', 't-add', winter).ok).toBe(true);

    expect(blocksOf('post').at(-1)).toBe(`mdx: ${winter}`);
    await waitFor(() => readFileSync(path, 'utf8').includes(winter), {
      describe: 'the inserted chart on disk with its own line breaks',
    });
  });

  it('JSX inserted at an agent anchor lands as a block', async () => {
    const { path } = await legacyDoc('post');
    expect((await docStore.attachFileAsync('post', path)).ok).toBe(true);
    const anchor = docStore.createAgentAnchor('post', { find: 'where those riders went' });
    if (!anchor.anchorId) throw new Error(`anchor: ${anchor.error}`);
    const note = '{/* TODO: the spring numbers */}';

    expect(docStore.insertBlocksAtAnchor('post', anchor.anchorId, note).ok).toBe(true);

    expect(blocksOf('post').at(-1)).toBe(`mdx: ${note}`);
  });

  it('JSX in a block edit lands as a block', async () => {
    const { path } = await legacyDoc('post');
    expect((await docStore.attachFileAsync('post', path)).ok).toBe(true);
    const heading = docStore.readOutline('post')?.blocks.find((b) => b.kind === 'heading');
    if (!heading) throw new Error('no heading in the outline');
    const chart = '<Chart\n  title="Harborlight by month"\n/>';

    const res = docStore.applyBlockEdits(
      'post',
      [{ op: 'insert_under_heading', headingId: heading.id, markdown: chart }],
      { author: 'a-writer' },
    );

    expect(res.ok && res.applied).toBe(1);
    expect(blocksOf('post').at(-1)).toBe(`mdx: ${chart}`);
  });
});
