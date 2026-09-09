/**
 * A SERVER RESTART IN THE MIDDLE OF A MEETING, and the section the meeting is
 * already writing under.
 *
 * The heading a meeting opened used to be remembered in a `Map` and nowhere
 * else, so the note-taker's memory of it died with the process. This repo
 * deploys mid-day: a meeting that had already written half its notes came back
 * to a note-taker that knew of no section, opened a SECOND `Meeting notes`
 * below the first, and left the reader two sections for one conversation.
 *
 * The fix is that the id is written beside the meeting's own transcript, so a
 * meeting id that ticks again finds the section it opened. What models the
 * restart here is a second harness over the SAME data dir and the same
 * `Y.Doc`: the doc and the data dir survive a restart, and every process-local
 * map does not.
 *
 * All fixtures are synthetic. The repo is public.
 */

import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prose } from '@claude-workspaces/core';
import * as Y from 'yjs';
import {
  MEETING_NOTES_HEADING,
  NOTES_AUTHOR_ID,
  NOTES_SUGGESTION_AUTHOR,
} from '../src/notes-doc-access.ts';
import { addNotes, createNotesTickHarness, notesItems } from './notes-tick-harness.ts';

const dirs: string[] = [];
const freshDataDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'cw-notes-restart-'));
  dirs.push(dir);
  return dir;
};

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** The ids of every top-level `Meeting notes` heading, in document order. */
const sectionIds = (ydoc: Y.Doc): string[] =>
  prose
    .readOutline(ydoc)
    .filter((e) => e.kind === 'heading' && e.text === MEETING_NOTES_HEADING)
    .map((e) => e.id);

describe('a meeting whose server restarted mid-recording', () => {
  it('keeps writing under the section it had already opened', async () => {
    const dataDir = freshDataDir();
    const ydoc = new Y.Doc();
    const ids = { docId: 'd-plan', meetingId: 'm-1750000000000' };

    const before = createNotesTickHarness({
      ydoc,
      dataDir,
      ...ids,
      compose: (input) => addNotes(input, '- the export dialog forgets the range'),
    });
    await before.speak('the export dialog forgets the range');
    expect(before.countHeadings(MEETING_NOTES_HEADING)).toBe(1);
    const opened = sectionIds(ydoc);
    expect(opened).toHaveLength(1);

    // THE RESTART. Same doc, same data dir, same meeting — a note-taker that
    // remembers nothing in memory.
    const after = createNotesTickHarness({
      ydoc,
      dataDir,
      ...ids,
      compose: (input) => addNotes(input, '- and the retry ticket is next'),
    });
    const tick = await after.speak('and the retry ticket is next');

    // The tick was told to write under the section that was already there.
    expect(tick.input?.notesHeadingId).toBe(opened[0] as string);
    expect(sectionIds(ydoc)).toEqual(opened);
    expect(after.countHeadings(MEETING_NOTES_HEADING)).toBe(1);

    // One section, and both meetings' words in it exactly once.
    const lines = notesItems(ydoc);
    expect(lines.filter((l) => l.includes('export dialog forgets the range'))).toHaveLength(1);
    expect(lines.filter((l) => l.includes('the retry ticket is next'))).toHaveLength(1);
  });

  it('opens its own section for a meeting id the restart never saw', async () => {
    // The control on the assertion above: the durable id is keyed by MEETING,
    // so a recording started after the restart still gets a section of its
    // own — the owner's rule that a stop-and-restart never replaces what is
    // already written.
    const dataDir = freshDataDir();
    const ydoc = new Y.Doc();
    const first = createNotesTickHarness({
      ydoc,
      dataDir,
      docId: 'd-plan',
      meetingId: 'm-1750000000000',
      compose: (input) => addNotes(input, '- the export dialog forgets the range'),
    });
    await first.speak('the export dialog forgets the range');

    const second = createNotesTickHarness({
      ydoc,
      dataDir,
      docId: 'd-plan',
      meetingId: 'm-1750000900000',
      compose: (input) => addNotes(input, '- a different conversation'),
    });
    await second.speak('a different conversation');

    expect(sectionIds(ydoc)).toHaveLength(2);
  });

  it('opens a new section when the heading it remembered has been deleted', async () => {
    // A remembered id whose block is gone must not survive the restart
    // either: every edit addressed to it would fail with `unknown-block` for
    // the rest of the meeting.
    const dataDir = freshDataDir();
    const ydoc = new Y.Doc();
    const ids = { docId: 'd-plan', meetingId: 'm-1750000000000' };

    const before = createNotesTickHarness({
      ydoc,
      dataDir,
      ...ids,
      compose: (input) => addNotes(input, '- the export dialog forgets the range'),
    });
    await before.speak('the export dialog forgets the range');
    const opened = sectionIds(ydoc)[0] as string;

    // The section is deleted between the two ticks. Addressed as the
    // note-taker so the delete APPLIES rather than arriving as a proposal —
    // what the case needs is a doc the remembered id is no longer in.
    prose.applyBlockEdits(ydoc, [{ op: 'delete_block', blockId: opened }], {
      author: NOTES_AUTHOR_ID,
      suggestionAuthor: NOTES_SUGGESTION_AUTHOR,
    });

    const after = createNotesTickHarness({
      ydoc,
      dataDir,
      ...ids,
      compose: (input) => addNotes(input, '- and the retry ticket is next'),
    });
    const tick = await after.speak('and the retry ticket is next');

    expect(tick.input?.notesHeadingId).toBeUndefined();
    expect(sectionIds(ydoc)).toHaveLength(1);
    expect(sectionIds(ydoc)[0]).not.toBe(opened);
  });
});
