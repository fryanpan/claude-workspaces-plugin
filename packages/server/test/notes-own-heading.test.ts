/**
 * A MEETING'S NOTES GO UNDER THE MEETING'S OWN HEADING.
 *
 * The doc every test here starts from is the one a person prepares before a
 * meeting: a `## Meeting notes` heading near the top and an agenda BELOW it.
 * That shape is what turned a real 41-minute meeting into 192 bullets under
 * somebody's agenda with the meeting's own section empty, and it breaks the
 * live write path in two independent ways — the op the prompt names for a
 * first note writes at the end of the DOCUMENT, and the agenda's headings
 * read as the topics of the speech.
 *
 * Both are driven through `createNotesTickHarness`, which is the real
 * `applyNotesUpdate` write path with the model stubbed, because a fixture
 * eval never exercises the path that broke.
 *
 * All content is fictional.
 */

import { describe, expect, test } from 'bun:test';
import type { prose } from '@claude-workspaces/core';
import { MEETING_NOTES_HEADING } from '../src/notes-doc-access.ts';
import { homeNotesEdits } from '../src/notes-section-home.ts';
import { createNotesTickHarness } from './notes-tick-harness.ts';

/** The doc as a meeting finds it: an empty notes heading, an agenda under it. */
const PREPARED_DOC = [
  `## ${MEETING_NOTES_HEADING}`,
  '',
  '## Agenda',
  '',
  '- ship the ferry timetable',
  '- the slipway queue',
  '',
].join('\n');

/** Every bullet under the doc's `## Agenda`, as a reader would see them. */
function agendaBullets(markdown: string): string[] {
  const lines = markdown.split('\n');
  const at = lines.findIndex((l) => l.trim() === '## Agenda');
  if (at < 0) return [];
  const out: string[] = [];
  for (const line of lines.slice(at + 1)) {
    if (line.startsWith('#')) break;
    if (line.trim().startsWith('-')) out.push(line.trim());
  }
  return out;
}

function bulletsIn(section: string): string[] {
  return section
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('-'));
}

describe('a meeting writes under its own heading, not at the end of the doc', () => {
  test('an insert at the end of the doc lands in the meeting section', async () => {
    const harness = createNotesTickHarness({
      doc: PREPARED_DOC,
      compose: (_input, tick): prose.BlockEdit[] => [
        { op: 'insert_at_end', markdown: `- point ${tick} about the slipway queue` },
      ],
    });
    await harness.speak('the slipway queue is what holds the timetable up');
    await harness.speak('and the crane booking has to move with it');
    await harness.end();

    expect(bulletsIn(harness.notes())).toEqual([
      '- point 1 about the slipway queue',
      '- point 2 about the slipway queue',
    ]);
    // The person's own agenda is exactly as they left it.
    expect(agendaBullets(harness.markdown())).toEqual([
      '- ship the ferry timetable',
      '- the slipway queue',
    ]);
    expect(harness.countHeadings(MEETING_NOTES_HEADING)).toBe(1);
  });

  test('a note addressed to the agenda lands in the meeting section', async () => {
    const harness = createNotesTickHarness({
      doc: PREPARED_DOC,
      compose: (input, tick): prose.BlockEdit[] => {
        const agenda = input.outline.find(
          (e) => e.kind === 'heading' && e.text.trim() === 'Agenda',
        );
        return agenda === undefined
          ? []
          : [
              {
                op: 'insert_under_heading',
                headingId: agenda.id,
                markdown: `- point ${tick} about the ferry timetable`,
              },
            ];
      },
    });
    await harness.speak('the timetable needs two sailings a day, not three');
    await harness.speak('and the harbour lights are on the same budget line');
    await harness.end();

    expect(bulletsIn(harness.notes())).toEqual([
      '- point 1 about the ferry timetable',
      '- point 2 about the ferry timetable',
    ]);
    expect(agendaBullets(harness.markdown())).toEqual([
      '- ship the ferry timetable',
      '- the slipway queue',
    ]);
  });

  test('a topic heading the meeting opened still takes its own bullets', async () => {
    const harness = createNotesTickHarness({
      doc: PREPARED_DOC,
      compose: (input, tick): prose.BlockEdit[] => {
        const section = input.notesHeadingId;
        if (section === undefined) return [];
        if (tick === 1) {
          return [
            {
              op: 'insert_under_heading',
              headingId: section,
              markdown: '### Ferry timetable\n\n- two sailings a day, not three',
            },
          ];
        }
        const topic = input.outline.find(
          (e) => e.kind === 'heading' && e.text.trim() === 'Ferry timetable',
        );
        return topic === undefined
          ? []
          : [
              {
                op: 'insert_under_heading',
                headingId: topic.id,
                markdown: '- the tide tables decide which two',
              },
            ];
      },
    });
    await harness.speak('two sailings a day, not three, is what the timetable needs');
    await harness.speak('the tide tables decide which two of them it can be');
    await harness.end();

    const notes = harness.notes();
    expect(notes).toContain('### Ferry timetable');
    expect(bulletsIn(notes)).toEqual([
      '- two sailings a day, not three',
      '- the tide tables decide which two',
    ]);
    expect(agendaBullets(harness.markdown())).toEqual([
      '- ship the ferry timetable',
      '- the slipway queue',
    ]);
  });
});

describe('homeNotesEdits leaves alone what it must', () => {
  const outline = [
    { id: 'h-notes', kind: 'heading', level: 2, text: MEETING_NOTES_HEADING },
    { id: 'h-topic', kind: 'heading', level: 3, text: 'Ferry timetable' },
    { id: 'b-ours', kind: 'listItem', text: 'two sailings a day' },
    { id: 'h-agenda', kind: 'heading', level: 2, text: 'Agenda' },
    { id: 'b-theirs', kind: 'listItem', text: 'ship the ferry timetable' },
  ] as unknown as readonly prose.OutlineEntry[];

  test('a meeting with no section of its own is untouched', () => {
    const edits: prose.BlockEdit[] = [{ op: 'insert_at_end', markdown: '- a first note' }];
    const out = homeNotesEdits(edits, { notesHeadingId: undefined, outline });
    expect(out.edits).toEqual(edits);
    expect(out.rehomed).toEqual([]);
  });

  test('a topic heading inside the section is a legal address', () => {
    const edits: prose.BlockEdit[] = [
      { op: 'insert_under_heading', headingId: 'h-topic', markdown: '- a note' },
    ];
    const out = homeNotesEdits(edits, { notesHeadingId: 'h-notes', outline });
    expect(out.edits).toEqual(edits);
    expect(out.rehomed).toEqual([]);
  });

  test('an address no block answers to is left for the applier', () => {
    const edits: prose.BlockEdit[] = [
      { op: 'insert_under_heading', headingId: 'h-gone', markdown: '- a note' },
    ];
    const out = homeNotesEdits(edits, { notesHeadingId: 'h-notes', outline });
    expect(out.edits).toEqual(edits);
    expect(out.rehomed).toEqual([]);
  });

  test('a replace and a nest keep their targets', () => {
    const edits: prose.BlockEdit[] = [
      { op: 'replace_block', blockId: 'b-theirs', markdown: '- ship it in March' },
      { op: 'delete_block', blockId: 'b-ours' },
      { op: 'nest_blocks', leadBlockId: 'b-ours', blockIds: ['b-theirs'] },
    ];
    const out = homeNotesEdits(edits, { notesHeadingId: 'h-notes', outline });
    expect(out.edits).toEqual(edits);
    expect(out.rehomed).toEqual([]);
  });

  test('a section heading the outline no longer carries re-homes nothing', () => {
    const edits: prose.BlockEdit[] = [{ op: 'insert_at_end', markdown: '- a note' }];
    const out = homeNotesEdits(edits, { notesHeadingId: 'h-vanished', outline });
    expect(out.edits).toEqual(edits);
    expect(out.rehomed).toEqual([]);
  });

  test('an out-of-section address is re-homed, and says so', () => {
    const edits: prose.BlockEdit[] = [
      { op: 'insert_under_heading', headingId: 'h-agenda', markdown: '- a note' },
    ];
    const out = homeNotesEdits(edits, { notesHeadingId: 'h-notes', outline });
    expect(out.edits).toEqual([
      { op: 'insert_under_heading', headingId: 'h-notes', markdown: '- a note' },
    ]);
    expect(out.rehomed).toHaveLength(1);
    expect(out.rehomed[0]).toContain('h-agenda');
  });
});
