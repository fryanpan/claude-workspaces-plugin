/**
 * WHAT THE TIDY-UP CAN REACH, once the boundary is authorship rather than
 * location (Bryan, 2026-09-15). The sibling file
 * `notes-cleanup-authorship.test.ts` is the two-sided rule itself — a
 * person's bullet moved, a person's words offered. This one is the edges of
 * the reach that widening the gate opened, each measured on the document
 * before it was changed:
 *
 * - a heading standing between the lead and the bullet is not a wall to a
 *   move, and is not itself a thing to move;
 * - a repeat of a note the document already carries is DROPPED, never lifted
 *   out of wherever it sits;
 * - a nest names bullets, and says so when what it named is not one;
 * - another meeting's section on the same doc is out of reach entirely,
 *   because one author id cannot tell two meetings apart.
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
