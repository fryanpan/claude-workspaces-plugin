/**
 * A block quote is ONE address.
 *
 * `> some quote` parses to `blockquote > paragraph`, and the outline walk used
 * to hand back both — two entries carrying identical text, with nothing saying
 * one held the other. An agent read that as a duplicate and deleted "the
 * paragraph"; the quote's words went from the doc and from the file, a bare
 * `>` was left where they had been, and the lead-in sentence ending in a colon
 * was left with nothing after it. Twice in one day, once as a suggestion that
 * was then accepted.
 *
 * So these cases are about the ADDRESSES an outline offers, not about the
 * walk's shape: what an agent is handed, and what happens when it edits by
 * each of them.
 */
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { applyBlockEdits } from '../src/prose-batch.ts';
import { claimSubtree, readOutline } from '../src/prose-outline.ts';
import {
  getProseFragment,
  parseMarkdownBlocks,
  serializeFragmentToMarkdown,
} from '../src/prose.ts';

const AGENT = 'quote-taker';
const SUGGESTER = { id: AGENT, name: 'Quote Taker', color: '#7c5cff' };

function docOf(markdown: string): Y.Doc {
  const doc = new Y.Doc();
  getProseFragment(doc).push(parseMarkdownBlocks(markdown));
  return doc;
}

function md(doc: Y.Doc): string {
  return serializeFragmentToMarkdown(getProseFragment(doc));
}

/** Mark every top-level block as the agent's, so a later edit applies
 *  directly rather than becoming a proposal — the ownership question is
 *  tested elsewhere and is not what these cases are about. */
function claimAll(doc: Y.Doc): void {
  for (const el of getProseFragment(doc).toArray() as Y.XmlElement[]) claimSubtree(el, AGENT);
}

function apply(doc: Y.Doc, edits: Parameters<typeof applyBlockEdits>[1]) {
  return applyBlockEdits(doc, edits, { author: AGENT, suggestionAuthor: SUGGESTER });
}

/** The editor's own shape for a quote a person split with Enter: the parser
 *  never builds this, y-prosemirror does. */
function paragraph(text: string): Y.XmlElement {
  const p = new Y.XmlElement('paragraph');
  const t = new Y.XmlText();
  t.insert(0, text);
  p.insert(0, [t]);
  return p;
}

describe('a block quote in the outline', () => {
  it('is one entry, not the quote and its paragraph reading the same words', () => {
    const doc = docOf('Here is what they said:\n\n> Some quote worth keeping.\n\nAnd more.\n');
    const entries = readOutline(doc);
    expect(entries.map((e) => e.nodeName)).toEqual(['paragraph', 'blockquote', 'paragraph']);
    expect(entries.filter((e) => e.text === 'Some quote worth keeping.')).toHaveLength(1);
  });

  it('is still one entry when the editor built it out of several paragraphs', () => {
    // No entry may repeat another's words, and the one entry has to carry all
    // of them — it is the only place a reader can learn what the quote says.
    const doc = new Y.Doc();
    const quote = new Y.XmlElement('blockquote');
    quote.insert(0, [paragraph('First paragraph.'), paragraph('Second paragraph.')]);
    getProseFragment(doc).push([quote]);

    const entries = readOutline(doc);
    expect(entries.map((e) => e.nodeName)).toEqual(['blockquote']);
    expect(entries[0]?.text).toBe('First paragraph. Second paragraph.');
  });

  it('still addresses a list inside it per item', () => {
    // The quote's own words are the quote's; a list in it is a structure with
    // entries of its own, so the walk goes on into it.
    const doc = new Y.Doc();
    const item = (text: string): Y.XmlElement => {
      const li = new Y.XmlElement('listItem');
      li.insert(0, [paragraph(text)]);
      return li;
    };
    const list = new Y.XmlElement('bulletList');
    list.insert(0, [item('point one'), item('point two')]);
    const quote = new Y.XmlElement('blockquote');
    quote.insert(0, [paragraph('They listed two things.'), list]);
    getProseFragment(doc).push([quote]);

    const entries = readOutline(doc);
    expect(entries.map((e) => e.text)).toEqual([
      'They listed two things.',
      'point one',
      'point two',
    ]);
    // And the quote's preview does not re-print what those items already say.
    expect(entries[0]?.text).not.toContain('point one');
  });

  it('keeps the quote when every other id the outline gave is deleted', () => {
    // The property the loss broke: an agent deleting by ANY address the
    // outline handed it can only lose the quote by naming the quote.
    const doc = docOf('Here is what they said:\n\n> Some quote worth keeping.\n\nAnd more.\n');
    claimAll(doc);
    for (const entry of readOutline(doc)) {
      if (entry.nodeName === 'blockquote') continue;
      expect(apply(doc, [{ op: 'delete_block', blockId: entry.id }]).applied).toBe(1);
    }
    expect(md(doc)).toBe('> Some quote worth keeping.\n');
  });

  it('deletes the whole quote when the quote itself is named', () => {
    const doc = docOf('Here is what they said:\n\n> Some quote worth keeping.\n');
    claimAll(doc);
    const quoteId = readOutline(doc).find((e) => e.nodeName === 'blockquote')?.id as string;
    expect(apply(doc, [{ op: 'delete_block', blockId: quoteId }]).applied).toBe(1);
    expect(md(doc)).toBe('Here is what they said:\n');
  });

  it('rewrites a multi-paragraph quote as a whole through its own id', () => {
    // A quote is editable AS A WHOLE, not paragraph by paragraph — this is
    // the call the walk makes, and this is how a paragraph inside one is
    // changed.
    const doc = docOf('> First.\n>\n> Second.\n');
    claimAll(doc);
    const quoteId = readOutline(doc).find((e) => e.nodeName === 'blockquote')?.id as string;
    expect(
      apply(doc, [{ op: 'replace_block', blockId: quoteId, markdown: '> First.\n>\n> Revised.\n' }])
        .applied,
    ).toBe(1);
    expect(md(doc)).toBe('> First.\n>\n> Revised.\n');
    expect(readOutline(doc).map((e) => e.text)).toEqual(['First. Revised.']);
  });

  it('refuses an id minted for a paragraph inside a quote before this rule', () => {
    // Ids already handed out live in the `.ydoc`, so an agent may still come
    // back with one. It addresses nothing now, and a refusal naming the block
    // is the answer — the batch reports it and lands everything else, which is
    // what the old behaviour could not do: it emptied the quote and said
    // `applied`.
    const doc = docOf('Here is what they said:\n\n> Some quote worth keeping.\n');
    claimAll(doc);
    const quote = getProseFragment(doc).get(1) as Y.XmlElement;
    const inner = quote.get(0) as Y.XmlElement;
    doc.transact(() => inner.setAttribute('cwId', 'bstale-inner-id'));

    const res = apply(doc, [
      { op: 'delete_block', blockId: 'bstale-inner-id' },
      { op: 'insert_at_end', markdown: 'Landed anyway.' },
    ]);
    expect(res.outcomes[0]).toMatchObject({ status: 'failed', error: 'unknown-block' });
    expect(md(doc)).toBe(
      'Here is what they said:\n\n> Some quote worth keeping.\n\nLanded anyway.\n',
    );
  });
});
