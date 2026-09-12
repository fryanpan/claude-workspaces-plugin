/**
 * A SECOND RECORDING ON A DOC WHOSE MEETING IS OVER, in the shape Bryan's own
 * doc ended up in on 2026-09-11.
 *
 * He recorded, the note-taker wrote its `## Meeting notes` section with a
 * topic under it, he stopped, a cleanup pass rewrote some of those blocks,
 * and minutes later he recorded again. The second recording opened a SECOND
 * `## Meeting notes` at the bottom of the page: one conversation under two
 * headings, with the reader's own section finder taking only the last of
 * them.
 *
 * What did it was the heading CLAIM — a section some meeting had recorded was
 * that meeting's forever — and not the cleanup pass, which this fixture runs
 * for real so that the claim is the only thing left to be the cause.
 *
 * The doc's own sections after the notes are here because his were: they are
 * what makes the notes section stop before the end of the document, so a
 * continued recording has to write INTO it rather than at the bottom.
 *
 * All speech, notes and names are invented. The repo is public.
 */

import { afterAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prose } from '@claude-workspaces/core';
import * as Y from 'yjs';
import { meetingDirPath, meetingIndexPath, meetingTranscriptPath } from '../src/meetings.ts';
import { runNotesCleanupPass } from '../src/notes-cleanup-pass.ts';
import { MEETING_NOTES_HEADING, readNotesOutline } from '../src/notes-doc-access.ts';
import { createNotesHeadingFileStore } from '../src/notes-heading-store.ts';
import { markdownOfDoc, oneDocStore } from './notes-doc-helpers.ts';
import { addNotes, createNotesTickHarness, notesItems } from './notes-tick-harness.ts';

const DOC = 'd-riverbend';
const FIRST = 'm-1760000000000';
const SECOND = 'm-1760000900000';
const TOPIC = 'Ferry timetable';

const dirs: string[] = [];
const freshDataDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'cw-notes-continued-'));
  dirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** The doc before the first recording. */
const DOC_BEFORE = '# Riverbend ferry review\n';

/** The heading of the section he typed himself, after the meeting, below the
 *  notes — what makes the notes section stop before the end of the document. */
const HIS_SECTION = 'Slipway costs';

/** The transcript the cleanup pass reads, written where the relay writes it. */
function writeTranscript(dataDir: string, meetingId: string, lines: readonly string[]): void {
  mkdirSync(meetingDirPath(dataDir, DOC), { recursive: true });
  writeFileSync(
    meetingTranscriptPath(dataDir, DOC, meetingId),
    `${lines.map((text, i) => JSON.stringify({ turn: i, text, ts: i + 1 })).join('\n')}\n`,
  );
  writeFileSync(
    meetingIndexPath(dataDir, DOC),
    `${JSON.stringify({ meetingId, docId: DOC, startedAt: 1, engine: 'mock', sampleRate: 16000 })}\n`,
  );
}

/** Every top-level `Meeting notes` heading in the doc, in order. */
const sections = (ydoc: Y.Doc): string[] =>
  prose
    .readOutline(ydoc)
    .filter((e) => e.kind === 'heading' && e.text === MEETING_NOTES_HEADING)
    .map((e) => e.id);

/**
 * The first recording, its stop, and a real cleanup pass over what it wrote.
 * Returns the doc, the data dir, and the heading it opened.
 */
async function meetingThenCleanup(): Promise<{ ydoc: Y.Doc; dataDir: string; opened: string }> {
  const dataDir = freshDataDir();
  const ydoc = new Y.Doc();
  const first = createNotesTickHarness({
    ydoc,
    dataDir,
    docId: DOC,
    meetingId: FIRST,
    doc: DOC_BEFORE,
    compose: (input) =>
      addNotes(input, `### ${TOPIC}\n\n- the harbour run moves to the half hour from April`),
  });
  await first.speak('the harbour run moves to the half hour from April');
  await first.end();
  const opened = sections(ydoc)[0] as string;
  expect(opened).toBeDefined();

  // THE CLEANUP PASS, for real: the same composer seam the live note-taker
  // uses, rewriting one of its own bullets the way a tidy-up does.
  writeTranscript(dataDir, FIRST, ['the harbour run moves to the half hour from April']);
  const store = oneDocStore(DOC, { ydoc, meta: { type: 'markdown' } });
  const bullet = readNotesOutline(store, DOC).find((e) => e.text.includes('harbour run'));
  expect(bullet).toBeDefined();
  const pass = await runNotesCleanupPass(
    {
      docStore: () => store,
      composer: {
        name: 'stub',
        compose: () =>
          Promise.resolve([
            {
              op: 'replace_block' as const,
              blockId: bullet?.id as string,
              markdown: '- the harbour run moves to the half hour from April, weekdays only',
            },
          ]),
      },
      dataDir,
      headingIdOf: () => opened,
    },
    { docId: DOC, meetingId: FIRST },
  );
  expect(pass.ok).toBe(true);
  expect(pass.touched).toBe(1);

  // And then he writes a section of his own below the notes, which is where
  // his doc had them: a continued recording must write INTO the notes rather
  // than onto the end of the page.
  store.applyBlockEdits(
    DOC,
    [{ op: 'insert_at_end', markdown: `## ${HIS_SECTION}\n\n- the winter haul-out quote` }],
    { author: 'person-editor' },
  );
  return { ydoc, dataDir, opened };
}

describe('a second recording on a doc whose meeting is over', () => {
  it('continues the notes under the section that is already there', async () => {
    const { ydoc, dataDir, opened } = await meetingThenCleanup();

    const second = createNotesTickHarness({
      ydoc,
      dataDir,
      docId: DOC,
      meetingId: SECOND,
      compose: (input) => addNotes(input, '- and the winter crew stays on Kestrel Lane'),
    });
    const tick = await second.speak('and the winter crew stays on Kestrel Lane');

    // ONE section, the one the first recording opened, and the second
    // recording was told to write under it.
    expect(sections(ydoc)).toEqual([opened]);
    expect(tick.input?.notesHeadingId).toBe(opened);
    // Both conversations' lines are in it, each exactly once.
    const lines = notesItems(ydoc);
    expect(lines.filter((l) => l.includes('harbour run'))).toHaveLength(1);
    expect(lines.filter((l) => l.includes('Kestrel Lane'))).toHaveLength(1);
    // And the new line went into the notes rather than onto the end of the
    // page, so his own section is still below them.
    const doc = markdownOfDoc(ydoc);
    expect(doc.indexOf('Kestrel Lane')).toBeLessThan(doc.indexOf(`## ${HIS_SECTION}`));
  });

  it('MUTATION CONTROL: while the first meeting is still recording, it opens its own', async () => {
    // The same doc and the same claim, one stop short: the first recording
    // never ends. Two live recordings on one doc keep their sections apart,
    // which is the case the claim was built for.
    const dataDir = freshDataDir();
    const ydoc = new Y.Doc();
    const first = createNotesTickHarness({
      ydoc,
      dataDir,
      docId: DOC,
      meetingId: FIRST,
      doc: DOC_BEFORE,
      compose: (input) => addNotes(input, '- the harbour run moves to the half hour'),
    });
    await first.speak('the harbour run moves to the half hour');

    const second = createNotesTickHarness({
      ydoc,
      dataDir,
      docId: DOC,
      meetingId: SECOND,
      compose: (input) => addNotes(input, '- a different room entirely'),
    });
    await second.speak('a different room entirely');

    expect(sections(ydoc)).toHaveLength(2);
  });

  it('a THIRD recording during the continuation opens its own section', async () => {
    // The trap in continuing somebody's section: the meeting that continued
    // it is now live under a heading whose other claimant has stopped. A
    // third recording that read only that stop would write into a section
    // two meetings are already sharing, one of them still running.
    const { ydoc, dataDir, opened } = await meetingThenCleanup();
    const second = createNotesTickHarness({
      ydoc,
      dataDir,
      docId: DOC,
      meetingId: SECOND,
      compose: (input) => addNotes(input, '- and the winter crew stays on Kestrel Lane'),
    });
    await second.speak('and the winter crew stays on Kestrel Lane');
    expect(sections(ydoc)).toEqual([opened]);

    // A third room, while the second is still recording.
    const third = createNotesTickHarness({
      ydoc,
      dataDir,
      docId: DOC,
      meetingId: 'm-1760001800000',
      compose: (input) => addNotes(input, '- a different conversation entirely'),
    });
    await third.speak('a different conversation entirely');
    expect(sections(ydoc)).toHaveLength(2);
  });

  it('records the stop where a restarted server reads it', async () => {
    // The continuation survives a deploy: the stop is beside the meeting's
    // own transcript, not in a map that dies with the process.
    const { dataDir, opened } = await meetingThenCleanup();
    const claims = createNotesHeadingFileStore(dataDir).claimsIn?.(DOC) ?? [];
    expect(claims).toHaveLength(1);
    expect(claims[0]?.headingId).toBe(opened);
    expect(claims[0]?.endedAt).toBeGreaterThan(0);
  });
});
