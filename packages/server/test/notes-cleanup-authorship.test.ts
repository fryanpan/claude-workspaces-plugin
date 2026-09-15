/**
 * THE TIDY-UP'S BOUNDARY IS AUTHORSHIP, NOT LOCATION (Bryan, 2026-09-15).
 *
 * Two sides, and this file is both of them on a real document:
 *
 * - **Structure is free.** The pass may move and renest any block in the
 *   document, including ones a person wrote. A move keeps every word, every
 *   inline mark, the block id and the `cwAuthor` attribute, so nothing of
 *   theirs changes except where it sits.
 * - **Words are not.** A better WORDING of a person's line arrives as a
 *   redline suggestion on their own block, byte-identical until they answer.
 *
 * Each case asserts the DOCUMENT — the markdown after the pass — rather than
 * the counters the pass reported about itself. A counter is bookkeeping; a
 * bullet in the wrong place, or a person's words overwritten, is the
 * behaviour.
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

/** Their line, typed into the middle of the note-taker's own section. */
const THEIRS = 'Kestrel Lane keeps the winter crew';
/** The note-taker's own bullet beside it. */
const OURS = 'The harbour run moves to the half hour from April';

describe('structure is free — the pass may reorder a person’s bullets', () => {
  it('nests their bullet under the note-taker’s lead, and their words come through unchanged', async () => {
    const { store, ydoc, markdownNow } = docStoreFrom(NOTES, ['Meeting notes'], ['Kestrel Lane']);
    const dataDir = freshDir();
    writeTranscript(dataDir, [
      { turn: 0, text: 'The harbour run moves to the half hour from April.' },
      { turn: 1, text: 'Kestrel Lane keeps the winter crew.' },
    ]);
    const theirs = idOf(store, 'Kestrel Lane');
    // CONTROL: the doc records the block as nobody's — a person typed it, or
    // edited one of the note-taker's. If it were the pass's own this case
    // would prove nothing about reaching somebody else's line.
    expect(prose.readOutline(ydoc).find((b) => b.id === theirs)?.author).toBeUndefined();
    expect(markdownNow()).toContain(`- ${THEIRS}`);

    const result = await runNotesCleanupPass(
      depsFor(
        store,
        stubComposer([
          { op: 'nest_blocks', leadBlockId: idOf(store, 'harbour run'), blockIds: [theirs] },
        ]),
        dataDir,
        idOf(store, 'Meeting notes'),
      ),
      { docId: DOC, meetingId: MEETING },
    );

    expect(result.refused).toBe(0);
    expect(result.applied).toBe(1);
    // THE DOCUMENT. Their bullet now sits UNDER the lead, indented, with the
    // same words it had — and no redline was filed, because a move proposes
    // nothing to answer.
    expect(markdownNow()).toContain(`- ${OURS}\n  - ${THEIRS}`);
    expect(suggestOps.listSuggestions(ydoc)).toHaveLength(0);
    // And it is still theirs afterwards: the move carried the absence of a
    // mark along with the words, so the next pass still offers rather than
    // rewrites.
    expect(prose.readOutline(ydoc).find((b) => b.text === THEIRS)?.author).toBeUndefined();
  });

  it('takes their bullet as the LEAD too — the write path used to refuse that outright', async () => {
    const { store, markdownNow } = docStoreFrom(NOTES, ['Meeting notes'], ['Kestrel Lane']);
    const dataDir = freshDir();
    writeTranscript(dataDir, [{ turn: 0, text: 'Kestrel Lane keeps the winter crew.' }]);
    const result = await runNotesCleanupPass(
      depsFor(
        store,
        stubComposer([
          {
            op: 'nest_blocks',
            leadBlockId: idOf(store, 'Kestrel Lane'),
            blockIds: [idOf(store, 'harbour run')],
          },
        ]),
        dataDir,
        idOf(store, 'Meeting notes'),
      ),
      { docId: DOC, meetingId: MEETING },
    );
    expect(result.refused).toBe(0);
    expect(result.applied).toBe(1);
    expect(markdownNow()).toContain(`- ${THEIRS}\n  - ${OURS}`);
  });
});

describe('words are not — a reword of a person’s bullet comes back as a suggestion', () => {
  it('leaves their words byte-identical and files a redline they answer', async () => {
    const { store, ydoc, markdownNow } = docStoreFrom(NOTES, ['Meeting notes'], ['Kestrel Lane']);
    const dataDir = freshDir();
    writeTranscript(dataDir, [
      { turn: 0, text: 'Kestrel Lane keeps the winter crew until April.' },
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
            markdown: `- ${THEIRS} until April`,
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
    // THE DOCUMENT. Their line still reads exactly as they left it, and
    // rejecting the offer restores the file byte for byte — which it could
    // not do if a rewrite had landed.
    expect(markdownNow()).toContain(THEIRS);
    suggestOps.rejectSuggestion(ydoc, pending[0]?.sid ?? '');
    expect(markdownNow()).toBe(before);
  });

  it('but revises its OWN bullet outright, with no offer to answer', async () => {
    // The control that says the suggestion above is about authorship and not
    // about the verb: the same op, on the note-taker's own line.
    const { store, ydoc, markdownNow } = docStoreFrom(NOTES, ['Meeting notes'], ['Kestrel Lane']);
    const dataDir = freshDir();
    writeTranscript(dataDir, [{ turn: 0, text: 'The harbour run moves to the half hour.' }]);
    const result = await runNotesCleanupPass(
      depsFor(
        store,
        stubComposer([
          {
            op: 'replace_block',
            blockId: idOf(store, 'harbour run'),
            markdown: '- The harbour run moves to the half hour from 1 April',
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
    expect(markdownNow()).toContain('from 1 April');
  });
});

describe('a meeting whose notes landed outside the heading it opened', () => {
  it('is tidied rather than refused wholesale — the sixteen-refusals shape', async () => {
    // The 2026-09-15 pass proposed sixteen edits and had all sixteen refused,
    // because the notes it was tidying were not under the heading the meeting
    // had opened. Here the note-taker's own bullets sit under a LATER heading
    // and the pass reaches every one of them.
    const doc = [
      '# Riverbend ferry review',
      '',
      'My own line about the slipway, which nobody may rewrite.',
      '',
      '## Meeting notes',
      '',
      '## Ferry timetable',
      '',
      '- The harbour run moves to the half hour from April',
      '- Kestrel Lane keeps the winter crew',
    ].join('\n');
    const { store, markdownNow } = docStoreFrom(doc, ['Ferry timetable']);
    const dataDir = freshDir();
    writeTranscript(dataDir, [
      { turn: 0, text: 'The harbour run moves to the half hour from April.' },
      { turn: 1, text: 'Kestrel Lane keeps the winter crew, and the slipway work slips.' },
    ]);
    const outside = idOf(store, 'harbour run');
    const result = await runNotesCleanupPass(
      depsFor(
        store,
        stubComposer([
          // The nest goes FIRST: a `replace_block` re-creates the element it
          // names, so a nest naming the same lead afterwards would be naming
          // a block id that no longer exists.
          { op: 'nest_blocks', leadBlockId: outside, blockIds: [idOf(store, 'Kestrel Lane')] },
          {
            op: 'replace_block',
            blockId: outside,
            markdown: '- The harbour run moves to the half hour from 1 April',
          },
          {
            op: 'insert_under_heading',
            headingId: idOf(store, 'Ferry timetable'),
            markdown: '- The slipway work slips',
          },
        ]),
        dataDir,
        idOf(store, 'Meeting notes'),
      ),
      { docId: DOC, meetingId: MEETING },
    );
    expect(result.proposed).toBe(3);
    expect(result.refused).toBe(0);
    expect(result.refusals).toEqual([]);
    // THE DOCUMENT: the revision landed, the new note is under the topic, and
    // the second bullet moved under the first.
    const after = markdownNow();
    expect(after).toContain('from 1 April');
    expect(after).toContain('The slipway work slips');
    expect(after).toContain('  - Kestrel Lane keeps the winter crew');
  });

  it('does not restate a note it already wrote out there', async () => {
    // THE OTHER HALF OF WIDENING THE GATE. Admitting an insert under a
    // heading the section does not reach, while still judging repeats by
    // section membership, would let the pass write a second copy of every
    // note it had already made — on precisely the document this change is
    // for. The dedupe counts the pass's own notes wherever they landed
    // (`NotesDedupeContext.ownedElsewhere`).
    const doc = [
      '# Riverbend ferry review',
      '',
      '## Meeting notes',
      '',
      '## Ferry timetable',
      '',
      '- The harbour run moves to the half hour from April',
    ].join('\n');
    const { store, markdownNow } = docStoreFrom(doc, ['Ferry timetable']);
    const dataDir = freshDir();
    writeTranscript(dataDir, [
      { turn: 0, text: 'The harbour run moves to the half hour from April.' },
    ]);
    const result = await runNotesCleanupPass(
      depsFor(
        store,
        stubComposer([
          {
            op: 'insert_under_heading',
            headingId: idOf(store, 'Ferry timetable'),
            markdown: '- The harbour run moves to the half hour from April',
          },
        ]),
        dataDir,
        idOf(store, 'Meeting notes'),
      ),
      { docId: DOC, meetingId: MEETING },
    );
    expect(result.alreadyWritten).toBe(1);
    expect(result.touched).toBe(0);
    // THE DOCUMENT: one copy, not two.
    const after = markdownNow();
    expect(after.split('The harbour run moves to the half hour from April')).toHaveLength(2);
  });

  it('still refuses to touch the person’s line above it, except as an offer', async () => {
    // The widening is about the note-taker's own work being out of place, not
    // about the rest of the document becoming fair game. Their paragraph is
    // reachable now — and what reaches it is a redline, not a rewrite.
    const { store, ydoc, markdownNow } = docStoreFrom(NOTES, ['Meeting notes']);
    const dataDir = freshDir();
    writeTranscript(dataDir, [{ turn: 0, text: 'the slipway work slips to May' }]);
    const before = markdownNow();
    const result = await runNotesCleanupPass(
      depsFor(
        store,
        stubComposer([
          {
            op: 'replace_block',
            blockId: idOf(store, 'slipway'),
            markdown: 'My own line about the slipway, which slips to May.',
          },
          { op: 'delete_block', blockId: idOf(store, 'slipway') },
        ]),
        dataDir,
        idOf(store, 'Meeting notes'),
      ),
      { docId: DOC, meetingId: MEETING },
    );
    // The delete is refused — a strikethrough of somebody's whole line is not
    // an improvement to it. The replace is offered.
    expect(result.refused).toBe(1);
    expect(result.suggested).toBe(1);
    expect(result.applied).toBe(0);
    const pending = suggestOps.listSuggestions(ydoc);
    expect(pending).toHaveLength(1);
    suggestOps.rejectSuggestion(ydoc, pending[0]?.sid ?? '');
    expect(markdownNow()).toBe(before);
  });
});

/**
 * A topic heading between the lead and the bullet, which is the shape the
 * whole change is for: a person's note that landed under somebody else's
 * heading, which the tidy-up is supposed to be able to bring in.
 */
const TWO_TOPICS = [
  '# Riverbend ferry review',
  '',
  'My own line about the slipway, which nobody may rewrite.',
  '',
  '## Meeting notes',
  '',
  '### Ferry timetable',
  '',
  `- ${OURS}`,
  '',
  '### Crew roster',
  '',
  `- ${THEIRS}`,
].join('\n');

describe('a heading between them is not a wall to a move, and is not a thing to move', () => {
  it('brings their bullet in from under another topic’s heading', async () => {
    const { store, markdownNow } = docStoreFrom(TWO_TOPICS, ['Meeting notes'], ['Kestrel Lane']);
    const dataDir = freshDir();
    writeTranscript(dataDir, [{ turn: 0, text: 'The harbour run and the winter crew.' }]);
    // CONTROL: they really are under different headings to begin with — the
    // bullet sits below the second `###`, not beside the lead.
    expect(markdownNow()).toContain(`### Crew roster\n\n- ${THEIRS}`);

    const result = await runNotesCleanupPass(
      depsFor(
        store,
        stubComposer([
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

    // NOT `failed`. The gate kept this edit either way; what changed is
    // whether the move could then be made. A kept edit that fails is the
    // worst of both — the log says nothing a reader can act on.
    expect(result.failed).toBe(0);
    expect(result.refused).toBe(0);
    expect(result.applied).toBe(1);
    expect(markdownNow()).toContain(`- ${OURS}\n  - ${THEIRS}`);
    // And the list the bullet left is gone rather than left behind empty.
    expect(markdownNow()).not.toContain('### Crew roster\n\n-');
  });

  it('refuses a nest that names a heading, with the reason, instead of failing it', async () => {
    const { store, markdownNow } = docStoreFrom(TWO_TOPICS, ['Meeting notes'], ['Kestrel Lane']);
    const dataDir = freshDir();
    writeTranscript(dataDir, [{ turn: 0, text: 'The harbour run and the winter crew.' }]);
    const before = markdownNow();
    const result = await runNotesCleanupPass(
      depsFor(
        store,
        stubComposer([
          {
            op: 'nest_blocks',
            leadBlockId: idOf(store, 'Crew roster'),
            blockIds: [idOf(store, 'harbour run')],
          },
        ]),
        dataDir,
        idOf(store, 'Meeting notes'),
      ),
      { docId: DOC, meetingId: MEETING },
    );
    expect(result.refused).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.refusals[0]).toContain('a heading is not moved under a bullet');
    expect(markdownNow()).toBe(before);
  });
});

describe('the wider set of its own notes drops a repeat; it never moves one', () => {
  /**
   * TWO RECORDINGS ON ONE DOC, which is the only way a block outside this
   * meeting's section still carries the note-taker's mark: a recording
   * STARTING releases every claim in the doc (`releaseNotesAuthorship`), so a
   * finished meeting's minutes are unmarked and invisible to this set. A
   * concurrent one's are not.
   */
  const OTHER_SECTION = [
    '# Riverbend ferry review',
    '',
    'My own line about the slipway, which nobody may rewrite.',
    '',
    '## Meeting notes',
    '',
    '### Timetable',
    '',
    `- ${OURS}`,
    '',
    '## The other recording',
    '',
    '### Crew',
    '',
    `- ${THEIRS}`,
  ].join('\n');

  it('leaves the other section’s bullet exactly where it is', async () => {
    const { store, markdownNow } = docStoreFrom(OTHER_SECTION, ['Meeting notes']);
    const dataDir = freshDir();
    writeTranscript(dataDir, [{ turn: 0, text: 'Kestrel Lane keeps the winter crew.' }]);
    // CONTROL: the other section's bullet carries the note-taker's mark, so
    // the wider set really does reach it — an unmarked one would prove
    // nothing about the clause under test.
    expect(
      prose.readOutline(store.get(DOC)?.ydoc as never).find((b) => b.text === THEIRS)?.author,
    ).toBeDefined();

    const result = await runNotesCleanupPass(
      depsFor(
        store,
        stubComposer([
          {
            op: 'insert_under_heading',
            headingId: idOf(store, 'Timetable'),
            markdown: `- ${THEIRS}`,
          },
        ]),
        dataDir,
        idOf(store, 'Meeting notes'),
      ),
      { docId: DOC, meetingId: MEETING },
    );

    // The note is already in the document, so it is DROPPED — not deleted
    // from where it sits and re-filed under this meeting's topic.
    expect(result.alreadyWritten).toBe(1);
    expect(markdownNow()).toContain(`### Crew\n\n- ${THEIRS}`);
    expect(markdownNow().split(THEIRS).length - 1).toBe(1);
  });
});

describe('a nest names bullets, and says so when it does not', () => {
  it('refuses one naming a paragraph, with the reason, instead of failing it', async () => {
    const { store, markdownNow } = docStoreFrom(NOTES, ['Meeting notes'], ['Kestrel Lane']);
    const dataDir = freshDir();
    writeTranscript(dataDir, [{ turn: 0, text: 'The harbour run and the slipway.' }]);
    const before = markdownNow();
    const result = await runNotesCleanupPass(
      depsFor(
        store,
        stubComposer([
          {
            op: 'nest_blocks',
            leadBlockId: idOf(store, 'harbour run'),
            blockIds: [idOf(store, 'slipway')],
          },
        ]),
        dataDir,
        idOf(store, 'Meeting notes'),
      ),
      { docId: DOC, meetingId: MEETING },
    );
    expect(result.refused).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.refusals[0]).toContain('only bullets are moved under a bullet');
    expect(markdownNow()).toBe(before);
  });
});

describe('another meeting’s section on the same doc is out of reach', () => {
  /**
   * ONE AUTHOR ID FOR EVERY MEETING, so the mark says a meeting wrote a block
   * and never which one. A second recording releases every claim in the doc
   * when it STARTS, so the blocks still carrying the mark when this pass runs
   * are the LATER meeting's and this one's own are bare. Without the
   * subtraction that reads as "all of this is mine to rewrite".
   */
  const TWO_MEETINGS = [
    '# Riverbend ferry review',
    '',
    '## Meeting notes',
    '',
    `- ${OURS}`,
    '',
    '## The later recording',
    '',
    `- ${THEIRS}`,
  ].join('\n');

  it('refuses a rewrite of its bullet, and says which section it is in', async () => {
    const { store, ydoc, markdownNow } = docStoreFrom(TWO_MEETINGS, ['The later recording']);
    const dataDir = freshDir();
    writeTranscript(dataDir, [{ turn: 0, text: 'Kestrel Lane keeps the winter crew until May.' }]);
    const before = markdownNow();
    const theirs = idOf(store, 'Kestrel Lane');
    // CONTROL: their block really does carry this pass's own author id — the
    // subtraction, not a missing mark, is what has to hold it back.
    expect(prose.readOutline(ydoc).find((b) => b.id === theirs)?.author).toBe('meeting-notes');

    const result = await runNotesCleanupPass(
      depsFor(
        store,
        stubComposer([
          {
            op: 'replace_block',
            blockId: theirs,
            markdown: `- ${THEIRS} until May`,
          },
        ]),
        dataDir,
        idOf(store, 'Meeting notes'),
        [idOf(store, 'The later recording')],
      ),
      { docId: DOC, meetingId: MEETING },
    );

    // REFUSED, not offered. A redline would be the kinder answer and there is
    // no way to ask for one: `applyBlockEdits` reads the block's own mark and
    // every meeting writes the same id, so an edit that reaches the write
    // path lands as a direct rewrite. The other meeting's minutes are
    // byte-identical and nothing is pending against them.
    expect(result.applied).toBe(0);
    expect(result.suggested).toBe(0);
    expect(result.refused).toBe(1);
    expect(result.refusals[0]).toContain('another meeting\u2019s section');
    expect(suggestOps.listSuggestions(ydoc)).toHaveLength(0);
    expect(markdownNow()).toBe(before);
  });
});
