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
import { confineToSection } from '../src/notes-cleanup-scope.ts';
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
  owned: new Set(['h1', 'b1']),
  headingId: 'h1',
};

describe('the gate names the rule it dropped an edit for', () => {
  it('an edit aimed outside the section says so, and names the block', () => {
    const { reasons, refused } = confineToSection(
      [{ op: 'replace_block', blockId: 'elsewhere', markdown: '- rewritten' }],
      scope,
    );
    expect(refused).toBe(1);
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain('elsewhere');
    expect(reasons[0]).toContain('outside this meeting');
  });

  it('an insert under a heading outside the section says which heading', () => {
    const { reasons } = confineToSection(
      [{ op: 'insert_under_heading', headingId: 'h-agenda', markdown: '- a note' }],
      scope,
    );
    expect(reasons[0]).toContain('h-agenda');
    expect(reasons[0]).toContain('outside');
  });

  it('the section heading itself is named as the section heading, not as absent', () => {
    const { reasons } = confineToSection([{ op: 'delete_block', blockId: 'h1' }], scope);
    expect(reasons[0]).toContain('section heading');
  });

  it('a commented block says a comment, not ownership', () => {
    const { reasons } = confineToSection([{ op: 'delete_block', blockId: 'b1' }], {
      ...scope,
      commented: new Set(['b1']),
    });
    expect(reasons[0]).toContain('commented');
    // Control: the same op with no thread on the block is KEPT, so the
    // sentence above is the comment and not the verb.
    expect(confineToSection([{ op: 'delete_block', blockId: 'b1' }], scope).reasons).toEqual([]);
  });

  it('an unowned block says the document does not record it as the note-taker’s', () => {
    const { reasons } = confineToSection([{ op: 'delete_block', blockId: 'b2' }], scope);
    expect(reasons[0]).toContain('does not record');
  });

  it('insert_at_end says a cleanup may not open a second section', () => {
    const { reasons } = confineToSection(
      [{ op: 'insert_at_end', markdown: '## Meeting notes' }],
      scope,
    );
    expect(reasons[0]).toContain('second notes section');
  });

  it('a clean batch carries no reasons at all', () => {
    const { reasons, refused } = confineToSection(
      [{ op: 'insert_under_heading', headingId: 'h1', markdown: '- added' }],
      scope,
    );
    expect(refused).toBe(0);
    expect(reasons).toEqual([]);
  });
});

describe('a whole pass reports why, not only how many', () => {
  it('a pass whose every edit named the doc body says that in its line', async () => {
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
    // The model answers about the AGENDA, which is outside the section.
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
    expect(result.ok).toBe(true);
    expect(result.proposed).toBe(1);
    expect(result.refused).toBe(1);
    expect(result.touched).toBe(0);
    expect(result.refusals).toHaveLength(1);
    expect(result.refusals[0]).toContain('outside this meeting');
    expect(result.line).toContain('outside this meeting');
    // And nothing moved: the agenda is exactly as the person left it.
    expect(markdownNow()).toBe(before);
  });
});
