/**
 * An agent adds, edits and removes a row of a markdown table in a bound doc,
 * and a person's thread anchored on a word in another cell stays attached.
 *
 * On 30 Oct an editor agent tried all three tools it could find and none
 * worked: find_and_replace refused a replacement with one more pipe row than
 * its find (`table-shape-mismatch`), insert_blocks_at_anchor put a paragraph
 * inside a table cell, and apply_block_edits returned a replace of the whole
 * table as a suggestion — which, accepted, would also have detached the
 * thread in the cell.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createThread, prose } from '@claude-workspaces/core';
import * as Y from 'yjs';
import { DocStore } from '../src/doc-store.ts';
import { SseBus } from '../src/sse.ts';
import { createWebhookDispatcher } from '../src/webhooks.ts';
import { waitFor } from './wait-for.ts';

const DOC = `# Ferries

| Route | Boats | Note |
| --- | --- | --- |
| Harborlight | 2 | Riverbend crossing |
| Saltmarsh | 1 | weekends only |

The table above is the winter timetable.
`;

/** An element's text, its paragraphs joined with nothing between them. */
function textOf(node: Y.XmlElement): string {
  return node
    .toArray()
    .map((c) =>
      c instanceof Y.XmlText ? c.toString().replace(/<[^>]+>/g, '') : textOf(c as Y.XmlElement),
    )
    .join('');
}

const READER = { id: 'u-alice', name: 'Alice', kind: 'known' as const, color: '#336699' };

describe('editing the rows of a table in a bound doc', () => {
  let root: string;
  let dataDir: string;
  let docStore: DocStore;
  let path: string;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cw-table-rows-'));
    dataDir = mkdtempSync(join(tmpdir(), 'cw-table-rows-data-'));
    docStore = new DocStore({
      dataDir,
      sse: new SseBus(),
      webhooks: createWebhookDispatcher({ onLog: () => {} }),
      decorateDocMeta: (m) => ({ ...m, reviewUrl: `http://test/review/${m.docId}` }),
    });
    path = join(root, 'ferries.md');
    writeFileSync(path, DOC);
    docStore.getOrCreate('ferries', { type: 'markdown', sourceUrl: path });
    expect((await docStore.attachFileAsync('ferries', path)).ok).toBe(true);
    // Alice's thread, on one word in the Harborlight row's Note cell.
    const ydoc = liveDoc();
    const found = prose.resolveTextRangeFromFind(ydoc, { find: 'Riverbend' });
    if (!found.ok) throw new Error(`anchor: ${found.error}`);
    createThread(ydoc, {
      threadId: 't-cell',
      anchor: {
        kind: 'text-range',
        startRel: found.startRel,
        endRel: found.endRel,
        snippet: { text: 'Riverbend' },
      },
      createdBy: READER,
      firstComment: { id: 'c-cell', text: 'Is this the right crossing?' },
    });
  });

  afterEach(() => {
    // Settle the pending saves first, so none lands in a removed directory.
    docStore.flush();
    docStore.stop();
    rmSync(root, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  });

  function liveDoc(): Y.Doc {
    const doc = docStore.get('ferries');
    if (!doc) throw new Error('doc missing');
    return doc.ydoc;
  }

  function table(): Y.XmlElement {
    const t = prose
      .getProseFragment(liveDoc())
      .toArray()
      .find((n): n is Y.XmlElement => n instanceof Y.XmlElement && n.nodeName === 'table');
    if (!t) throw new Error('no table in the doc');
    return t;
  }

  /** Each row's cells as plain text, header first. */
  function rows(): string[][] {
    return table()
      .toArray()
      .filter((r): r is Y.XmlElement => r instanceof Y.XmlElement && r.nodeName === 'tableRow')
      .map((r) =>
        r
          .toArray()
          .filter((c): c is Y.XmlElement => c instanceof Y.XmlElement)
          .map((c) => textOf(c).trim()),
      );
  }

  /** The text Alice's thread spans now, or null when its anchor no longer resolves. */
  function threadText(): string | null {
    const ydoc = liveDoc();
    const thread = (ydoc.getMap('threads') as Y.Map<Y.Map<unknown>>).get('t-cell');
    const anchor = thread?.get('anchor') as
      | { kind: string; startRel: Uint8Array; endRel: Uint8Array }
      | undefined;
    if (anchor?.kind !== 'text-range') return null;
    const start = Y.createAbsolutePositionFromRelativePosition(
      Y.decodeRelativePosition(anchor.startRel),
      ydoc,
    );
    const end = Y.createAbsolutePositionFromRelativePosition(
      Y.decodeRelativePosition(anchor.endRel),
      ydoc,
    );
    if (!start || !end || start.type !== end.type || !(start.type instanceof Y.XmlText)) {
      return null;
    }
    const text = (start.type.toDelta() as Array<{ insert?: unknown }>)
      .map((op) => (typeof op.insert === 'string' ? op.insert : ''))
      .join('');
    return text.slice(start.index, end.index);
  }

  it('find_and_replace adds a row when replace holds one more pipe row than find', async () => {
    const res = docStore.findAndReplace('ferries', {
      find: '| Saltmarsh | 1 | weekends only |',
      replace: '| Saltmarsh | 1 | weekends only |\n| Riverbend | 3 | daily |',
    });

    expect(res.ok).toBe(true);
    expect(rows()).toEqual([
      ['Route', 'Boats', 'Note'],
      ['Harborlight', '2', 'Riverbend crossing'],
      ['Saltmarsh', '1', 'weekends only'],
      ['Riverbend', '3', 'daily'],
    ]);
    expect(threadText()).toBe('Riverbend');
    await waitFor(() => readFileSync(path, 'utf8').includes('daily'), {
      describe: 'the new row on disk',
    });
    const disk = readFileSync(path, 'utf8');
    expect(disk.split('\n').filter((l) => l.startsWith('|'))).toHaveLength(5);
    expect(disk.indexOf('| Saltmarsh')).toBeLessThan(disk.indexOf('daily'));
  });

  it('a row can be added above the matched row too', () => {
    const res = docStore.findAndReplace('ferries', {
      find: '| Saltmarsh | 1 | weekends only |',
      replace: '| Riverbend | 3 | daily |\n| Saltmarsh | 1 | weekends only |',
    });

    expect(res.ok).toBe(true);
    expect(rows().map((r) => r[0])).toEqual(['Route', 'Harborlight', 'Riverbend', 'Saltmarsh']);
    expect(threadText()).toBe('Riverbend');
  });

  it('editing a cell of the thread’s row while adding a row keeps the thread', () => {
    const res = docStore.findAndReplace('ferries', {
      find: '| Harborlight | 2 | Riverbend crossing |',
      replace: '| Harborlight | 4 | Riverbend crossing |\n| Riverbend | 3 | daily |',
    });

    expect(res.ok).toBe(true);
    expect(rows()).toEqual([
      ['Route', 'Boats', 'Note'],
      ['Harborlight', '4', 'Riverbend crossing'],
      ['Riverbend', '3', 'daily'],
      ['Saltmarsh', '1', 'weekends only'],
    ]);
    expect(threadText()).toBe('Riverbend');
  });

  it('an empty replace removes the matched row, on disk too', async () => {
    const res = docStore.findAndReplace('ferries', {
      find: '| Saltmarsh | 1 | weekends only |',
      replace: '',
    });

    expect(res.ok).toBe(true);
    expect(rows().map((r) => r[0])).toEqual(['Route', 'Harborlight']);
    expect(threadText()).toBe('Riverbend');
    await waitFor(() => !readFileSync(path, 'utf8').includes('Saltmarsh'), {
      describe: 'the removed row gone from disk',
    });
    expect(readFileSync(path, 'utf8')).toContain('| Harborlight');
  });

  it('a replace with a different number of cells per row is still refused, naming the fix', () => {
    const res = docStore.findAndReplace('ferries', {
      find: '| Saltmarsh | 1 | weekends only |',
      replace: '| Saltmarsh | 1 |',
    });

    expect(res.ok).toBe(false);
    expect(res.error).toBe('table-shape-mismatch');
    expect(res.message).toContain('3 cells');
    expect(rows()).toHaveLength(3);
  });

  it('removing every row of a table is refused, naming the verb that removes a table', () => {
    const res = docStore.findAndReplace('ferries', {
      find: '| Route | Boats | Note |\n| Harborlight | 2 | Riverbend crossing |\n| Saltmarsh | 1 | weekends only |',
      replace: '',
    });

    expect(res.ok).toBe(false);
    expect(res.error).toBe('table-shape-mismatch');
    expect(res.message).toContain('delete_block_at_anchor');
    expect(rows()).toHaveLength(3);
  });

  it('insert_blocks_at_anchor on a word in a cell inserts after the table, not into the cell', async () => {
    const anchor = docStore.createAgentAnchor('ferries', { find: 'weekends only' });
    if (!anchor.anchorId) throw new Error(`anchor: ${anchor.error}`);

    const res = docStore.insertBlocksAtAnchor(
      'ferries',
      anchor.anchorId,
      'Summer sailings start in May.',
    );

    expect(res.ok).toBe(true);
    expect(rows()[2]).toEqual(['Saltmarsh', '1', 'weekends only']);
    const top = prose
      .getProseFragment(liveDoc())
      .toArray()
      .map((n) => (n instanceof Y.XmlElement ? `${n.nodeName}: ${textOf(n)}` : ''));
    const at = top.findIndex((s) => s.startsWith('table'));
    expect(top[at + 1]).toBe('paragraph: Summer sailings start in May.');
    expect(threadText()).toBe('Riverbend');
    await waitFor(() => readFileSync(path, 'utf8').includes('Summer sailings'), {
      describe: 'the paragraph on disk',
    });
    const disk = readFileSync(path, 'utf8');
    const lines = disk.split('\n');
    const lastRow = lines.length - 1 - [...lines].reverse().findIndex((l) => l.startsWith('|'));
    expect(lines[lastRow]).toContain('Saltmarsh');
    expect(lines.slice(lastRow + 1, lastRow + 3)).toEqual(['', 'Summer sailings start in May.']);
  });

  it('replace_block on a person’s table stays a suggestion and names find_and_replace for rows', () => {
    const block = docStore.readOutline('ferries')?.blocks.find((b) => b.nodeName === 'table');
    if (!block) throw new Error('no table in the outline');

    const res = docStore.applyBlockEdits(
      'ferries',
      [
        {
          op: 'replace_block',
          blockId: block.id,
          markdown: '| Route | Boats |\n| --- | --- |\n| Harborlight | 2 |',
        },
      ],
      { author: 'a-editor' },
    );

    if (!res.ok) throw new Error(res.error);
    expect(res.outcomes[0]?.status).toBe('suggested');
    expect(res.outcomes[0]?.reason).toContain('find_and_replace');
    expect(threadText()).toBe('Riverbend');
  });
});
