/**
 * What `insert_before_block` has to be true of, driven through the applier:
 * the op exists so a heading can be PLACED, and every claim below is about
 * where the heading landed and what the bullets around it read as afterwards.
 */
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { applyBlockEdits } from '../src/prose-batch.ts';
import { autoReanchorDoc } from '../src/prose-blocks.ts';
import { getProseFragment } from '../src/prose-fragment.ts';
import { parseMarkdownBlocks, serializeFragmentToMarkdown } from '../src/prose-markdown.ts';
import { readOutline } from '../src/prose-outline.ts';

const AGENT = 'meeting-notes';
const PERSON = 'bryan';
const SUGGESTER = { id: AGENT, name: 'Meeting Assistant', color: '#7c5cff' };

function apply(doc: Y.Doc, edits: Parameters<typeof applyBlockEdits>[1], moveOthers = false) {
  return applyBlockEdits(doc, edits, {
    author: AGENT,
    suggestionAuthor: SUGGESTER,
    ...(moveOthers ? { moveOthers: true } : {}),
  });
}

function md(doc: Y.Doc): string {
  return serializeFragmentToMarkdown(getProseFragment(doc)).trimEnd();
}

const RUN = [
  '- The Harborlight ferry leaves on the hour',
  '- Nobody has the winter timetable yet',
  '- Riverbend wants a later last sailing',
  '- The last sailing is a crew-hours question',
  '- Saltmarsh asked about the bike racks',
  '- Six racks per sailing is the current guess',
].join('\n');

/** A doc holding one topic heading and a flat run of the note-taker's bullets. */
function notesDoc(markdown = RUN): Y.Doc {
  const doc = new Y.Doc();
  getProseFragment(doc).push(parseMarkdownBlocks('## Live notes\n'));
  const headingId = readOutline(doc)[0]?.id as string;
  apply(doc, [{ op: 'insert_under_heading', headingId, markdown }]);
  return doc;
}

function idOf(doc: Y.Doc, text: string): string {
  const entry = readOutline(doc).find((e) => e.text === text);
  if (!entry) throw new Error(`no block reading ${JSON.stringify(text)}`);
  return entry.id;
}

/** The text of the heading each bullet is reported as sitting under. */
function topicOf(doc: Y.Doc, text: string): string | undefined {
  const outline = readOutline(doc);
  const entry = outline.find((e) => e.text === text);
  const head = outline.find((e) => e.id === entry?.underHeadingId);
  return head?.text;
}

describe('insert_before_block', () => {
  it('writes the heading above the bullet named, not at the end of the section', () => {
    const doc = notesDoc();
    const res = apply(doc, [
      {
        op: 'insert_before_block',
        blockId: idOf(doc, 'Saltmarsh asked about the bike racks'),
        markdown: '### Bike racks',
      },
    ]);

    expect(res.applied).toBe(1);
    expect(md(doc)).toBe(
      [
        '## Live notes',
        '',
        '- The Harborlight ferry leaves on the hour',
        '- Nobody has the winter timetable yet',
        '- Riverbend wants a later last sailing',
        '- The last sailing is a crew-hours question',
        '',
        '### Bike racks',
        '',
        '- Saltmarsh asked about the bike racks',
        '- Six racks per sailing is the current guess',
      ].join('\n'),
    );
  });

  it('CONTROL: insert_under_heading puts the same heading below the whole run', () => {
    const doc = notesDoc();
    apply(doc, [
      {
        op: 'insert_under_heading',
        headingId: idOf(doc, 'Live notes'),
        markdown: '### Bike racks',
      },
    ]);

    // The gap this op exists to close, stated as the behaviour that was
    // already there: the heading is real, and it heads nothing.
    expect(md(doc).trimEnd().endsWith('### Bike racks')).toBe(true);
    expect(topicOf(doc, 'Saltmarsh asked about the bike racks')).toBe('Live notes');
  });

  it('re-parents the bullets below it without rewriting or re-addressing one', () => {
    const doc = notesDoc();
    const before = readOutline(doc).filter((e) => e.kind === 'listItem');
    apply(doc, [
      {
        op: 'insert_before_block',
        blockId: idOf(doc, 'Saltmarsh asked about the bike racks'),
        markdown: '### Bike racks',
      },
    ]);

    expect(topicOf(doc, 'Saltmarsh asked about the bike racks')).toBe('Bike racks');
    expect(topicOf(doc, 'Six racks per sailing is the current guess')).toBe('Bike racks');
    expect(topicOf(doc, 'Riverbend wants a later last sailing')).toBe('Live notes');

    // Same ids, same words, in the same order — the whole point of placing a
    // heading rather than retyping the notes under a new one.
    const after = readOutline(doc).filter((e) => e.kind === 'listItem');
    expect(after.map((e) => e.id)).toEqual(before.map((e) => e.id));
    expect(after.map((e) => e.text)).toEqual(before.map((e) => e.text));
  });

  it('leaves a comment thread anchored to a bullet it moved across the split', () => {
    const doc = notesDoc();
    apply(doc, [
      {
        op: 'insert_before_block',
        blockId: idOf(doc, 'Saltmarsh asked about the bike racks'),
        markdown: '### Bike racks',
      },
    ]);
    // The recovery `prose-nest.ts` rests on, asked of this op: a snippet that
    // still appears exactly once re-anchors. It should never be needed here —
    // nothing was retyped — and it holds either way.
    expect(() => autoReanchorDoc(doc)).not.toThrow();
    expect(md(doc)).toContain('- Six racks per sailing is the current guess');
  });

  it('needs no split when the bullet named is the first of its run', () => {
    const doc = notesDoc();
    apply(doc, [
      {
        op: 'insert_before_block',
        blockId: idOf(doc, 'The Harborlight ferry leaves on the hour'),
        markdown: '### Ferry timetable',
      },
    ]);

    expect(topicOf(doc, 'The Harborlight ferry leaves on the hour')).toBe('Ferry timetable');
    expect(
      md(doc)
        .split('\n')
        .filter((l) => l.startsWith('- ')),
    ).toHaveLength(6);
  });

  it('places a heading in front of a top-level block that is not a bullet', () => {
    const doc = notesDoc('Nobody spoke for a while.');
    apply(doc, [
      {
        op: 'insert_before_block',
        blockId: idOf(doc, 'Nobody spoke for a while.'),
        markdown: '### The quiet stretch',
      },
    ]);

    expect(topicOf(doc, 'Nobody spoke for a while.')).toBe('The quiet stretch');
  });

  it('refuses to carry a tail holding a bullet the note-taker does not own', () => {
    const doc = notesDoc();
    // A person types a line of their own into the middle of the run.
    const fragment = getProseFragment(doc);
    const list = (fragment.toArray() as Y.XmlElement[]).find((el) => el.nodeName === 'bulletList');
    const theirs = (list?.toArray() as Y.XmlElement[])[4];
    theirs?.setAttribute('cwAuthor', PERSON);

    const res = apply(doc, [
      {
        op: 'insert_before_block',
        blockId: idOf(doc, 'Riverbend wants a later last sailing'),
        markdown: '### Last sailing',
      },
    ]);

    expect(res.applied).toBe(0);
    expect(res.outcomes[0]?.error).toBe('not-yours');
    // Refused means UNTOUCHED, not half-carried: their line is still theirs
    // and still where they put it.
    expect(md(doc)).toContain('- Saltmarsh asked about the bike racks');
    expect(readOutline(doc).filter((e) => e.kind === 'heading')).toHaveLength(1);
  });

  it('CONTROL: the tidy-up pass carries the same tail, because structure is free', () => {
    const doc = notesDoc();
    const fragment = getProseFragment(doc);
    const list = (fragment.toArray() as Y.XmlElement[]).find((el) => el.nodeName === 'bulletList');
    (list?.toArray() as Y.XmlElement[])[4]?.setAttribute('cwAuthor', PERSON);

    const res = apply(
      doc,
      [
        {
          op: 'insert_before_block',
          blockId: idOf(doc, 'Riverbend wants a later last sailing'),
          markdown: '### Last sailing',
        },
      ],
      true,
    );

    expect(res.applied).toBe(1);
    expect(topicOf(doc, 'Saltmarsh asked about the bike racks')).toBe('Last sailing');
  });

  it('refuses a sub-bullet, which is not a topic boundary', () => {
    const doc = notesDoc();
    apply(doc, [
      {
        op: 'nest_blocks',
        leadBlockId: idOf(doc, 'Riverbend wants a later last sailing'),
        blockIds: [idOf(doc, 'The last sailing is a crew-hours question')],
      },
    ]);

    const res = apply(doc, [
      {
        op: 'insert_before_block',
        blockId: idOf(doc, 'The last sailing is a crew-hours question'),
        markdown: '### Crew hours',
      },
    ]);

    expect(res.outcomes[0]?.error).toBe('nested-item');
    expect(readOutline(doc).filter((e) => e.kind === 'heading')).toHaveLength(1);
  });

  it('reports a block that has left the doc rather than writing the heading anywhere', () => {
    const doc = notesDoc();
    const res = apply(doc, [
      { op: 'insert_before_block', blockId: 'b-gone', markdown: '### Nowhere' },
    ]);

    expect(res.outcomes[0]?.error).toBe('unknown-block');
    expect(md(doc)).not.toContain('Nowhere');
  });

  it('resolves against the doc the edits before it left, so a batch may place then fill', () => {
    const doc = notesDoc();
    const res = apply(doc, [
      {
        op: 'insert_before_block',
        blockId: idOf(doc, 'Saltmarsh asked about the bike racks'),
        markdown: '### Bike racks',
      },
      { op: 'insert_at_end', markdown: '- Racks would come off the rear deck' },
    ]);

    expect(res.applied).toBe(2);
    expect(topicOf(doc, 'Racks would come off the rear deck')).toBe('Bike racks');
  });
});
