/**
 * What a tidy-up does with a line that is not its own.
 *
 * Bryan's rule (2026-09-10): *"do not rewrite human text. But if you spot an
 * improvement, use the suggest and edit tool to suggest an edit."* Three
 * outcomes, not two, and this file is the third of them — the one a
 * gate-level test cannot show, because what makes an offer an offer is what
 * the DOCUMENT looks like afterwards: a pending redline, the block still
 * unclaimed, and their words byte-identical until they answer.
 *
 * A PERSON'S BULLET, INSIDE THE NOTE-TAKER'S OWN SECTION, is the case
 * criterion 2.3 is about. The doc still carries the note-taker's marks, and
 * one bullet in the middle of its section carries none — because a person
 * typed it there during the meeting, or because they edited one of the
 * note-taker's and `clearAuthorshipOnPersonEdit` handed it back. The doc
 * records those two the same way, and both are theirs. The section check does
 * not cover it: the person's line in `NOTES` sits ABOVE the meeting heading,
 * so it is out of reach on section membership alone and proves nothing about
 * ownership; this one is inside the section, where only `claimable` stands
 * between it and a rewrite.
 *
 * All notes and all speech here are invented and every name is fictional.
 * The repo is public.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { prose, suggestOps } from '@claude-workspaces/core';
import { runNotesCleanupPass } from '../src/notes-cleanup-pass.ts';
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

/**
 * A PERSON'S BULLET, INSIDE THE NOTE-TAKER'S OWN SECTION.
 *
 * This is the case criterion 2.3 is about and the one the loosened gate had
 * to keep refusing. The doc still carries the note-taker's marks, and one
 * bullet in the middle of its section carries none — because a person typed
 * it there during the meeting, or because they edited one of the note-taker's
 * and `clearAuthorshipOnPersonEdit` handed it back. The doc records those two
 * the same way, and both are theirs.
 *
 * The section check does not cover it. The person's line in `NOTES` sits
 * ABOVE the meeting heading, so it is out of reach on section membership
 * alone and proves nothing about ownership; this one is inside the section,
 * where only `claimable` stands between it and a rewrite.
 */
describe("a person's bullet inside the section, on a doc whose marks are live", () => {
  const THEIRS = 'Kestrel Lane keeps the winter crew';

  it('reaches them as a suggestion, and their words do not change until they answer', async () => {
    // THE CASE BRYAN ANSWERED ON 2026-09-10: "do not rewrite human text. But
    // if you spot an improvement, use the suggest and edit tool to suggest an
    // edit." Dropping the edit and rewriting the line are both wrong; the
    // third answer is the one this proves.
    const { store, ydoc, markdownNow } = docStoreFrom(NOTES, ['Meeting notes'], ['Kestrel Lane']);
    const dataDir = freshDir();
    writeTranscript(dataDir, [
      { turn: 0, text: 'Kestrel Lane keeps the winter crew until April.', speaker: 'B' },
    ]);
    const before = markdownNow();
    const theirs = idOf(store, 'Kestrel Lane');
    const result = await runNotesCleanupPass(
      depsFor(
        store,
        stubComposer([
          {
            op: 'replace_block',
            blockId: theirs,
            markdown: '- Kestrel Lane keeps the winter crew until April',
          },
        ]),
        dataDir,
        idOf(store, 'Meeting notes'),
      ),
      { docId: DOC, meetingId: MEETING },
    );
    expect(result.refused).toBe(0);
    expect(result.suggested).toBe(1);
    // NOT applied. The two ownership rules have to disagree here, and the
    // pass claiming the block would make them agree the wrong way.
    expect(result.applied).toBe(0);

    // A real pending proposal on their own words: theirs struck, the offer
    // inserted beside it.
    const pending = suggestOps.listSuggestions(ydoc);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.deletedText).toBe(THEIRS);
    expect(pending[0]?.insertedText).toBe('Kestrel Lane keeps the winter crew until April');
    // And the block is still unclaimed, so their next edit of it is theirs
    // and the next pass offers rather than rewrites all over again.
    expect(prose.readOutline(ydoc).find((b) => b.id === theirs)?.author).toBeUndefined();

    // The proof that their text is untouched: saying no restores the document
    // byte for byte, which it could not do if a rewrite had landed.
    expect(markdownNow()).toContain(THEIRS);
    suggestOps.rejectSuggestion(ydoc, pending[0]?.sid ?? '');
    expect(markdownNow()).toBe(before);
  });

  it('is never deleted and never nested, and neither is offered as a redline', async () => {
    // A strikethrough of somebody's whole note is not an improvement to it,
    // and `applyBlockEdits` cannot express a move as a suggestion at all.
    const { store, ydoc, markdownNow } = docStoreFrom(NOTES, ['Meeting notes'], ['Kestrel Lane']);
    const dataDir = freshDir();
    writeTranscript(dataDir, [{ turn: 0, text: 'Kestrel Lane keeps the winter crew.' }]);
    const before = markdownNow();
    const result = await runNotesCleanupPass(
      depsFor(
        store,
        stubComposer([
          { op: 'delete_block', blockId: idOf(store, 'Kestrel Lane') },
          {
            op: 'nest_blocks',
            leadBlockId: idOf(store, 'harbour run'),
            blockIds: [idOf(store, 'Kestrel Lane')],
          },
        ]),
        dataDir,
        idOf(store, 'Meeting notes'),
      ),
      { docId: DOC, meetingId: MEETING },
    );
    expect(result.refused).toBe(2);
    expect(result.suggested).toBe(0);
    expect(result.touched).toBe(0);
    expect(suggestOps.listSuggestions(ydoc)).toHaveLength(0);
    expect(markdownNow()).toBe(before);
  });

  it('is named to the model as theirs, and is not in what the pass claims', async () => {
    // A gate the prompt contradicts is only half a rule. The model is told
    // the same thing the gate enforces, so it does not spend a pass proposing
    // edits that will be dropped.
    const { store } = docStoreFrom(NOTES, ['Meeting notes'], ['Kestrel Lane']);
    const dataDir = freshDir();
    writeTranscript(dataDir, [{ turn: 0, text: 'Kestrel Lane keeps the winter crew.' }]);
    const composer = stubComposer([]);
    await runNotesCleanupPass(depsFor(store, composer, dataDir, idOf(store, 'Meeting notes')), {
      docId: DOC,
      meetingId: MEETING,
    });
    const input = composer.seen[0];
    expect(input?.humanNotes).toContain('Kestrel Lane keeps the winter crew');
    expect(input?.claimed?.has(idOf(store, 'Kestrel Lane'))).toBe(false);
    // And the note-taker's own bullet beside it IS claimed.
    expect(input?.claimed?.has(idOf(store, 'harbour run'))).toBe(true);
  });
});
/**
 * AND A BLOCK ANOTHER AGENT STILL HOLDS, on a doc whose marks are gone.
 *
 * A release names ONE author, so a second agent's mark outlives the
 * note-taker's. `claimable` reads that block as not-ours in either state, so
 * it takes the same route a person's line does.
 */
describe("another agent's block, on a doc whose marks have all been lost", () => {
  it('offers on a block another agent still holds, rather than rewriting it', async () => {
    // A release names ONE author, so a second agent's mark outlives the
    // note-taker's on a marks-gone doc. That block is not this pass's to
    // rewrite — and it is not nobody's either, so it gets the same offer a
    // person's line gets.
    const { store, ydoc, markdownNow } = docStoreFrom(NOTES, []);
    const held = idOf(store, 'harbour run');
    const el = prose.findBlockById(prose.getProseFragment(ydoc), held);
    expect(el).toBeDefined();
    if (el) prose.setBlockAuthor(el, 'some-other-agent');
    const dataDir = freshDir();
    writeTranscript(dataDir, [{ turn: 0, text: 'The harbour run moves to the half hour.' }]);
    const before = markdownNow();
    const result = await runNotesCleanupPass(
      depsFor(
        store,
        stubComposer([
          { op: 'replace_block', blockId: held, markdown: '- Harbour run: half-hourly from April' },
        ]),
        dataDir,
        idOf(store, 'Meeting notes'),
      ),
      { docId: DOC, meetingId: MEETING },
    );
    expect(result.applied).toBe(0);
    expect(result.suggested).toBe(1);
    // Its owner keeps it: the pass never stamped its own mark over theirs.
    expect(prose.readOutline(ydoc).find((b) => b.id === held)?.author).toBe('some-other-agent');
    const pending = suggestOps.listSuggestions(ydoc);
    expect(pending).toHaveLength(1);
    suggestOps.rejectSuggestion(ydoc, pending[0]?.sid ?? '');
    expect(markdownNow()).toBe(before);
  });
});
