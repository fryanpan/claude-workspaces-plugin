/**
 * A regroup that cannot move anything must not cost the meeting its notes.
 *
 * Measured on an hour-long AMI meeting (EN2001b, 170 ticks) against the
 * composer as it shipped: two consecutive ticks came back as four
 * `nest_blocks` edits, every one of them answered `nothing-to-nest`, and the
 * whole write was reported `all-edits-failed`. That verdict is what carries
 * the tick's turns into the next tick, spends a second compose on them, and
 * tells the live surface the words were never written — for a batch that
 * proposed no words at all. Nothing was lost and the meeting was told it was.
 *
 * The distinction the tests below pin is between an edit that CARRIES WORDS
 * and one that only MOVES them. A batch of moves that all fail leaves the
 * notes exactly as they were, which is a regroup that did not happen, not a
 * note that did not arrive.
 *
 * WHY THE WORD-CARRYING ARMS FAIL ON `empty` RATHER THAN ON A MISSING BLOCK.
 * They named a block that was gone until `notes-edit-address.ts` landed, and
 * that is now the one word-carrying failure the write RECOVERS from: the note
 * is re-addressed to the meeting's section and lands, so the tick is a write
 * and reporting it failed would note the same turns twice
 * (`notes-address-recovery.test.ts` is that half). What is left, and what
 * these pin, is a batch whose WORDS the doc refused — nothing to re-address,
 * because there is nothing to say.
 */
import { describe, expect, test } from 'bun:test';
import { prose } from '@claude-workspaces/core';
import * as Y from 'yjs';
import { applyNotesUpdate, createNotesHeadingMemory } from '../src/meeting-notes-doc.ts';
import type { NotesUpdate } from '../src/meeting-notes.ts';
import type { NotesDocStore } from '../src/notes-doc-access.ts';
import { oneDocStore } from './notes-doc-helpers.ts';

function update(edits: readonly prose.BlockEdit[]): NotesUpdate {
  return {
    docId: 'd',
    meetingId: 'm',
    tick: { tick: 1, reason: 'pause', turns: [] },
    edits: [...edits],
  } as unknown as NotesUpdate;
}

/** A notes section the note-taker itself wrote, so every block is its own. */
function notesDoc(markdown: string): {
  store: NotesDocStore;
  bullets: string[];
  /** The topic heading under the section — a real address, so an edit that
   *  fails here failed on its words and not on where it was pointed. */
  topic: string;
} {
  const ydoc = new Y.Doc();
  const store = oneDocStore('d', { ydoc, meta: { type: 'markdown' } });
  const heading = createNotesHeadingMemory();
  expect(applyNotesUpdate(store, update([{ op: 'insert_at_end', markdown }]), heading)).toBeNull();
  const blocks = store.readOutline('d')?.blocks ?? [];
  const bullets = blocks.filter((b) => b.kind === 'listItem').map((b) => b.id);
  const topic = blocks.find((b) => b.kind === 'heading' && b.text.trim() === 'Topic');
  if (topic === undefined) throw new Error('fixture has no topic heading');
  return { store, bullets, topic: topic.id };
}

describe('a regroup that moves nothing', () => {
  test('leaves the notes standing and reports no failed write', () => {
    const { store, bullets } = notesDoc(
      '## Meeting notes\n\n### Topic\n\n- one\n- two\n- three\n- four\n',
    );
    expect(bullets.length).toBe(4);
    const before = store.readOutline('d')?.blocks.length;
    // A lead naming an id that is not one of its siblings — the shape the
    // model answered with on EN2001b tick 130.
    const skip = applyNotesUpdate(
      store,
      update([{ op: 'nest_blocks', leadBlockId: bullets[0]!, blockIds: ['b-gone'] }]),
      createNotesHeadingMemory(),
    );
    expect(skip).toBeNull();
    expect(store.readOutline('d')?.blocks.length).toBe(before);
  });

  test('still reports a failure when a batch that carried words wrote none', () => {
    const { store, topic } = notesDoc('## Meeting notes\n\n### Topic\n\n- one\n');
    const skip = applyNotesUpdate(
      store,
      update([{ op: 'insert_under_heading', headingId: topic, markdown: '   ' }]),
      createNotesHeadingMemory(),
    );
    expect(skip).toBe('all-edits-failed');
  });

  // THE OTHER TWO OPS THAT CARRY WORDS. Without these, `failedCarryingWords`
  // can be narrowed to `insert_under_heading` alone and the file stays green —
  // measured, by making exactly that cut. A rewrite is the one that would hurt
  // most: `replace_block` is how a bullet is corrected, and a correction that
  // silently reports success is a correction the meeting never sees and never
  // retries.
  test('still reports a failure when a rewrite had nothing to put in the block', () => {
    const { store, bullets } = notesDoc('## Meeting notes\n\n### Topic\n\n- one\n');
    const skip = applyNotesUpdate(
      store,
      update([{ op: 'replace_block', blockId: bullets[0]!, markdown: '   ' }]),
      createNotesHeadingMemory(),
    );
    expect(skip).toBe('all-edits-failed');
  });

  test('still reports a failure when an append carried nothing to append', () => {
    const { store } = notesDoc('## Meeting notes\n\n### Topic\n\n- one\n');
    const skip = applyNotesUpdate(
      store,
      update([{ op: 'insert_at_end', markdown: '   ' }]),
      createNotesHeadingMemory(),
    );
    expect(skip).toBe('all-edits-failed');
  });

  test('reports a failure when a failed move rides with a note that also failed', () => {
    const { store, bullets, topic } = notesDoc(
      '## Meeting notes\n\n### Topic\n\n- one\n- two\n- three\n- four\n',
    );
    const skip = applyNotesUpdate(
      store,
      update([
        { op: 'nest_blocks', leadBlockId: bullets[0]!, blockIds: ['b-gone'] },
        { op: 'insert_under_heading', headingId: topic, markdown: '   ' },
      ]),
      createNotesHeadingMemory(),
    );
    expect(skip).toBe('all-edits-failed');
  });
});
