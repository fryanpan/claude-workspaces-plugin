/**
 * Which failed edits get their words put back, and which are left alone.
 *
 * The module is pure — edits and verdicts in, edits out — so these drive it
 * directly. The meeting-level half, where a repeating mistake used to cost a
 * meeting its notes, is `notes-address-recovery.test.ts`.
 *
 * All fixtures are invented. The repo is public.
 */
import { describe, expect, test } from 'bun:test';
import type { prose } from '@claude-workspaces/core';
import { repairNotesEditAddresses } from '../src/notes-edit-address.ts';

const SECTION = 'h-notes';

/** One failed verdict for `op`, with `error` as its reason. */
function failed(op: prose.BlockEditOp, error: string): prose.BlockEditOutcome {
  return { op, status: 'failed', error: error as prose.BlockEditError };
}

const applied = (op: prose.BlockEditOp): prose.BlockEditOutcome => ({ op, status: 'applied' });

describe('a note whose address the doc could not honour', () => {
  test('is re-addressed to the meeting’s own section, keeping its words', () => {
    const edits: prose.BlockEdit[] = [
      {
        op: 'insert_under_heading',
        headingId: 'b-a-bullet',
        markdown: '- the pier needs a permit',
      },
    ];
    const repair = repairNotesEditAddresses(
      edits,
      [failed('insert_under_heading', 'not-a-heading')],
      SECTION,
    );
    expect(repair.edits).toEqual([
      { op: 'insert_under_heading', headingId: SECTION, markdown: '- the pier needs a permit' },
    ]);
    expect(repair.repaired).toHaveLength(1);
  });

  test('goes to the end of the doc when the meeting has no section yet', () => {
    const repair = repairNotesEditAddresses(
      [{ op: 'insert_under_heading', headingId: 'h-gone', markdown: '- the pier needs a permit' }],
      [failed('insert_under_heading', 'unknown-block')],
      undefined,
    );
    expect(repair.edits).toEqual([{ op: 'insert_at_end', markdown: '- the pier needs a permit' }]);
  });

  test('covers a rewrite whose block is gone — the words are the point, not the slot', () => {
    const repair = repairNotesEditAddresses(
      [{ op: 'replace_block', blockId: 'b-gone', markdown: '- the corrected point' }],
      [failed('replace_block', 'unknown-block')],
      SECTION,
    );
    expect(repair.edits).toEqual([
      { op: 'insert_under_heading', headingId: SECTION, markdown: '- the corrected point' },
    ]);
  });

  test('recovers only the failed edit of a batch that partly landed', () => {
    const edits: prose.BlockEdit[] = [
      { op: 'insert_under_heading', headingId: SECTION, markdown: '- the budget is signed off' },
      {
        op: 'insert_under_heading',
        headingId: 'b-a-bullet',
        markdown: '- the pier needs a permit',
      },
    ];
    const repair = repairNotesEditAddresses(
      edits,
      [applied('insert_under_heading'), failed('insert_under_heading', 'not-a-heading')],
      SECTION,
    );
    expect(repair.edits).toEqual([
      { op: 'insert_under_heading', headingId: SECTION, markdown: '- the pier needs a permit' },
    ]);
  });
});

describe('what is deliberately left alone', () => {
  test('a batch where everything landed', () => {
    const repair = repairNotesEditAddresses(
      [{ op: 'insert_under_heading', headingId: SECTION, markdown: '- a note' }],
      [applied('insert_under_heading')],
      SECTION,
    );
    expect(repair.edits).toEqual([]);
    expect(repair.repaired).toEqual([]);
  });

  // THE WORDS WERE THE PROBLEM, NOT THE ADDRESS. Re-addressing an edit whose
  // markdown parsed to nothing writes a blank note, which is the failure
  // `notes-edit-guard.ts` RULE 3 exists to prevent.
  test('an edit that carried no words — `empty` and `parse-failed`', () => {
    for (const error of ['empty', 'parse-failed']) {
      const repair = repairNotesEditAddresses(
        [{ op: 'insert_under_heading', headingId: SECTION, markdown: '   ' }],
        [failed('insert_under_heading', error)],
        SECTION,
      );
      expect(repair.edits).toEqual([]);
    }
  });

  // A move or a delete that failed moved nothing. Recovering it would mean
  // inventing a note out of an edit that never carried one.
  test('a failed move or delete', () => {
    const edits: prose.BlockEdit[] = [
      { op: 'nest_blocks', leadBlockId: 'b-1', blockIds: ['b-gone'] },
      { op: 'delete_block', blockId: 'b-gone' },
    ];
    const repair = repairNotesEditAddresses(
      edits,
      [failed('nest_blocks', 'unknown-block'), failed('delete_block', 'unknown-block')],
      SECTION,
    );
    expect(repair.edits).toEqual([]);
  });

  // PAIRING IS POSITIONAL, so a verdict list of another length cannot be
  // trusted to say which edit failed — and a mispairing would re-write an
  // edit that landed, putting a note in the doc twice.
  test('a verdict list that does not line up with the edits', () => {
    const repair = repairNotesEditAddresses(
      [{ op: 'insert_under_heading', headingId: 'b-a-bullet', markdown: '- a note' }],
      [failed('insert_under_heading', 'not-a-heading'), failed('replace_block', 'unknown-block')],
      SECTION,
    );
    expect(repair.edits).toEqual([]);
  });
});
