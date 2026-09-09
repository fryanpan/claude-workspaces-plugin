import { describe, expect, test } from 'bun:test';
/**
 * The guard is only worth its lines if the thing it refuses really does
 * destroy the notes. Every rule here is a PAIR of tests: the same edit list
 * applied without the guard and with it, so a passing assertion always sits
 * beside proof that the unguarded path fails. A guard test with no control
 * passes just as happily when the bug it names was never real.
 *
 * The edit shape is the one taken from a measured run of
 * `scripts/notes-eval.ts` over the AMI fixtures: at tick 30 of ES2002c the
 * composer issued a `replace_block` against its own `## Meeting notes`
 * heading, and for the thirteen ticks that followed the doc's outline grew
 * from 55 entries to 76 while the notes section stayed frozen at 21 bullets.
 */
import { type DocType, prose } from '@claude-workspaces/core';
import * as Y from 'yjs';
import {
  type NotesHeadingMemory,
  applyNotesUpdate,
  createNotesHeadingMemory,
  notesWriteSkipDetail,
} from '../src/meeting-notes-doc.ts';
import type { NotesUpdate } from '../src/meeting-notes.ts';
import type { NotesDocStore } from '../src/notes-doc-access.ts';
import { guardNotesEdits } from '../src/notes-edit-guard.ts';
import { oneDocStore } from './notes-doc-helpers.ts';

const AUTHOR = 'notes-agent';
const WHO = {
  author: AUTHOR,
  suggestionAuthor: { id: AUTHOR, name: 'Note-taker', color: '#888888' },
};

/** A doc with a notes section and `n` of the note-taker's own bullets. */
function docWithNotes(n: number): { doc: Y.Doc; headingId: string; bulletIds: string[] } {
  const doc = new Y.Doc();
  const bullets = Array.from({ length: n }, (_, i) => `- point ${i} about the export dialog`);
  prose.applyMarkdownToFragment(
    prose.getProseFragment(doc),
    `## Meeting notes\n\n${bullets.join('\n')}\n`,
  );
  prose.ensureBlockIds(doc);
  // Every block has to read as the note-taker's, or the applier turns a
  // delete into a suggestion and the control proves something else.
  for (const el of prose.addressableBlocks(prose.getProseFragment(doc))) {
    prose.claimSubtree(el, AUTHOR);
  }
  const outline = prose.readOutline(doc);
  const heading = outline.find((e) => e.text.trim() === 'Meeting notes');
  if (!heading) throw new Error('fixture has no notes heading');
  return {
    doc,
    headingId: heading.id,
    bulletIds: outline.filter((e) => e.id !== heading.id).map((e) => e.id),
  };
}

function sectionCount(doc: Y.Doc): number {
  return prose.readOutline(doc).filter((e) => e.text.trim() === 'Meeting notes').length;
}

function apply(doc: Y.Doc, edits: readonly prose.BlockEdit[]): void {
  prose.applyBlockEdits(doc, [...edits], WHO);
}

describe('the meeting section heading is not an editable block', () => {
  test('CONTROL: replacing the heading takes the id the memory holds out of the doc', () => {
    const { doc, headingId } = docWithNotes(12);
    apply(doc, [{ op: 'replace_block', blockId: headingId, markdown: '## Meeting notes' }]);
    expect(prose.readOutline(doc).some((e) => e.id === headingId)).toBe(false);
  });

  test('CONTROL: with the id gone, the next tick opens a SECOND Meeting notes section', () => {
    const { doc, headingId } = docWithNotes(12);
    apply(doc, [{ op: 'replace_block', blockId: headingId, markdown: '## Meeting notes' }]);
    // The memory checks its remembered id against the outline, finds nothing,
    // and that is precisely the state in which the pipeline opens a section.
    apply(doc, [{ op: 'insert_at_end', markdown: '## Meeting notes\n\n- a later point' }]);
    expect(sectionCount(doc)).toBe(2);
    // Both readers of a notes section — the client's `notesSectionStart` and
    // the server's finder — take the LAST heading with that text, so the
    // twelve bullets above are still in the doc and no longer in the notes.
    const last = prose.readOutline(doc).filter((e) => e.text.startsWith('point'));
    expect(last).toHaveLength(12);
  });

  test('the guard refuses the replace, and the heading keeps its id', () => {
    const { doc, headingId } = docWithNotes(12);
    const guarded = guardNotesEdits(
      [{ op: 'replace_block', blockId: headingId, markdown: '## Meeting notes' }],
      { notesHeadingId: headingId },
    );
    expect(guarded.edits).toHaveLength(0);
    expect(guarded.refused[0]).toContain('notes heading');
    apply(doc, guarded.edits);
    expect(prose.readOutline(doc).some((e) => e.id === headingId)).toBe(true);
  });

  test('so the doc still has exactly one section after the tick that tried', () => {
    const { doc, headingId } = docWithNotes(12);
    const guarded = guardNotesEdits(
      [{ op: 'replace_block', blockId: headingId, markdown: '## Meeting notes' }],
      { notesHeadingId: headingId },
    );
    apply(doc, guarded.edits);
    apply(doc, [{ op: 'insert_under_heading', headingId, markdown: '- a later point' }]);
    expect(sectionCount(doc)).toBe(1);
    expect(prose.readOutline(doc).some((e) => e.text.includes('a later point'))).toBe(true);
  });

  test('a delete of the heading is refused for the same reason', () => {
    const { headingId } = docWithNotes(4);
    const guarded = guardNotesEdits([{ op: 'delete_block', blockId: headingId }], {
      notesHeadingId: headingId,
    });
    expect(guarded.edits).toHaveLength(0);
  });

  test('the rest of the batch still lands when one edit is refused', () => {
    const { doc, headingId } = docWithNotes(4);
    const guarded = guardNotesEdits(
      [
        { op: 'replace_block', blockId: headingId, markdown: '## Notes' },
        { op: 'insert_under_heading', headingId, markdown: '- a point that must survive' },
      ],
      { notesHeadingId: headingId },
    );
    expect(guarded.edits).toHaveLength(1);
    apply(doc, guarded.edits);
    expect(prose.readOutline(doc).some((e) => e.text.includes('must survive'))).toBe(true);
  });
});

describe('what the guard deliberately leaves alone', () => {
  test('a topic heading under the section is still the note-taker’s to rewrite', () => {
    const { doc, headingId } = docWithNotes(4);
    apply(doc, [{ op: 'insert_under_heading', headingId, markdown: '### Export dialog' }]);
    const topic = prose.readOutline(doc).find((e) => e.text.trim() === 'Export dialog');
    if (!topic) throw new Error('topic heading was not written');
    const guarded = guardNotesEdits(
      [{ op: 'replace_block', blockId: topic.id, markdown: '### Export and print' }],
      { notesHeadingId: headingId },
    );
    expect(guarded.edits).toHaveLength(1);
    expect(guarded.refused).toHaveLength(0);
  });

  test('a delete of a bullet passes through, covered by the batch or not', () => {
    // The delete-coverage rule is NOT in the guard, and this is the test that
    // says so on purpose: a bullet moved under another topic is a delete in
    // one tick and an insert in another, and a delete on a block that is not
    // the note-taker's has to reach the applier to become a suggestion.
    const { headingId, bulletIds } = docWithNotes(12);
    const guarded = guardNotesEdits(
      bulletIds.map((id) => ({ op: 'delete_block', blockId: id }) as prose.BlockEdit),
      { notesHeadingId: headingId },
    );
    expect(guarded.edits).toHaveLength(bulletIds.length);
    expect(guarded.refused).toHaveLength(0);
  });

  test('a meeting that has opened no section yet refuses nothing', () => {
    const { bulletIds } = docWithNotes(3);
    const guarded = guardNotesEdits([{ op: 'delete_block', blockId: bulletIds[0]! }], {});
    expect(guarded.edits).toHaveLength(1);
  });
});

describe('a batch the guard empties is reported under its own name', () => {
  // `all-edits-failed` is a compose worth retrying — the block a person
  // deleted mid-compose is gone and the next tick will address what is there.
  // A guarded batch is not: the same edit would be refused again. The log
  // could not tell the two apart while they shared a name.
  const tick = (docId: string, edits: prose.BlockEdit[]): NotesUpdate => ({
    docId,
    meetingId: `m-${docId}`,
    tick: { tick: 1, reason: 'pause', turns: [{ turn: 0, text: 'hi' }] },
    edits,
  });

  function meetingWithSection(): {
    store: NotesDocStore;
    memory: NotesHeadingMemory;
    headingId: string;
  } {
    const ydoc = new Y.Doc();
    prose.applyMarkdownToFragment(prose.getProseFragment(ydoc), '# Huddle\n');
    const store = oneDocStore('d', { ydoc, meta: { type: 'markdown' as DocType } });
    const memory = createNotesHeadingMemory();
    expect(
      applyNotesUpdate(
        store,
        tick('d', [{ op: 'insert_at_end', markdown: '## Meeting notes\n\n- a first point' }]),
        memory,
      ),
    ).toBe(null);
    const headingId = memory.headingId(
      { docId: 'd', meetingId: 'm-d' },
      store.readOutline('d')?.blocks ?? [],
    );
    if (!headingId) throw new Error('the memory did not learn the section it opened');
    return { store, memory, headingId };
  }

  test('replacing the meeting’s own heading is guard-refused, not all-edits-failed', () => {
    const { store, memory, headingId } = meetingWithSection();
    expect(
      applyNotesUpdate(
        store,
        tick('d', [{ op: 'replace_block', blockId: headingId, markdown: '## Meeting notes' }]),
        memory,
      ),
    ).toBe('guard-refused');
    expect(notesWriteSkipDetail('guard-refused')).toContain('guard');
  });

  test('CONTROL: a batch naming a block that is gone is still all-edits-failed', () => {
    const { store, memory } = meetingWithSection();
    expect(
      applyNotesUpdate(
        store,
        tick('d', [{ op: 'replace_block', blockId: 'blk-not-there', markdown: '- moved' }]),
        memory,
      ),
    ).toBe('all-edits-failed');
  });
});
