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
import type { NotesComposer } from '../src/meeting-notes.ts';
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
 * A PERSON TYPING WHILE THE MODEL THINKS.
 *
 * A compose is a network call taking seconds, and the doc is live the whole
 * time. Somebody typing into one of the note-taker's bullets is exactly how
 * the mark comes off it (`clearAuthorshipOnPersonEdit`), so a gate built from
 * the outline the PROMPT was given would still have that block marked ours
 * and would rewrite the words they had just finished writing.
 */
describe('a block that changes hands while the compose is in flight', () => {
  /** A composer that does something to the doc before it answers. */
  const composerThat = (
    beforeAnswering: () => void,
    edits: readonly prose.BlockEdit[],
  ): NotesComposer => ({
    name: 'mid-compose',
    compose: () => {
      beforeAnswering();
      return Promise.resolve(edits);
    },
  });

  it('offers rather than rewrites, because the gate is read after the compose', async () => {
    const { store, ydoc, markdownNow } = docStoreFrom(NOTES, ['Meeting notes']);
    const dataDir = freshDir();
    writeTranscript(dataDir, [{ turn: 0, text: 'The harbour run moves to the half hour.' }]);
    const target = idOf(store, 'harbour run');
    const rewrite: prose.BlockEdit[] = [
      { op: 'replace_block', blockId: target, markdown: '- Harbour run: half-hourly from April' },
    ];
    const theyType = (): void => {
      const el = prose.findBlockById(prose.getProseFragment(ydoc), target);
      el?.removeAttribute(prose.BLOCK_AUTHOR_ATTR);
    };
    const before = markdownNow();
    const result = await runNotesCleanupPass(
      depsFor(store, composerThat(theyType, rewrite), dataDir, idOf(store, 'Meeting notes')),
      { docId: DOC, meetingId: MEETING },
    );
    expect(result.applied).toBe(0);
    expect(result.suggested).toBe(1);
    const pending = suggestOps.listSuggestions(ydoc);
    expect(pending).toHaveLength(1);
    suggestOps.rejectSuggestion(ydoc, pending[0]?.sid ?? '');
    expect(markdownNow()).toBe(before);
  });

  it('rewrites the same block when nobody touched it — the control', async () => {
    // Same doc, same edit, same composer shape. The only difference is that
    // the mark is still there when the answer comes back, which is what makes
    // the offer above the person's edit rather than something else.
    const { store, markdownNow } = docStoreFrom(NOTES, ['Meeting notes']);
    const dataDir = freshDir();
    writeTranscript(dataDir, [{ turn: 0, text: 'The harbour run moves to the half hour.' }]);
    const result = await runNotesCleanupPass(
      depsFor(
        store,
        composerThat(() => {}, [
          {
            op: 'replace_block',
            blockId: idOf(store, 'harbour run'),
            markdown: '- Harbour run: half-hourly from April',
          },
        ]),
        dataDir,
        idOf(store, 'Meeting notes'),
      ),
      { docId: DOC, meetingId: MEETING },
    );
    expect(result.applied).toBe(1);
    expect(result.suggested).toBe(0);
    expect(markdownNow()).toContain('Harbour run: half-hourly from April');
  });
});

/**
 * A RECORDING THAT STARTS WHILE THE MODEL IS THINKING.
 *
 * It takes the document out from under the answer. A live note-taker is now
 * composing into the same section against speech this pass never heard, and
 * starting a meeting releases every authorship mark on the doc, so the pass
 * can no longer tell its own work from anybody's. Its answer is about a
 * meeting that has ended; the notes are about one that is running.
 */
describe('a meeting that starts while the pass is composing', () => {
  it('writes nothing at all, and says which of the two it is', async () => {
    const { store, ydoc, markdownNow } = docStoreFrom(NOTES, ['Meeting notes'], ['Kestrel Lane']);
    const dataDir = freshDir();
    writeTranscript(dataDir, [{ turn: 0, text: 'Kestrel Lane keeps the winter crew.' }]);
    const before = markdownNow();
    let recording = false;
    const deps = {
      ...depsFor(
        store,
        {
          name: 'starts-a-meeting',
          compose: () => {
            // What `releaseNotesAuthorship` does when the next recording
            // starts: every mark on the doc goes, and unmarked then reads as
            // nobody's rather than as a person's.
            recording = true;
            prose.releaseAuthorship(ydoc, 'meeting-notes');
            return Promise.resolve([
              {
                op: 'replace_block' as const,
                blockId: idOf(store, 'Kestrel Lane'),
                markdown: '- Kestrel Lane keeps the winter crew until April',
              },
            ]);
          },
        },
        dataDir,
        idOf(store, 'Meeting notes'),
      ),
      recordingNow: () => recording,
    };
    const result = await runNotesCleanupPass(deps, { docId: DOC, meetingId: MEETING });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('recording');
    expect(markdownNow()).toBe(before);
    expect(suggestOps.listSuggestions(ydoc)).toHaveLength(0);
  });

  it('runs normally when nothing started — the control', async () => {
    // The same doc, the same edit, and nothing recording. The pass runs and
    // files its offer, which is what makes the refusal above the meeting.
    const { store, markdownNow } = docStoreFrom(NOTES, ['Meeting notes'], ['Kestrel Lane']);
    const dataDir = freshDir();
    writeTranscript(dataDir, [{ turn: 0, text: 'Kestrel Lane keeps the winter crew.' }]);
    const result = await runNotesCleanupPass(
      {
        ...depsFor(
          store,
          stubComposer([
            {
              op: 'replace_block',
              blockId: idOf(store, 'Kestrel Lane'),
              markdown: '- Kestrel Lane keeps the winter crew until April',
            },
          ]),
          dataDir,
          idOf(store, 'Meeting notes'),
        ),
        recordingNow: () => false,
      },
      { docId: DOC, meetingId: MEETING },
    );
    expect(result.ok).toBe(true);
    expect(result.suggested).toBe(1);
    expect(markdownNow()).toContain('Kestrel Lane keeps the winter crew');
  });
});

/**
 * A SECTION LINE ON A DOC WHOSE MARKS HAVE ALL BEEN LOST.
 *
 * `cwAuthor` does not survive a markdown round trip, `releaseNotesAuthorship`
 * drops every mark when the next recording starts, and a person editing the
 * last marked block clears the last one by hand. The document records no
 * difference between those, so it cannot say whether an unmarked line in the
 * section is the note-taker's old work or something a person typed there.
 *
 * An earlier reading of this PR resolved that in the pass's favour and
 * rewrote the line. This is the same fixture and the same edit, resolved the
 * other way — with the control immediately below it, so that "offers" is not
 * quietly "never rewrites anything any more".
 */
describe('an unmarked line in the section, on a doc that records no authors at all', () => {
  const THEIRS = 'The harbour run moves to the half hour from April';

  it('is offered on, and is byte-identical afterwards', async () => {
    const { store, ydoc, markdownNow } = docStoreFrom(NOTES, []);
    const dataDir = freshDir();
    writeTranscript(dataDir, [{ turn: 0, text: 'The harbour run moves to the half hour.' }]);
    const target = idOf(store, 'harbour run');
    const before = markdownNow();
    const result = await runNotesCleanupPass(
      depsFor(
        store,
        stubComposer([
          {
            op: 'replace_block',
            blockId: target,
            markdown: '- Harbour run: half-hourly from April',
          },
        ]),
        dataDir,
        idOf(store, 'Meeting notes'),
      ),
      { docId: DOC, meetingId: MEETING },
    );
    expect(result.refused).toBe(0);
    expect(result.suggested).toBe(1);
    expect(result.applied).toBe(0);

    const pending = suggestOps.listSuggestions(ydoc);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.deletedText).toBe(THEIRS);
    expect(pending[0]?.insertedText).toBe('Harbour run: half-hourly from April');
    // The block is still unclaimed: the pass wrote no mark to make the line
    // its own, so the next pass offers all over again rather than rewriting.
    expect(prose.readOutline(ydoc).find((b) => b.id === target)?.author).toBeUndefined();

    // The whole of what "do not rewrite human text" means here: saying no
    // gives the document back exactly as it was.
    expect(markdownNow()).toContain(THEIRS);
    suggestOps.rejectSuggestion(ydoc, pending[0]?.sid ?? '');
    expect(markdownNow()).toBe(before);
  });

  it("is rewritten outright when the doc DOES record it as the pass's own — the control", async () => {
    // Identical fixture, identical edit; the one difference is the mark. Without
    // this, turning every edit in the file into a suggestion would pass too.
    const { store, ydoc, markdownNow } = docStoreFrom(NOTES, ['Meeting notes']);
    const dataDir = freshDir();
    writeTranscript(dataDir, [{ turn: 0, text: 'The harbour run moves to the half hour.' }]);
    const result = await runNotesCleanupPass(
      depsFor(
        store,
        stubComposer([
          {
            op: 'replace_block',
            blockId: idOf(store, 'harbour run'),
            markdown: '- Harbour run: half-hourly from April',
          },
        ]),
        dataDir,
        idOf(store, 'Meeting notes'),
      ),
      { docId: DOC, meetingId: MEETING },
    );
    expect(result.applied).toBe(1);
    expect(result.suggested).toBe(0);
    expect(suggestOps.listSuggestions(ydoc)).toHaveLength(0);
    expect(markdownNow()).toContain('Harbour run: half-hourly from April');
    expect(markdownNow()).not.toContain(THEIRS);
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
