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
 * - a nest the write path cannot make says WHY, instead of counting itself
 *   failed and naming nothing.
 *
 * All notes and all speech here are invented and every name is fictional.
 * The repo is public.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { prose } from '@claude-workspaces/core';
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
const THEIRS = 'The winter crew keeps the Saltmarsh run';
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
    const { store, markdownNow } = docStoreFrom(TWO_TOPICS, ['Meeting notes'], ['Saltmarsh run']);
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
            blockIds: [idOf(store, 'Saltmarsh run')],
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
    const { store, markdownNow } = docStoreFrom(TWO_TOPICS, ['Meeting notes'], ['Saltmarsh run']);
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
    writeTranscript(dataDir, [{ turn: 0, text: 'The winter crew keeps the Saltmarsh run.' }]);
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
    const { store, markdownNow } = docStoreFrom(NOTES, ['Meeting notes'], ['Saltmarsh run']);
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

describe('a regroup the move cannot make says why, instead of counting itself failed', () => {
  /**
   * TWO ADDRESSABLE BULLETS THE MOVE STILL CANNOT TAKE, AND THEY ARE ANSWERED
   * IN DIFFERENT PLACES. `nestBlocksUnderLead` gathers members from the
   * lead's own list and the same-kind lists it can reach, so a bullet nested
   * one level down and a bullet in a list of the other kind are both perfect
   * block ids that come back moved nowhere. Before this the pass said "1
   * failed" and named nothing, which is the same unexplainable shape as the
   * sixteen refusals.
   *
   * DEPTH THE GATE CAN SEE, so it refuses it there: the outline carries a
   * list item's depth, the rule is "the lead's own depth", and the reader
   * gets a refusal naming the block. WHICH LIST A BULLET IS IN the outline
   * does NOT carry, so that one still reaches the applier — and the applier's
   * verdict is now printed rather than counted, which is the other half.
   */
  const MIXED = [
    '# Riverbend ferry review',
    '',
    '## Meeting notes',
    '',
    `- ${OURS}`,
    '- A bullet with one beneath it',
    '  - The bullet one level down',
    '',
    '1. A bullet in a list of the other kind',
  ].join('\n');

  it('refuses a bullet nested one level down, naming it', async () => {
    const { store, markdownNow } = docStoreFrom(MIXED, ['Meeting notes']);
    const dataDir = freshDir();
    writeTranscript(dataDir, [{ turn: 0, text: 'The harbour run and the crew.' }]);
    const before = markdownNow();
    const result = await runNotesCleanupPass(
      depsFor(
        store,
        stubComposer([
          {
            op: 'nest_blocks',
            leadBlockId: idOf(store, 'harbour run'),
            blockIds: [idOf(store, 'one level down')],
          },
        ]),
        dataDir,
        idOf(store, 'Meeting notes'),
      ),
      { docId: DOC, meetingId: MEETING },
    );
    expect(result.refused).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.refusals[0]).toContain('nested under another bullet');
    expect(markdownNow()).toBe(before);
  });

  it("names the applier's verdict for a bullet in a list of the other kind", async () => {
    const { store, markdownNow } = docStoreFrom(MIXED, ['Meeting notes']);
    const dataDir = freshDir();
    writeTranscript(dataDir, [{ turn: 0, text: 'The harbour run and the crew.' }]);
    const before = markdownNow();
    const result = await runNotesCleanupPass(
      depsFor(
        store,
        stubComposer([
          {
            op: 'nest_blocks',
            leadBlockId: idOf(store, 'harbour run'),
            blockIds: [idOf(store, 'other kind')],
          },
        ]),
        dataDir,
        idOf(store, 'Meeting notes'),
      ),
      { docId: DOC, meetingId: MEETING },
    );
    // The gate KEPT it — the block is addressable, it is a bullet, and it is
    // at the lead's own depth — so the reason has to come from the applier or
    // from nowhere.
    expect(result.refused).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.failures).toEqual(['nest_blocks: nothing-to-nest']);
    expect(result.line).toContain('1 failed (nest_blocks: nothing-to-nest)');
    expect(markdownNow()).toBe(before);
  });
});

describe('a meeting whose notes landed in an EARLIER meeting’s section is still tidied', () => {
  /**
   * THE TRADE THAT WAS MEASURED AND REVERSED. A first attempt at keeping one
   * meeting out of another's notes subtracted every section any meeting had
   * claimed on the doc. On a recurring notes doc — the same doc week after
   * week — this meeting's own notes had landed under a previous meeting's
   * heading, and every edit came back refused: "2 proposed, 2 refused, 0
   * blocks touched", the exact shape this work exists to end. Narrowing a
   * rare cross-meeting case is not worth refusing the common one, so the
   * subtraction is gone; `ownership`'s header carries what that leaves open.
   */
  const RECURRING = [
    '# Riverbend ferry review',
    '',
    '## Week one minutes',
    '',
    `- ${OURS}`,
    `- ${THEIRS}`,
    '',
    '## Meeting notes',
  ].join('\n');

  it('reaches its own bullets under the older heading', async () => {
    const { store, markdownNow } = docStoreFrom(RECURRING, ['Week one minutes']);
    const dataDir = freshDir();
    writeTranscript(dataDir, [{ turn: 0, text: 'The harbour run and the winter crew.' }]);
    const result = await runNotesCleanupPass(
      depsFor(
        store,
        stubComposer([
          {
            op: 'nest_blocks',
            leadBlockId: idOf(store, 'harbour run'),
            blockIds: [idOf(store, 'Saltmarsh run')],
          },
        ]),
        dataDir,
        idOf(store, 'Meeting notes'),
      ),
      { docId: DOC, meetingId: MEETING },
    );
    expect(result.refused).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.applied).toBe(1);
    expect(markdownNow()).toContain(`- ${OURS}\n  - ${THEIRS}`);
  });
});
