/**
 * `replace_block` with markdown that holds an image, aimed at a block the
 * caller does not own.
 *
 * Such an edit becomes a proposal, and a proposal is made of suggestion marks
 * on text. An image has no text to mark, so the whole edit used to fail, and
 * the only route left to an agent was a whole-doc rewrite over the person's
 * concurrent edits. Now the image is written directly, as an insert would
 * be, and the person's words are struck as a proposal they can accept or
 * reject. Nothing a person wrote is removed until they accept.
 *
 * Fixtures are synthetic. The repo is public.
 */
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { type BlockEdit, applyBlockEdits } from './prose-batch.ts';
import { getProseFragment } from './prose-fragment.ts';
import { parseMarkdownBlocks, serializeFragmentToMarkdown } from './prose-markdown.ts';
import { ensureBlockIds, readOutline } from './prose-outline.ts';
import { acceptSuggestion, listSuggestions, rejectSuggestion } from './suggest-ops.ts';

const AGENT = 'agent:charts';
const SUGGESTER = { id: AGENT, name: 'Charts', color: '#4a90d9' };

function docOf(markdown: string): Y.Doc {
  const doc = new Y.Doc();
  getProseFragment(doc).insert(0, parseMarkdownBlocks(markdown));
  ensureBlockIds(doc);
  return doc;
}

const md = (doc: Y.Doc): string => serializeFragmentToMarkdown(getProseFragment(doc)).trimEnd();
const apply = (doc: Y.Doc, edits: BlockEdit[]) =>
  applyBlockEdits(doc, edits, { author: AGENT, suggestionAuthor: SUGGESTER });
const idOf = (doc: Y.Doc, needle: string): string => {
  const found = readOutline(doc).find((e) => e.text.includes(needle));
  if (!found) throw new Error(`no block reading ${needle}`);
  return found.id;
};

const names = (doc: Y.Doc): string[] =>
  (getProseFragment(doc).toArray() as Y.XmlElement[]).map((el) => el.nodeName);

const FIXTURE = 'Riverbend tides.\n\nChart goes here, Alice wrote.\n\nBob added this line.\n';
const IMAGE = '![Riverbend tides](img/tides.png){width=480}';

describe('a person’s paragraph replaced by an image', () => {
  it('writes the image directly and strikes the words as a proposal', () => {
    const doc = docOf(FIXTURE);
    const res = apply(doc, [
      { op: 'replace_block', blockId: idOf(doc, 'Chart goes here'), markdown: IMAGE },
    ]);
    expect(res.failed).toBe(0);
    expect(res.outcomes[0]).toMatchObject({ status: 'suggested' });
    expect(res.outcomes[0]?.reason).toContain('image');
    // The image is accepted content at once; the words stay until accepted.
    expect(md(doc)).toBe(
      `Riverbend tides.\n\nChart goes here, Alice wrote.\n\n${IMAGE}\n\nBob added this line.`,
    );
    expect(listSuggestions(doc)).toHaveLength(1);
  });

  it('accepting removes the words and leaves the image where they were', () => {
    const doc = docOf(FIXTURE);
    const res = apply(doc, [
      { op: 'replace_block', blockId: idOf(doc, 'Chart goes here'), markdown: IMAGE },
    ]);
    acceptSuggestion(doc, res.outcomes[0]?.suggestionId as string);
    expect(md(doc)).toBe(`Riverbend tides.\n\n${IMAGE}\n\nBob added this line.`);
    expect(names(doc)).toEqual(['paragraph', 'image', 'paragraph']);
  });

  it('rejecting keeps the words; the image stays, as an insert would', () => {
    const doc = docOf(FIXTURE);
    const res = apply(doc, [
      { op: 'replace_block', blockId: idOf(doc, 'Chart goes here'), markdown: IMAGE },
    ]);
    rejectSuggestion(doc, res.outcomes[0]?.suggestionId as string);
    expect(md(doc)).toBe(
      `Riverbend tides.\n\nChart goes here, Alice wrote.\n\n${IMAGE}\n\nBob added this line.`,
    );
  });

  it('words beside the image are offered; accepting gives the whole replacement', () => {
    const doc = docOf(FIXTURE);
    const res = apply(doc, [
      {
        op: 'replace_block',
        blockId: idOf(doc, 'Chart goes here'),
        markdown: `Tide chart for March.\n\n${IMAGE}`,
      },
    ]);
    expect(res.outcomes[0]).toMatchObject({ status: 'suggested' });
    acceptSuggestion(doc, res.outcomes[0]?.suggestionId as string);
    expect(md(doc)).toBe(
      `Riverbend tides.\n\nTide chart for March.\n\n${IMAGE}\n\nBob added this line.`,
    );
    expect(names(doc)).toEqual(['paragraph', 'paragraph', 'image', 'paragraph']);
  });

  it('a rule in the replacement still fails whole', () => {
    const doc = docOf(FIXTURE);
    const before = md(doc);
    const res = apply(doc, [
      { op: 'replace_block', blockId: idOf(doc, 'Chart goes here'), markdown: `${IMAGE}\n\n---` },
    ]);
    expect(res.outcomes[0]).toMatchObject({ status: 'failed', error: 'suggest-failed' });
    expect(md(doc)).toBe(before);
    expect(listSuggestions(doc)).toEqual([]);
  });
});
