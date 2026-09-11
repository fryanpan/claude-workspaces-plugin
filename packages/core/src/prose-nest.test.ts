/**
 * Whether a regroup can still be made out of what the model was shown.
 *
 * `readOutline` describes a bullet by its heading and its depth, and says
 * nothing about which list ELEMENT holds it — so two bullets under one topic
 * read as siblings whether they are or not. They stop being siblings the
 * moment anything that is not a bullet lands between them: the next insert
 * opens a second list, and a `nest_blocks` naming one bullet from each
 * answered `nothing-to-nest` with nothing in the doc or the prompt to say
 * why. Measured on an hour of AMI EN2001a: seventeen of the run's
 * twenty-four failed edits, and ten of those the same regroup re-issued tick
 * after tick.
 *
 * So the cases below are about the reach — what it crosses, what stops it,
 * and that a regroup already made is not a failure. The refusals are as
 * important as the reaches: a person's paragraph in the middle of the notes
 * and the next topic's heading both have to stop it, or this fix restructures
 * writing that is not the note-taker's to move.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { applyBlockEdits } from './prose-batch.ts';
import { getProseFragment } from './prose-fragment.ts';
import { setBlockAuthor } from './prose-identity.ts';
import { parseMarkdownBlocks, serializeFragmentToMarkdown } from './prose-markdown.ts';
import { findBlockById, readOutline } from './prose-outline.ts';

const AGENT = 'meeting-notes';
const SUGGESTER = { id: AGENT, name: 'Meeting Assistant', color: '#7c5cff' };

const apply = (doc: Y.Doc, edits: Parameters<typeof applyBlockEdits>[1]) =>
  applyBlockEdits(doc, edits, { author: AGENT, suggestionAuthor: SUGGESTER });

const md = (doc: Y.Doc): string => serializeFragmentToMarkdown(getProseFragment(doc)).trimEnd();

/** A doc whose every block is already the note-taker's own — the state a
 *  meeting reaches after a few ticks of writing into its own section. */
function notesDoc(markdown: string): Y.Doc {
  const doc = new Y.Doc();
  getProseFragment(doc).insert(0, parseMarkdownBlocks(markdown));
  for (const entry of readOutline(doc)) {
    const el = findBlockById(getProseFragment(doc), entry.id);
    if (el) setBlockAuthor(el, AGENT);
  }
  return doc;
}

/** The id of the bullet reading `needle`. */
const idOf = (doc: Y.Doc, needle: string): string => {
  const found = readOutline(doc).find((e) => e.text.includes(needle));
  if (!found) throw new Error(`no block reading ${needle}`);
  return found.id;
};

/** The top-level shape, which is the only place a split list is visible. */
const shape = (doc: Y.Doc): string[] =>
  (getProseFragment(doc).toArray() as Y.XmlElement[]).map((el) => el.nodeName);

describe('a topic split into two lists', () => {
  it('reaches across a paragraph the note-taker itself wrote', () => {
    const doc = notesDoc(
      '## Meeting notes\n\n### Case design\n\n- one\n- two\n\nA paragraph note.\n\n- three\n',
    );
    // The split is real, and nothing in the outline shows it.
    expect(shape(doc)).toEqual(['heading', 'heading', 'bulletList', 'paragraph', 'bulletList']);
    const items = readOutline(doc).filter((e) => e.kind === 'listItem');
    expect(items.map((e) => e.depth)).toEqual([0, 0, 0]);

    const res = apply(doc, [
      { op: 'nest_blocks', leadBlockId: idOf(doc, 'one'), blockIds: [idOf(doc, 'three')] },
    ]);
    expect(res.outcomes).toEqual([{ op: 'nest_blocks', status: 'applied' }]);
    expect(md(doc)).toBe(
      '## Meeting notes\n\n### Case design\n\n- one\n  - three\n- two\n\nA paragraph note.',
    );
  });

  it('takes the emptied list away with it', () => {
    const doc = notesDoc('## Meeting notes\n\n- one\n- two\n\nA paragraph note.\n\n- three\n');
    apply(doc, [
      { op: 'nest_blocks', leadBlockId: idOf(doc, 'one'), blockIds: [idOf(doc, 'three')] },
    ]);
    // One list, not two with a blank one trailing.
    expect(shape(doc)).toEqual(['heading', 'bulletList', 'paragraph']);
  });

  it('gathers from both lists in document order, not the order named', () => {
    const doc = notesDoc('## Meeting notes\n\n- one\n- two\n\nA paragraph note.\n\n- three\n');
    apply(doc, [
      {
        op: 'nest_blocks',
        leadBlockId: idOf(doc, 'one'),
        blockIds: [idOf(doc, 'three'), idOf(doc, 'two')],
      },
    ]);
    expect(md(doc)).toBe('## Meeting notes\n\n- one\n  - two\n  - three\n\nA paragraph note.');
  });

  it('crosses a list of the other kind without gathering from it', () => {
    const doc = notesDoc('## Meeting notes\n\n- one\n- two\n\n1. numbered\n\n- three\n');
    const res = apply(doc, [
      {
        op: 'nest_blocks',
        leadBlockId: idOf(doc, 'one'),
        blockIds: [idOf(doc, 'three'), idOf(doc, 'numbered')],
      },
    ]);
    expect(res.outcomes).toEqual([{ op: 'nest_blocks', status: 'applied' }]);
    expect(md(doc)).toBe('## Meeting notes\n\n- one\n  - three\n- two\n\n1. numbered');
  });
});

describe('what stops the reach', () => {
  it("a person's paragraph between the two lists — their writing stays put", () => {
    const doc = notesDoc('## Meeting notes\n\n- one\n- two\n');
    const fragment = getProseFragment(doc);
    // Unclaimed, and not blank: a line somebody typed into the notes.
    fragment.insert(fragment.length, parseMarkdownBlocks('I disagree with that.\n\n- three\n'));
    const before = md(doc);
    const res = apply(doc, [
      { op: 'nest_blocks', leadBlockId: idOf(doc, 'one'), blockIds: [idOf(doc, 'three')] },
    ]);
    expect(res.outcomes).toEqual([
      { op: 'nest_blocks', status: 'failed', error: 'nothing-to-nest' },
    ]);
    expect(md(doc)).toBe(before);
  });

  it("a person's paragraph, with the note-taker's own bullets on both sides", () => {
    // The case the reach exists for, inverted: everything either side is the
    // note-taker's, and the one line between them is not. This is the test the
    // person's-paragraph case above does NOT make — there the bullet was
    // unowned too, so the per-member authorship check refused it and this
    // guard was never asked.
    const doc = notesDoc('## Meeting notes\n\n- one\n- two\n');
    const fragment = getProseFragment(doc);
    fragment.insert(fragment.length, parseMarkdownBlocks('I disagree with that.\n\n- three\n'));
    // Everything but the paragraph is the note-taker's again.
    for (const entry of readOutline(doc)) {
      if (entry.kind !== 'listItem') continue;
      const el = findBlockById(fragment, entry.id);
      if (el) setBlockAuthor(el, AGENT);
    }
    const before = md(doc);
    const res = apply(doc, [
      { op: 'nest_blocks', leadBlockId: idOf(doc, 'one'), blockIds: [idOf(doc, 'three')] },
    ]);
    expect(res.outcomes).toEqual([
      { op: 'nest_blocks', status: 'failed', error: 'nothing-to-nest' },
    ]);
    expect(md(doc)).toBe(before);
  });

  it("the next topic's heading — one topic is not the other's to regroup", () => {
    const doc = notesDoc(
      '## Meeting notes\n\n### Case design\n\n- one\n- two\n\n### Cost\n\n- three\n',
    );
    const before = md(doc);
    const res = apply(doc, [
      { op: 'nest_blocks', leadBlockId: idOf(doc, 'one'), blockIds: [idOf(doc, 'three')] },
    ]);
    expect(res.outcomes).toEqual([
      { op: 'nest_blocks', status: 'failed', error: 'nothing-to-nest' },
    ]);
    expect(md(doc)).toBe(before);
  });

  it('a bullet in the other list that a person owns', () => {
    const doc = notesDoc('## Meeting notes\n\n- one\n- two\n\nA paragraph note.\n\n- three\n');
    const theirs = findBlockById(getProseFragment(doc), idOf(doc, 'three'));
    theirs?.removeAttribute('cwAuthor');
    const before = md(doc);
    const res = apply(doc, [
      { op: 'nest_blocks', leadBlockId: idOf(doc, 'one'), blockIds: [idOf(doc, 'three')] },
    ]);
    expect(res.outcomes).toEqual([
      { op: 'nest_blocks', status: 'failed', error: 'nothing-to-nest' },
    ]);
    expect(md(doc)).toBe(before);
  });
});

describe('a regroup that has already been made', () => {
  it('is applied and moves nothing, rather than failing', () => {
    const doc = notesDoc('## Meeting notes\n\n- lead\n    - sub one\n    - sub two\n');
    const before = md(doc);
    const res = apply(doc, [
      {
        op: 'nest_blocks',
        leadBlockId: idOf(doc, 'lead'),
        blockIds: [idOf(doc, 'sub one'), idOf(doc, 'sub two')],
      },
    ]);
    expect(res.outcomes).toEqual([{ op: 'nest_blocks', status: 'applied' }]);
    expect(md(doc)).toBe(before);
  });

  it('still fails when the named bullets are somewhere else entirely — the control', () => {
    const doc = notesDoc('## Meeting notes\n\n- lead\n    - sub one\n\n### Cost\n\n- elsewhere\n');
    const res = apply(doc, [
      { op: 'nest_blocks', leadBlockId: idOf(doc, 'lead'), blockIds: [idOf(doc, 'elsewhere')] },
    ]);
    expect(res.outcomes).toEqual([
      { op: 'nest_blocks', status: 'failed', error: 'nothing-to-nest' },
    ]);
  });
});

describe('the ordinary single-list regroup', () => {
  it('still moves siblings under their lead — the control', () => {
    const doc = notesDoc('## Meeting notes\n\n- lead\n- one\n- two\n- three\n');
    const res = apply(doc, [
      {
        op: 'nest_blocks',
        leadBlockId: idOf(doc, 'lead'),
        blockIds: [idOf(doc, 'two'), idOf(doc, 'one')],
      },
    ]);
    expect(res.outcomes).toEqual([{ op: 'nest_blocks', status: 'applied' }]);
    expect(md(doc)).toBe('## Meeting notes\n\n- lead\n  - one\n  - two\n- three');
  });

  it('refuses a lead that is not a list item at all', () => {
    const doc = notesDoc('## Meeting notes\n\n- one\n');
    const res = apply(doc, [
      {
        op: 'nest_blocks',
        leadBlockId: idOf(doc, 'Meeting notes'),
        blockIds: [idOf(doc, 'one')],
      },
    ]);
    expect(res.outcomes).toEqual([
      { op: 'nest_blocks', status: 'failed', error: 'not-a-list-item' },
    ]);
  });
});
