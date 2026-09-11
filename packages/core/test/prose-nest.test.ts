/**
 * What `nest_blocks` has to be true of, driven through the applier rather
 * than through the helper: a regroup reaches the doc as one entry in a batch
 * of model-written edits, and the batch is where authorship, ids and the
 * transaction all meet.
 */
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { applyBlockEdits } from '../src/prose-batch.ts';
import { autoReanchorDoc } from '../src/prose-blocks.ts';
import { getProseFragment, walkProse } from '../src/prose-fragment.ts';
import { parseMarkdownBlocks, serializeFragmentToMarkdown } from '../src/prose-markdown.ts';
import { readOutline } from '../src/prose-outline.ts';

const AGENT = 'meeting-notes';
const SUGGESTER = { id: AGENT, name: 'Meeting Assistant', color: '#7c5cff' };

function apply(doc: Y.Doc, edits: Parameters<typeof applyBlockEdits>[1]) {
  return applyBlockEdits(doc, edits, { author: AGENT, suggestionAuthor: SUGGESTER });
}

function md(doc: Y.Doc): string {
  return serializeFragmentToMarkdown(getProseFragment(doc)).trimEnd();
}

/** A doc whose bullets are all the note-taker's, the way a tick leaves it. */
function notesDoc(markdown: string): Y.Doc {
  const doc = new Y.Doc();
  getProseFragment(doc).push(parseMarkdownBlocks('### Remote control usability\n'));
  const headingId = readOutline(doc)[0]?.id as string;
  apply(doc, [{ op: 'insert_under_heading', headingId, markdown }]);
  return doc;
}

/** The id of the bullet whose text is `text`. */
function idOf(doc: Y.Doc, text: string): string {
  const entry = readOutline(doc).find((e) => e.text === text);
  if (!entry) throw new Error(`no block reading ${JSON.stringify(text)}`);
  return entry.id;
}

const WALL = [
  '- People lose the remote between the cushions',
  '- A locator beep would need a speaker in the case',
  '- The beeper cost is not known yet',
  '- The case has to survive a drop onto tile',
  '- Rubber edging was floated and nobody costed it',
].join('\n');

describe('nest_blocks', () => {
  it('moves the named bullets under the lead and leaves the rest flat', () => {
    const doc = notesDoc(WALL);
    const res = apply(doc, [
      {
        op: 'nest_blocks',
        leadBlockId: idOf(doc, 'People lose the remote between the cushions'),
        blockIds: [
          idOf(doc, 'A locator beep would need a speaker in the case'),
          idOf(doc, 'The beeper cost is not known yet'),
        ],
      },
    ]);
    expect(res.outcomes).toEqual([{ op: 'nest_blocks', status: 'applied' }]);
    expect(md(doc)).toBe(
      [
        '### Remote control usability',
        '',
        '- People lose the remote between the cushions',
        '  - A locator beep would need a speaker in the case',
        '  - The beeper cost is not known yet',
        '- The case has to survive a drop onto tile',
        '- Rubber edging was floated and nobody costed it',
      ].join('\n'),
    );
  });

  it('keeps every point — the doc says exactly what it said before', () => {
    const doc = notesDoc(WALL);
    const before = walkProse(getProseFragment(doc)).plainText;
    apply(doc, [
      {
        op: 'nest_blocks',
        leadBlockId: idOf(doc, 'People lose the remote between the cushions'),
        blockIds: [
          idOf(doc, 'A locator beep would need a speaker in the case'),
          idOf(doc, 'The beeper cost is not known yet'),
        ],
      },
    ]);
    expect(walkProse(getProseFragment(doc)).plainText).toBe(before);
  });

  it('a moved bullet keeps its id, so an edit that named it still lands', () => {
    const doc = notesDoc(WALL);
    const moved = idOf(doc, 'The beeper cost is not known yet');
    apply(doc, [
      {
        op: 'nest_blocks',
        leadBlockId: idOf(doc, 'People lose the remote between the cushions'),
        blockIds: [moved],
      },
    ]);
    expect(idOf(doc, 'The beeper cost is not known yet')).toBe(moved);
    const res = apply(doc, [
      { op: 'replace_block', blockId: moved, markdown: '- The beeper costs about a dollar' },
    ]);
    expect(res.outcomes[0]?.status).toBe('applied');
    expect(md(doc)).toContain('  - The beeper costs about a dollar');
  });

  it('a moved bullet keeps its inline links', () => {
    const doc = notesDoc(
      ['- Where the remote goes', '- [@Eve](speaker:B) loses it weekly'].join('\n'),
    );
    apply(doc, [
      {
        op: 'nest_blocks',
        leadBlockId: idOf(doc, 'Where the remote goes'),
        blockIds: [idOf(doc, '[@Eve](speaker:B) loses it weekly')],
      },
    ]);
    expect(md(doc)).toContain('  - [@Eve](speaker:B) loses it weekly');
  });

  it('the sub-bullets read as nested in the outline the model is shown', () => {
    const doc = notesDoc(WALL);
    apply(doc, [
      {
        op: 'nest_blocks',
        leadBlockId: idOf(doc, 'People lose the remote between the cushions'),
        blockIds: [idOf(doc, 'A locator beep would need a speaker in the case')],
      },
    ]);
    const depths = readOutline(doc)
      .filter((e) => e.kind === 'listItem')
      .map((e) => `${e.depth}:${e.text.split(' ').slice(0, 2).join(' ')}`);
    expect(depths).toEqual([
      '0:People lose',
      '1:A locator',
      '0:The beeper',
      '0:The case',
      '0:Rubber edging',
    ]);
  });

  it('a thread on a moved bullet re-anchors onto its own text', () => {
    const doc = notesDoc(WALL);
    const fragment = getProseFragment(doc);
    // Anchor a thread on the bullet about to move, the way a person's comment
    // does: a relative position into that bullet's own Y.XmlText.
    const walk = walkProse(fragment);
    const needle = 'The beeper cost is not known yet';
    const at = walk.plainText.indexOf(needle);
    const seg = walk.segments.find((s) => at >= s.docOffset && at < s.docOffset + s.length);
    if (!seg) throw new Error('no segment for the bullet');
    const threads = doc.getMap('threads') as Y.Map<Y.Map<unknown>>;
    const thread = new Y.Map<unknown>();
    thread.set('anchor', {
      kind: 'text-range',
      startRel: Y.encodeRelativePosition(
        Y.createRelativePositionFromTypeIndex(seg.node, at - seg.docOffset),
      ),
      endRel: Y.encodeRelativePosition(
        Y.createRelativePositionFromTypeIndex(seg.node, at - seg.docOffset + needle.length),
      ),
      snippet: { text: needle },
    });
    threads.set('t1', thread);

    apply(doc, [
      {
        op: 'nest_blocks',
        leadBlockId: idOf(doc, 'People lose the remote between the cushions'),
        blockIds: [idOf(doc, needle)],
      },
    ]);

    // The sweep the doc store runs after every change is what recovers it:
    // the words moved, so the snippet is still in the doc exactly once.
    expect(autoReanchorDoc(doc)).toMatchObject({ reanchored: 1, stillOrphan: 0 });
    const anchor = thread.get('anchor') as { startRel: Uint8Array; endRel: Uint8Array };
    const start = Y.createAbsolutePositionFromRelativePosition(
      Y.decodeRelativePosition(anchor.startRel),
      doc,
    );
    const end = Y.createAbsolutePositionFromRelativePosition(
      Y.decodeRelativePosition(anchor.endRel),
      doc,
    );
    expect(start).not.toBeNull();
    expect(end).not.toBeNull();
    // The recovered range spans the moved bullet's own words, in the node it
    // now lives in — a re-anchor that merely resolved somewhere would pass
    // the null checks above and fail this.
    expect(String(start?.type).slice(start?.index, end?.index)).toBe(needle);
  });

  it('nests into the group a lead already has rather than opening a second', () => {
    const doc = notesDoc(WALL);
    const lead = idOf(doc, 'People lose the remote between the cushions');
    apply(doc, [
      {
        op: 'nest_blocks',
        leadBlockId: lead,
        blockIds: [idOf(doc, 'The beeper cost is not known yet')],
      },
    ]);
    apply(doc, [
      {
        op: 'nest_blocks',
        leadBlockId: lead,
        blockIds: [idOf(doc, 'The case has to survive a drop onto tile')],
      },
    ]);
    expect(md(doc)).toBe(
      [
        '### Remote control usability',
        '',
        '- People lose the remote between the cushions',
        '  - The beeper cost is not known yet',
        '  - The case has to survive a drop onto tile',
        '- A locator beep would need a speaker in the case',
        '- Rubber edging was floated and nobody costed it',
      ].join('\n'),
    );
  });

  it('refuses a lead that is not a bullet, and changes nothing', () => {
    const doc = notesDoc(WALL);
    const before = md(doc);
    const res = apply(doc, [
      {
        op: 'nest_blocks',
        leadBlockId: idOf(doc, 'Remote control usability'),
        blockIds: [idOf(doc, 'The beeper cost is not known yet')],
      },
    ]);
    expect(res.outcomes).toEqual([
      { op: 'nest_blocks', status: 'failed', error: 'not-a-list-item' },
    ]);
    expect(md(doc)).toBe(before);
  });

  it("refuses to move anything under a person's bullet", () => {
    const doc = notesDoc(WALL);
    // A person's bullet: written into the doc with nobody's authorship on it.
    const fragment = getProseFragment(doc);
    fragment.push(parseMarkdownBlocks('- I want one that clips to the arm\n'));
    const before = md(doc);
    const res = apply(doc, [
      {
        op: 'nest_blocks',
        leadBlockId: idOf(doc, 'I want one that clips to the arm'),
        blockIds: [idOf(doc, 'The beeper cost is not known yet')],
      },
    ]);
    expect(res.outcomes).toEqual([{ op: 'nest_blocks', status: 'failed', error: 'not-yours' }]);
    expect(md(doc)).toBe(before);
  });

  it("leaves a person's bullet where it is and moves the rest", () => {
    const doc = new Y.Doc();
    getProseFragment(doc).push(
      parseMarkdownBlocks(
        ['### Topic', '', '- ours one', '- theirs', '- ours two'].join('\n') + '\n',
      ),
    );
    // Claim only the two that are the note-taker's.
    const ids = readOutline(doc);
    for (const entry of ids) {
      if (entry.text.startsWith('ours')) {
        const el = getProseFragment(doc)
          .toArray()
          .flatMap((n) => (n instanceof Y.XmlElement ? n.toArray() : []))
          .find(
            (n): n is Y.XmlElement =>
              n instanceof Y.XmlElement && n.getAttribute('cwId') === entry.id,
          );
        el?.setAttribute('cwAuthor', AGENT);
      }
    }
    const res = apply(doc, [
      {
        op: 'nest_blocks',
        leadBlockId: idOf(doc, 'ours one'),
        blockIds: [idOf(doc, 'theirs'), idOf(doc, 'ours two')],
      },
    ]);
    expect(res.outcomes[0]?.status).toBe('applied');
    expect(md(doc)).toBe(['### Topic', '', '- ours one', '  - ours two', '- theirs'].join('\n'));
  });

  it('reports a lead that is gone rather than moving a bullet elsewhere', () => {
    const doc = notesDoc(WALL);
    const before = md(doc);
    const res = apply(doc, [
      {
        op: 'nest_blocks',
        leadBlockId: 'bNoSuchBlock',
        blockIds: [idOf(doc, 'The beeper cost is not known yet')],
      },
    ]);
    expect(res.outcomes).toEqual([{ op: 'nest_blocks', status: 'failed', error: 'unknown-block' }]);
    expect(md(doc)).toBe(before);
  });

  it('reports a nest whose members are all gone', () => {
    const doc = notesDoc(WALL);
    const res = apply(doc, [
      {
        op: 'nest_blocks',
        leadBlockId: idOf(doc, 'People lose the remote between the cushions'),
        blockIds: ['bGone'],
      },
    ]);
    expect(res.outcomes).toEqual([
      { op: 'nest_blocks', status: 'failed', error: 'nothing-to-nest' },
    ]);
  });
});
