/**
 * A block keeps its address when the agent that owns it rewrites it in place.
 *
 * THE FAILURE THESE PIN. Yjs cannot rewrite an element, so `replace_block` is
 * a delete and an insert — and the inserted block used to come back with a
 * NEW id. Inside one batch that is the caller's own earlier edit invalidating
 * its later ones, because edits resolve against the doc as the ones before
 * them left it. Measured through the meeting note-taker's real write path
 * before the fix, on a four-bullet topic every one of whose blocks was on the
 * page when the batch was composed:
 *
 * - "correct this bullet, then correct it again" — second edit
 *   `unknown-block`, and the later wording landed as a SECOND bullet at the
 *   end of the section beside the one it was meant to replace;
 * - "correct this bullet, then remove it" — the removal `unknown-block`, and
 *   a removal carries no words, so nothing anywhere recorded that it had not
 *   happened;
 * - "reword this bullet into a lead, then nest these under it" — the regroup
 *   `unknown-block`, silently;
 * - "rename this topic heading, then put the new note under it" — the note
 *   re-homed to the end of the section rather than under its topic.
 *
 * Each is a correction the note-taker decided to make and the room never saw.
 *
 * WHAT THE TESTS ASSERT is the doc after the batch, never an id's spelling:
 * an address is opaque, and "the second edit landed on the block the first
 * one rewrote" is readable straight off the words.
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

const apply = (doc: Y.Doc, edits: Parameters<typeof applyBlockEdits>[1], author = AGENT) =>
  applyBlockEdits(doc, edits, { author, suggestionAuthor: { ...SUGGESTER, id: author } });

const md = (doc: Y.Doc): string => serializeFragmentToMarkdown(getProseFragment(doc)).trimEnd();

const idOf = (doc: Y.Doc, needle: string): string => {
  const found = readOutline(doc).find((e) => e.text.includes(needle));
  if (!found) throw new Error(`no block reading ${needle}`);
  return found.id;
};

/** Every address in the doc, so a test can say none of them is a copy. */
const addresses = (doc: Y.Doc): string[] => readOutline(doc).map((e) => e.id);

/**
 * A topic the agent wrote itself, so a replace on any of its bullets applies
 * directly rather than arriving as a proposal on somebody else's words.
 */
function notesDoc(): Y.Doc {
  const doc = new Y.Doc();
  getProseFragment(doc).insert(0, parseMarkdownBlocks('## Notes\n'));
  const notes = idOf(doc, 'Notes');
  apply(doc, [
    { op: 'insert_under_heading', headingId: notes, markdown: '### Rollout\n' },
    {
      op: 'insert_under_heading',
      headingId: idOf(doc, 'Notes'),
      markdown: '- ships Tuesday\n- Riverbend runs the pilot\n- pricing still open\n',
    },
  ]);
  // The heading has to be claimed too — the second insert above lands under
  // it, and a rename in a later test must apply rather than be proposed.
  expect(readOutline(doc).filter((e) => e.author === AGENT).length).toBeGreaterThanOrEqual(3);
  return doc;
}

describe('an in-place rewrite keeps the block addressable', () => {
  it('lets a second correction of the same bullet land on the first one', () => {
    const doc = notesDoc();
    const bullet = idOf(doc, 'ships Tuesday');
    const res = apply(doc, [
      { op: 'replace_block', blockId: bullet, markdown: '- ships Thursday' },
      { op: 'replace_block', blockId: bullet, markdown: '- ships Thursday morning' },
    ]);
    expect(res.failed).toBe(0);
    // One bullet, reading the later correction — not two disagreeing ones.
    expect(md(doc)).toBe(
      '## Notes\n\n### Rollout\n\n- ships Thursday morning\n- Riverbend runs the pilot\n- pricing still open',
    );
  });

  it('lets a removal reach a bullet the same batch has just reworded', () => {
    const doc = notesDoc();
    const bullet = idOf(doc, 'pricing still open');
    const res = apply(doc, [
      { op: 'replace_block', blockId: bullet, markdown: '- pricing settled at list' },
      { op: 'delete_block', blockId: bullet },
    ]);
    expect(res.failed).toBe(0);
    expect(md(doc)).toBe('## Notes\n\n### Rollout\n\n- ships Tuesday\n- Riverbend runs the pilot');
  });

  it('lets a regroup nest under a lead the same batch has just reworded', () => {
    const doc = notesDoc();
    const lead = idOf(doc, 'ships Tuesday');
    const res = apply(doc, [
      { op: 'replace_block', blockId: lead, markdown: '- Rollout timing' },
      {
        op: 'nest_blocks',
        leadBlockId: lead,
        blockIds: [idOf(doc, 'Riverbend runs the pilot')],
      },
    ]);
    expect(res.failed).toBe(0);
    expect(md(doc)).toBe(
      '## Notes\n\n### Rollout\n\n- Rollout timing\n  - Riverbend runs the pilot\n- pricing still open',
    );
  });

  it('lets a note land under a topic heading the same batch has just renamed', () => {
    const doc = notesDoc();
    const topic = idOf(doc, 'Rollout');
    const res = apply(doc, [
      { op: 'replace_block', blockId: topic, markdown: '### Rollout and pricing' },
      { op: 'insert_under_heading', headingId: topic, markdown: '- list price holds\n' },
    ]);
    expect(res.failed).toBe(0);
    expect(md(doc)).toBe(
      '## Notes\n\n### Rollout and pricing\n\n- ships Tuesday\n- Riverbend runs the pilot\n' +
        '- pricing still open\n- list price holds',
    );
  });

  it('gives the extra blocks of a multi-block rewrite addresses of their own', () => {
    // ONE BLOCK REPLACED IS ONE ADDRESS INHERITED. A regroup's replacement is
    // several bullets; if they all wore the id of the bullet they replaced,
    // an edit naming it would reach whichever a lookup met first.
    const doc = notesDoc();
    const bullet = idOf(doc, 'ships Tuesday');
    apply(doc, [
      {
        op: 'replace_block',
        blockId: bullet,
        markdown: '- Rollout timing\n- ships Thursday\n- Saltmarsh signs off first',
      },
    ]);
    const ids = addresses(doc);
    expect(new Set(ids).size).toBe(ids.length);
    // And the address the batch inherited still names the first of them.
    expect(readOutline(doc).find((e) => e.id === bullet)?.text).toBe('Rollout timing');
  });
});

describe('a proposal leaves the address where it was', () => {
  it('offers the replacement beside a person’s block without taking its id', () => {
    // CONTROL FOR THE OPPOSITE MISTAKE. A proposal writes its blocks AFTER the
    // one it is about and leaves that block in the doc; copying the id there
    // would put two blocks in one doc under one address.
    const doc = new Y.Doc();
    getProseFragment(doc).insert(0, parseMarkdownBlocks('## Notes\n\nA line somebody typed.\n'));
    const theirs = idOf(doc, 'A line somebody typed');
    const res = apply(doc, [
      { op: 'replace_block', blockId: theirs, markdown: 'A line, reworded.' },
    ]);
    expect(res.suggested).toBe(1);
    const ids = addresses(doc);
    expect(new Set(ids).size).toBe(ids.length);
    // The address still names the words the person wrote, not the offer.
    expect(readOutline(doc).find((e) => e.id === theirs)?.text).toContain('A line somebody typed');
  });
});
