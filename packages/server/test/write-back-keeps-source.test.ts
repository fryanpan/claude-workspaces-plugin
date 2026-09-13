/**
 * A write-back rewrites only the blocks an edit touched.
 *
 * The doc → disk flush used to serialize the WHOLE fragment into the
 * serializer's normal form, so the first edit through any tool rewrote every
 * byte of the file that did not already sit in that form: soft-wrapped lines
 * were joined, list markers and indents were normalized, blank lines between
 * lists dropped. For a `.mdx` post that was fatal rather than cosmetic —
 * consecutive `import` lines were joined onto one line (a paragraph's soft
 * breaks), which no longer compiles, and a JSX block's children were reflowed
 * onto its opening tag.
 *
 * These drive the real door: `attachFileAsync` (what `attach_markdown` calls),
 * one `findAndReplace`, and the debounced write-back to disk. Each asserts
 * the WHOLE file, byte for byte, against the fixture with only the edited
 * words changed.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DocStore } from '../src/doc-store.ts';
import { SseBus } from '../src/sse.ts';
import { createWebhookDispatcher } from '../src/webhooks.ts';
import { waitForFileToBe } from './wait-for.ts';

const MDX = `---
title: Reading the tide at Saltmarsh
---

import { Callout } from '../components/Callout'
import Chart from './chart.js'
export const meta = { author: 'Harborlight Press' }

# Reading the tide at Saltmarsh

The harbor opens at dawn and closes at dusk.

Boats with a <Badge tone="info">new</Badge> permit launch first,
and the rest follow on the next slack water.

<Callout type="warning">
  Watch the tide tables before you launch.
</Callout>

- Two-space list
  - nested two
    - deeper two
- sibling two

* Four-space list
    * nested four
        * deeper four

1. Ordered item
   - nested under an ordered item
2. Second ordered item

<Chart data={meta.series} />
`;

const MD = `# Riverbend field notes

The ferry runs hourly.

A soft-wrapped paragraph that the author
broke across three lines on purpose
to keep diffs small.

- Two-space list
  - nested two
    - deeper two

* Four-space list
    * nested four
        * deeper four

1. Ordered item
   - nested under an ordered item
2. Second ordered item
`;

describe('write-back keeps the bytes of blocks the edit did not touch', () => {
  let root: string;
  let dataDir: string;
  let docStore: DocStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cw-keep-src-'));
    dataDir = mkdtempSync(join(tmpdir(), 'cw-keep-src-data-'));
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

  async function bind(name: string, text: string): Promise<string> {
    const path = join(root, name);
    writeFileSync(path, text);
    docStore.getOrCreate(name, { type: 'markdown', sourceUrl: path });
    expect((await docStore.attachFileAsync(name, path)).ok).toBe(true);
    return path;
  }

  function edit(docId: string, find: string, replace: string): void {
    expect(docStore.findAndReplace(docId, { find, replace }).ok).toBe(true);
  }

  it('an .mdx post: one paragraph edited, imports, exports, JSX and lists unchanged', async () => {
    const path = await bind('post.mdx', MDX);
    edit('post.mdx', 'opens at dawn', 'opens at first light');
    await waitForFileToBe(path, MDX.replace('opens at dawn', 'opens at first light'));
  });

  it('a second edit keeps the rest too', async () => {
    const path = await bind('post.mdx', MDX);
    edit('post.mdx', 'opens at dawn', 'opens at first light');
    const once = MDX.replace('opens at dawn', 'opens at first light');
    await waitForFileToBe(path, once);
    edit('post.mdx', 'closes at dusk', 'closes at sunset');
    await waitForFileToBe(path, once.replace('closes at dusk', 'closes at sunset'));
  });

  it('an .mdx edit inside a paragraph holding inline JSX keeps its neighbours', async () => {
    const path = await bind('post.mdx', MDX);
    edit('post.mdx', 'launch first', 'launch at once');
    // The edited paragraph is re-serialized, so its soft break becomes a
    // space; nothing outside it moves.
    await waitForFileToBe(
      path,
      MDX.replace('launch first,\nand the rest', 'launch at once, and the rest'),
    );
  });

  it('an external edit becomes the base the next write-back keeps', async () => {
    const path = await bind('notes.md', MD);
    // Written by another editor: a new soft-wrapped paragraph. The reconcile
    // pulls it in; the write-back must then keep ITS line break too, which it
    // can only do if the base moved to the bytes the reconcile read.
    const external = MD.replace('The ferry', 'Tickets are sold\non board.\n\nThe ferry');
    writeFileSync(path, external);
    expect(docStore.reconcileNow('notes.md')).toBe('apply');
    edit('notes.md', 'runs hourly', 'runs every half hour');
    await waitForFileToBe(path, external.replace('runs hourly', 'runs every half hour'));
  });

  it('a plain .md file: soft wraps, list markers and indents survive an unrelated edit', async () => {
    const path = await bind('notes.md', MD);
    edit('notes.md', 'runs hourly', 'runs every half hour');
    await waitForFileToBe(path, MD.replace('runs hourly', 'runs every half hour'));
  });

  it('an edit inside an ordered list keeps its nested bullet indented past the marker', async () => {
    const path = await bind('notes.md', MD);
    edit('notes.md', 'Second ordered item', 'Second item, edited');
    // The whole list is re-serialized. A child of `1. ` has to sit three
    // columns in, or a CommonMark renderer (MDX included) reads it as a
    // sibling list and the nesting is flattened.
    await waitForFileToBe(path, MD.replace('Second ordered item', 'Second item, edited'));
  });
});
