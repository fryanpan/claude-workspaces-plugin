import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { applyBlockEdits } from './prose-batch.ts';
import { deleteBlockAtAnchor, deleteBlocksInRange, deleteSection } from './prose-blocks.ts';
import { getProseFragment, walkProse } from './prose-fragment.ts';
import { parseMarkdownBlocks, serializeBlockToMarkdown } from './prose-markdown.ts';
import {
  addressableBlocks,
  ensureBlockIds,
  readBlockAuthor,
  readBlockId,
  readOutline,
  setBlockAuthor,
} from './prose-outline.ts';
import { listSuggestions, suggestReplace } from './suggest-ops.ts';

/**
 * An agent moving a section with the doc tools, and a doc already holding
 * copies of one block id.
 *
 * The agent's move is two calls: write a copy under another heading, then
 * delete the original. What it can copy is what it read — a block's markdown
 * (the accepted text: "take the ferry") or the doc's plain text (both words
 * of a replace run together: "take the ferrybridge") — so neither copy holds
 * the proposal, and the delete was where the proposal went. Fixtures are
 * fictional.
 */

const AGENT = 'agent:harborlight';
const SUGGESTER = { id: 'agent:kiln', name: 'Kiln', color: '#aa5500' };

function mountDoc(): Y.Doc {
  const doc = new Y.Doc();
  getProseFragment(doc).push(
    parseMarkdownBlocks(
      '## Riverbend\n\n- dock opens\n- take the ferry\n\nSaltmarsh closes.\n\n## Kiln\n\nLast words.\n',
    ),
  );
  const res = suggestReplace(doc, { find: 'ferry', replace: 'bridge', author: SUGGESTER });
  if (!res.ok) throw new Error(`fixture suggestion failed: ${res.error}`);
  return doc;
}

/** The Riverbend section's blocks, as `serialize` renders each. */
function sectionText(doc: Y.Doc, serialize: (el: Y.XmlElement) => string): string {
  const top = getProseFragment(doc).toArray() as Y.XmlElement[];
  const end = top.findIndex((el, i) => i > 0 && el.nodeName === 'heading');
  return top
    .slice(1, end)
    .map((el) => serialize(el))
    .join('\n\n');
}

function moveUnderKiln(doc: Y.Doc, markdown: string) {
  const kiln = readOutline(doc, { headingsOnly: true }).find((e) => e.text === 'Kiln');
  if (!kiln) throw new Error('no Kiln heading');
  const res = applyBlockEdits(doc, [{ op: 'insert_under_heading', headingId: kiln.id, markdown }], {
    author: AGENT,
    suggestionAuthor: SUGGESTER,
  });
  expect(res.outcomes[0]?.status).toBe('applied');
}

function pendingReplace(doc: Y.Doc) {
  return listSuggestions(doc).map((s) => [s.kind, s.deletedText, s.insertedText]);
}

describe('an agent moving a section that holds a pending replace', () => {
  it('copying the blocks as markdown, delete_section is refused and the proposal stays pending', () => {
    const doc = mountDoc();
    moveUnderKiln(doc, sectionText(doc, serializeBlockToMarkdown));
    const res = deleteSection(doc, { heading: 'Riverbend' });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('holds-pending-suggestion');
    expect(res.reason).toContain('reject_suggestion');
    expect(pendingReplace(doc)).toEqual([['replace', 'ferry', 'bridge']]);
  });

  it('copying the plain text, delete_blocks_in_range is refused and never leaves only "ferrybridge"', () => {
    const doc = mountDoc();
    const plain = walkProse(getProseFragment(doc)).plainText;
    expect(plain).toContain('take the ferrybridge');
    moveUnderKiln(doc, '- take the ferrybridge');
    const res = deleteBlocksInRange(doc, { startFind: 'dock opens', endFind: 'Saltmarsh closes.' });
    expect(res.error).toBe('holds-pending-suggestion');
    expect(pendingReplace(doc)).toEqual([['replace', 'ferry', 'bridge']]);
  });

  it('delete_block_at_anchor on the item holding it is refused too', () => {
    const doc = mountDoc();
    const seg = walkProse(getProseFragment(doc)).segments.find((s) =>
      s.node.toString().includes('take the'),
    );
    if (!seg) throw new Error('no ferry segment');
    const anchorRel = Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(seg.node, 0));
    expect(deleteBlockAtAnchor(doc, { anchorRel }).error).toBe('holds-pending-suggestion');
    expect(pendingReplace(doc)).toEqual([['replace', 'ferry', 'bridge']]);
  });

  it('a section with no pending suggestion still deletes', () => {
    const doc = new Y.Doc();
    getProseFragment(doc).push(parseMarkdownBlocks('## Riverbend\n\nDock.\n\n## Kiln\n\nEnd.\n'));
    expect(deleteSection(doc, { heading: 'Riverbend' })).toMatchObject({ ok: true, deleted: 2 });
  });

  it('the move itself gives no two blocks one id', () => {
    const doc = mountDoc();
    moveUnderKiln(doc, sectionText(doc, serializeBlockToMarkdown));
    ensureBlockIds(doc);
    const ids = addressableBlocks(getProseFragment(doc)).map(readBlockId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('a doc already holding copies of one block id', () => {
  it('reading the outline gives each copy an id of its own and drops the author it copied', () => {
    const doc = new Y.Doc();
    getProseFragment(doc).push(parseMarkdownBlocks('- dock\n- ferry\n- kiln\n'));
    ensureBlockIds(doc);
    const items = addressableBlocks(getProseFragment(doc)).filter(
      (el) => el.nodeName === 'listItem',
    );
    const shared = readBlockId(items[0] as Y.XmlElement) as string;
    for (const item of items) {
      item.setAttribute('cwId', shared);
      setBlockAuthor(item, AGENT);
    }

    const entries = readOutline(doc).filter((e) => e.kind === 'listItem');
    expect(new Set(entries.map((e) => e.id)).size).toBe(3);
    expect(entries[0]?.id).toBe(shared);
    expect(items.map(readBlockAuthor)).toEqual([AGENT, undefined, undefined]);
  });
});
