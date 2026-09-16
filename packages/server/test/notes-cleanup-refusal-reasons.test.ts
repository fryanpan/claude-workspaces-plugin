/**
 * EVERY REFUSED CLEANUP EDIT SAYS WHY.
 *
 * The pass used to report a count: "16 edits proposed, 16 refused, 0 blocks
 * touched". That line is the same whether the model proposed sixteen bad
 * edits or whether every note the meeting wrote had landed outside its own
 * section — and on the run that prompted this it was the second, which
 * nothing in the log could say. The reason for each drop was computed inside
 * the gate and thrown away.
 *
 * These cases drive a real refusal and read the reason back, through the gate
 * directly and through a whole pass over a real document.
 *
 * All notes and all names are invented. The repo is public.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { runNotesCleanupPass } from '../src/notes-cleanup-pass.ts';
import { boundByAuthorship } from '../src/notes-cleanup-scope.ts';
import {
  DOC,
  MEETING,
  NOTES,
  depsFor,
  docStoreFrom,
  dropFreshDirs,
  freshDir,
  idOf,
  stubComposer,
  writeTranscript,
} from './notes-cleanup-fixture.ts';

afterEach(dropFreshDirs);

const scope = {
  blocks: new Set(['h1', 'b1', 'b2']),
  headings: new Set(['h1']),
  listItems: new Map([
    ['b1', 0],
    ['b2', 0],
  ]),
  owned: new Set(['h1', 'b1']),
  headingId: 'h1',
};

describe('the gate names the rule it dropped an edit for', () => {
  it('an edit naming a block the document does not hold says so, and names it', () => {
    const { reasons, refused } = boundByAuthorship(
      [{ op: 'replace_block', blockId: 'elsewhere', markdown: '- rewritten' }],
      scope,
    );
    expect(refused).toBe(1);
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain('elsewhere');
    expect(reasons[0]).toContain('not in the document');
  });

  it('an insert under a heading the document does not hold says which heading', () => {
    const { reasons } = boundByAuthorship(
      [{ op: 'insert_under_heading', headingId: 'h-agenda', markdown: '- a note' }],
      scope,
    );
    expect(reasons[0]).toContain('h-agenda');
    expect(reasons[0]).toContain('not in the document');
  });

  it('the section heading itself is named as the section heading, not as absent', () => {
    const { reasons } = boundByAuthorship([{ op: 'delete_block', blockId: 'h1' }], scope);
    expect(reasons[0]).toContain('section heading');
  });

  it('a commented block says a comment, not ownership', () => {
    const { reasons } = boundByAuthorship([{ op: 'delete_block', blockId: 'b1' }], {
      ...scope,
      commented: new Set(['b1']),
    });
    expect(reasons[0]).toContain('commented');
    // Control: the same op with no thread on the block is KEPT, so the
    // sentence above is the comment and not the verb.
    expect(boundByAuthorship([{ op: 'delete_block', blockId: 'b1' }], scope).reasons).toEqual([]);
  });

  it('an unowned block says the document does not record it as the note-taker’s', () => {
    const { reasons } = boundByAuthorship([{ op: 'delete_block', blockId: 'b2' }], scope);
    expect(reasons[0]).toContain('does not record');
  });

  it('insert_at_end says a cleanup may not open a second section', () => {
    const { reasons } = boundByAuthorship(
      [{ op: 'insert_at_end', markdown: '## Meeting notes' }],
      scope,
    );
    expect(reasons[0]).toContain('second notes section');
  });

  it('a nest is not dropped for ownership at all, nor for a comment', () => {
    // STRUCTURE IS FREE (2026-09-15). `b2` is unowned AND carries a thread,
    // and neither is a bar to moving it: the move re-creates no text, so the
    // words and the anchor both ride along.
    const { kept, reasons } = boundByAuthorship(
      [{ op: 'nest_blocks', leadBlockId: 'b1', blockIds: ['b2'] }],
      { ...scope, commented: new Set(['b2']) },
    );
    expect(kept).toHaveLength(1);
    expect(reasons).toEqual([]);
  });

  it('a nest naming a block the document does not hold says that, not the comment', () => {
    // The reason sentence a nest CAN give, and the control on the case above:
    // when a nest is dropped it is for an id nothing answers to.
    const { reasons } = boundByAuthorship(
      [{ op: 'nest_blocks', leadBlockId: 'b1', blockIds: ['gone'] }],
      { ...scope, commented: new Set(['b1']) },
    );
    expect(reasons[0]).toContain('gone');
    expect(reasons[0]).toContain('not in the document');
    expect(reasons[0]).not.toContain('commented');
  });

  it('and a replace of that same block still says the comment', () => {
    // The control on the case above: the comment clause is alive, it is just
    // not asked on a nest. Same block, same scope, an op that DOES consult it.
    const { reasons } = boundByAuthorship(
      [{ op: 'replace_block', blockId: 'b1', markdown: '- reworded' }],
      { ...scope, commented: new Set(['b1']) },
    );
    expect(reasons[0]).toContain('commented');
  });

  it('a clean batch carries no reasons at all', () => {
    const { reasons, refused } = boundByAuthorship(
      [{ op: 'insert_under_heading', headingId: 'h1', markdown: '- added' }],
      scope,
    );
    expect(refused).toBe(0);
    expect(reasons).toEqual([]);
  });
});

describe('a whole pass reports why, not only how many', () => {
  it('a pass whose edit named a block the document no longer holds says that', async () => {
    const { store, markdownNow } = docStoreFrom(
      [NOTES, '', '## Agenda', '', '- ship the ferry timetable'].join('\n'),
      ['Meeting notes'],
    );
    const dataDir = freshDir();
    writeTranscript(dataDir, [
      { turn: 1, text: 'the timetable needs two sailings a day' },
      { turn: 2, text: 'and the agenda line about shipping it is out of date' },
    ]);
    const before = markdownNow();
    // A block id nothing in the document answers to — the shape a model
    // produces when it names a bullet that has since been deleted.
    const composer = stubComposer([
      { op: 'replace_block', blockId: 'b-gone', markdown: '- the timetable already shipped' },
    ]);
    const result = await runNotesCleanupPass(
      depsFor(store, composer, dataDir, idOf(store, 'Meeting notes')),
      { docId: DOC, meetingId: MEETING },
    );
    expect(result.ok).toBe(true);
    expect(result.proposed).toBe(1);
    expect(result.refused).toBe(1);
    expect(result.touched).toBe(0);
    expect(result.refusals).toHaveLength(1);
    expect(result.refusals[0]).toContain('not in the document');
    expect(result.line).toContain('not in the document');
    // And nothing moved: the document is exactly as the person left it.
    expect(markdownNow()).toBe(before);
  });

  it('and the same pass over a block outside the section is not refused at all', async () => {
    // THE CONTROL THAT SAYS WHICH RULE FIRED. This case used to be the one
    // above: a replace naming the doc body, refused for location. The only
    // difference here is that the block EXISTS, and the pass now reaches it.
    const { store, markdownNow } = docStoreFrom(
      [NOTES, '', '## Agenda', '', '- ship the ferry timetable'].join('\n'),
      ['Meeting notes'],
    );
    const dataDir = freshDir();
    writeTranscript(dataDir, [{ turn: 1, text: 'the timetable already shipped last week' }]);
    const composer = stubComposer([
      {
        op: 'replace_block',
        blockId: idOf(store, 'ship the ferry timetable'),
        markdown: '- the timetable already shipped',
      },
    ]);
    const result = await runNotesCleanupPass(
      depsFor(store, composer, dataDir, idOf(store, 'Meeting notes')),
      { docId: DOC, meetingId: MEETING },
    );
    expect(result.refused).toBe(0);
    expect(result.refusals).toEqual([]);
    expect(result.touched).toBe(1);
    expect(markdownNow()).toContain('the timetable already shipped');
  });
});
