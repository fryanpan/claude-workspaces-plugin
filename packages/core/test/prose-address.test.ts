/**
 * Block addresses: an outline read writes nothing, and a server write stores
 * the ids of the blocks it creates. All text is invented.
 */
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { BLOCK_IDS_ORIGIN, storeBlockIdsOnWrite } from '../src/prose-address.ts';
import { getProseFragment } from '../src/prose-fragment.ts';
import { parseMarkdownBlocks } from '../src/prose-markdown.ts';
import { addressableBlocks, readBlockId, readOutline } from '../src/prose-outline.ts';

const PERSON = { kind: 'socket' };

function docOf(markdown: string): Y.Doc {
  const doc = new Y.Doc();
  getProseFragment(doc).push(parseMarkdownBlocks(markdown));
  return doc;
}

function origins(doc: Y.Doc): unknown[] {
  const seen: unknown[] = [];
  doc.on('afterTransaction', (txn: Y.Transaction) => seen.push(txn.origin));
  return seen;
}

describe('storeBlockIdsOnWrite', () => {
  it('stores an id on a block a server write creates, under its own origin', () => {
    const doc = docOf('## Riverbend\n\nA line.\n');
    const stop = storeBlockIdsOnWrite(doc);
    const seen = origins(doc);
    doc.transact(() => {
      getProseFragment(doc).push(parseMarkdownBlocks('A line read back from disk.'));
    }, 'file-watch');
    stop();
    expect(seen).toEqual(['file-watch', BLOCK_IDS_ORIGIN]);
    const blocks = addressableBlocks(getProseFragment(doc));
    expect(blocks.map((el) => readBlockId(el) !== undefined)).toEqual([true, true, true]);
    // The stored ids are the addresses an outline already handed out.
    expect(readOutline(doc).map((e) => e.id)).toEqual(blocks.map((el) => readBlockId(el)));
  });

  it("leaves a person's own change alone: the editor stamps its blocks", () => {
    const doc = docOf('A line.\n');
    const stop = storeBlockIdsOnWrite(doc);
    const seen = origins(doc);
    doc.transact(() => getProseFragment(doc).push(parseMarkdownBlocks('From Alice.')), PERSON);
    stop();
    expect(seen).toEqual([PERSON]);
  });

  it('answers typing inside a block with no write at all', () => {
    const doc = docOf('A line.\n');
    const stop = storeBlockIdsOnWrite(doc);
    const seen = origins(doc);
    const paragraph = getProseFragment(doc).get(0) as Y.XmlElement;
    doc.transact(() => (paragraph.get(0) as Y.XmlText).insert(0, 'Bob says: '), 'agent');
    stop();
    // Yjs may run a text-cleanup transaction of its own; none is ours.
    expect(seen).not.toContain(BLOCK_IDS_ORIGIN);
    expect(readBlockId(paragraph)).toBeUndefined();
  });

  it('keeps a stored id through a re-create that copies the attributes', () => {
    const doc = docOf('A line.\n');
    const stop = storeBlockIdsOnWrite(doc);
    const fragment = getProseFragment(doc);
    doc.transact(() => fragment.push(parseMarkdownBlocks('Saltmarsh note.')), 'agent');
    const id = readBlockId(fragment.get(1) as Y.XmlElement) as string;
    // What the editor does when it cannot edit a block in place: a new
    // element carrying the old one's attributes, the old one deleted.
    doc.transact(() => {
      const next = new Y.XmlElement('paragraph');
      next.setAttribute('cwId', id);
      next.insert(0, [new Y.XmlText('Saltmarsh note, reworded.')]);
      fragment.delete(1, 1);
      fragment.insert(1, [next]);
    }, PERSON);
    stop();
    expect(readOutline(doc).find((e) => e.text === 'Saltmarsh note, reworded.')?.id).toBe(id);
  });
});
