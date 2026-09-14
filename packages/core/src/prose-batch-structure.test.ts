/**
 * What `applyBlockEdits` leaves AROUND an edit: the bullets nested under the
 * one it replaced, the blank line a browser keeps at the end of the doc, and a
 * blank block somebody asks to remove.
 *
 * Each case is a shape a live meeting left in a real doc on 2026-09-14:
 *
 * - a lead bullet rewritten with `replace_block`, and the three notes nested
 *   under it gone with it — the meeting's main point among them;
 * - eight empty paragraphs under the notes heading, one stranded above every
 *   heading the note-taker opened, because each insert landed AFTER the
 *   editor's trailing paragraph and the editor then added another;
 * - an agent unable to remove those paragraphs at all: a delete naming one
 *   answered `no-range`, because a block with no words cannot carry the
 *   strike-through a proposal is made of.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { applyBlockEdits } from './prose-batch.ts';
import { getProseFragment } from './prose-fragment.ts';
import { parseMarkdownBlocks, serializeFragmentToMarkdown } from './prose-markdown.ts';
import { readOutline } from './prose-outline.ts';

const AGENT = 'meeting-notes';
const SUGGESTER = { id: AGENT, name: 'Meeting Assistant', color: '#7c5cff' };

function docOf(markdown: string): Y.Doc {
  const doc = new Y.Doc();
  getProseFragment(doc).insert(0, parseMarkdownBlocks(markdown));
  return doc;
}

const md = (doc: Y.Doc): string => serializeFragmentToMarkdown(getProseFragment(doc)).trimEnd();

const apply = (doc: Y.Doc, edits: Parameters<typeof applyBlockEdits>[1], author = AGENT) =>
  applyBlockEdits(doc, edits, { author, suggestionAuthor: { ...SUGGESTER, id: author } });

const idOf = (doc: Y.Doc, needle: string): string => {
  const found = readOutline(doc).find((e) => e.text.includes(needle));
  if (!found) throw new Error(`no block reading ${needle}`);
  return found.id;
};

/** What the editor's TrailingNode does: an empty, unclaimed paragraph after
 *  the last block whenever the last block is not already one. */
function browserTrailingParagraph(doc: Y.Doc): void {
  const fragment = getProseFragment(doc);
  const last = fragment.get(fragment.length - 1);
  if (last instanceof Y.XmlElement && last.nodeName === 'paragraph' && last.length === 0) return;
  doc.transact(() => fragment.insert(fragment.length, [new Y.XmlElement('paragraph')]), 'browser');
}

/** Node names of the top-level blocks, with empty paragraphs spelled out —
 *  the serializer drops them, which is how eight of them went unseen. */
function shape(doc: Y.Doc): string[] {
  return (getProseFragment(doc).toArray() as Y.XmlElement[]).map((el) =>
    el.nodeName === 'paragraph' && el.length === 0 ? '(blank)' : el.nodeName,
  );
}

describe('a replace of a bullet with notes nested under it', () => {
  it('keeps the nested notes under the rewritten bullet', () => {
    const doc = docOf('## Meeting notes\n');
    apply(doc, [
      {
        op: 'insert_at_end',
        markdown:
          '- Harbour queue needs a summary\n  - Slipway items pile up\n  - Ferry items are urgent\n  - Crew cannot see sizes',
      },
    ]);
    const res = apply(doc, [
      {
        op: 'replace_block',
        blockId: idOf(doc, 'Harbour queue'),
        markdown: '- **Question:** How should the harbour queue show its size?',
      },
    ]);
    expect(res.applied).toBe(1);
    expect(md(doc)).toBe(
      [
        '## Meeting notes',
        '',
        '- **Question:** How should the harbour queue show its size?',
        '  - Slipway items pile up',
        '  - Ferry items are urgent',
        '  - Crew cannot see sizes',
      ].join('\n'),
    );
  });

  it('keeps the nested notes the replacement does not already carry, once each', () => {
    const doc = docOf('## Meeting notes\n');
    apply(doc, [
      {
        op: 'insert_at_end',
        markdown: '- Harbour queue\n  - Slipway items pile up\n  - Ferry items',
      },
    ]);
    apply(doc, [
      {
        op: 'replace_block',
        blockId: idOf(doc, 'Harbour queue'),
        markdown: '- Harbour queue sizing\n  - Slipway items pile up',
      },
    ]);
    expect(md(doc)).toBe(
      [
        '## Meeting notes',
        '',
        '- Harbour queue sizing',
        '  - Slipway items pile up',
        '  - Ferry items',
      ].join('\n'),
    );
  });

  it('the nested notes keep their ids, so a later edit still finds them', () => {
    const doc = docOf('## Meeting notes\n');
    apply(doc, [{ op: 'insert_at_end', markdown: '- Harbour queue\n  - Slipway items pile up' }]);
    const child = idOf(doc, 'Slipway');
    apply(doc, [
      {
        op: 'replace_block',
        blockId: idOf(doc, 'Harbour queue'),
        markdown: '- Harbour queue size',
      },
    ]);
    expect(readOutline(doc).find((e) => e.id === child)?.text).toBe('Slipway items pile up');
  });

  it('a nested note the replacement restates keeps its id, so a comment on it still lands', () => {
    const doc = docOf('## Meeting notes\n');
    apply(doc, [
      {
        op: 'insert_at_end',
        markdown: '- Harbour queue\n  - Slipway items pile up\n  - Ferry items',
      },
    ]);
    const slipway = idOf(doc, 'Slipway');
    const ferry = idOf(doc, 'Ferry');
    apply(doc, [
      {
        op: 'replace_block',
        blockId: idOf(doc, 'Harbour queue'),
        markdown: '- Harbour queue sizing\n  - Slipway items pile up',
      },
    ]);
    const after = readOutline(doc);
    expect(after.filter((e) => e.text === 'Slipway items pile up').map((e) => e.id)).toEqual([
      slipway,
    ]);
    expect(after.find((e) => e.id === ferry)?.text).toBe('Ferry items');
    expect(md(doc)).toBe(
      [
        '## Meeting notes',
        '',
        '- Harbour queue sizing',
        '  - Slipway items pile up',
        '  - Ferry items',
      ].join('\n'),
    );
  });
});

describe("an insert beside the editor's trailing paragraph", () => {
  it('lands before it, so no blank line is stranded above the new heading', () => {
    const doc = docOf('## Meeting notes\n\n- Slipway opens in May\n');
    browserTrailingParagraph(doc);
    apply(doc, [{ op: 'insert_at_end', markdown: '### Ferry timetable\n\n- Two sailings a day' }]);
    browserTrailingParagraph(doc);
    const headingId = idOf(doc, 'Meeting notes');
    apply(doc, [
      { op: 'insert_under_heading', headingId, markdown: '### Crew rota\n\n- Rota is weekly' },
    ]);
    browserTrailingParagraph(doc);
    expect(shape(doc)).toEqual([
      'heading',
      'bulletList',
      'heading',
      'bulletList',
      'heading',
      'bulletList',
      '(blank)',
    ]);
  });

  it('a blank line a person left between two blocks stays where it is', () => {
    const doc = docOf('## Meeting notes\n');
    const fragment = getProseFragment(doc);
    fragment.insert(fragment.length, [new Y.XmlElement('paragraph')]);
    fragment.insert(fragment.length, parseMarkdownBlocks('Their own paragraph'));
    apply(doc, [{ op: 'insert_at_end', markdown: '### Ferry timetable' }]);
    expect(shape(doc)).toEqual(['heading', '(blank)', 'paragraph', 'heading']);
  });
});

describe('a block with no words in it', () => {
  function withBlank(): { doc: Y.Doc; blankId: string } {
    const doc = docOf('## Meeting notes\n\n- Slipway opens in May\n');
    const fragment = getProseFragment(doc);
    fragment.insert(1, [new Y.XmlElement('paragraph')]);
    const blank = readOutline(doc).find((e) => e.kind === 'block' && e.text === '');
    if (!blank) throw new Error('no blank block in the outline');
    return { doc, blankId: blank.id };
  }

  it('is deleted by its outline id, whoever the caller is', () => {
    const { doc, blankId } = withBlank();
    const res = apply(doc, [{ op: 'delete_block', blockId: blankId }], 'agent:tidy');
    expect(res.outcomes[0]).toMatchObject({ status: 'applied' });
    expect(shape(doc)).toEqual(['heading', 'bulletList']);
  });

  it('is replaced by its outline id, and the words land in its place', () => {
    const { doc, blankId } = withBlank();
    const res = apply(
      doc,
      [{ op: 'replace_block', blockId: blankId, markdown: 'Agenda first' }],
      'agent:tidy',
    );
    expect(res.outcomes[0]).toMatchObject({ status: 'applied' });
    expect(md(doc)).toBe('## Meeting notes\n\nAgenda first\n\n- Slipway opens in May');
  });

  it('a block that has words still reaches its owner as a proposal', () => {
    const doc = docOf('## Meeting notes\n\nTheir own paragraph\n');
    const res = apply(doc, [{ op: 'delete_block', blockId: idOf(doc, 'Their own') }], 'agent:tidy');
    expect(res.outcomes[0]).toMatchObject({ status: 'suggested' });
  });
});
