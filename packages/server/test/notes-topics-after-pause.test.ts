/**
 * A MEETING PAUSED AND STARTED AGAIN WRITES EACH TOPIC ONCE.
 *
 * On 2026-09-16 a sixteen-second pause — stop, then Record again — made the
 * second recording re-open eight topics the doc already had. The words were
 * all there to see: the whole-doc change was live, and the second run's first
 * prompt carried everything the first run had written.
 *
 * What could not see them was the deterministic half. Since PR 1048 removed
 * the `## Meeting notes` container, a meeting's topics are SIBLINGS at the
 * section's own level, and every scope built by "the claimed heading, then
 * everything until the next heading of its level" stops at the SECOND topic.
 * The dedupe's repeat check is one of those scopes, so it held one topic out
 * of eight and reused nothing.
 *
 * All fixtures are synthetic. The repo is public.
 */

import { describe, expect, it } from 'bun:test';
import { prose } from '@claude-workspaces/core';
import * as Y from 'yjs';
import { createNotesHeadingMemory } from '../src/meeting-notes-doc.ts';
import { NOTES_AUTHOR_ID } from '../src/notes-doc-access.ts';
import { dedupeNotesEdits } from '../src/notes-edit-dedupe.ts';
import { notesTopicHashes } from '../src/notes-heading-level.ts';
import { createNotesTickHarness } from './notes-tick-harness.ts';

/** The topics of one scripted meeting, each with one note under it. */
const TOPICS: ReadonlyArray<{ topic: string; said: string; note: string }> = [
  {
    topic: 'Ferry timetable',
    said: 'the ferry leaves Harborlight at six',
    note: 'the ferry leaves Harborlight at six',
  },
  {
    topic: 'Slipway repairs',
    said: 'the slipway needs new planks',
    note: 'the slipway needs new planks',
  },
  {
    topic: 'Riverbend signage',
    said: 'Riverbend signage is unreadable at dusk',
    note: 'Riverbend signage is unreadable at dusk',
  },
  {
    topic: 'Saltmarsh path',
    said: 'the Saltmarsh path floods in spring',
    note: 'the Saltmarsh path floods in spring',
  },
  {
    topic: 'Winter opening hours',
    said: 'winter opening hours drop to four',
    note: 'winter opening hours drop to four',
  },
  {
    topic: 'Ticket pricing',
    said: 'ticket pricing rises in April',
    note: 'ticket pricing rises in April',
  },
  {
    topic: 'Volunteer rota',
    said: 'the volunteer rota has two gaps',
    note: 'the volunteer rota has two gaps',
  },
  {
    topic: 'Cafe supplier',
    said: 'the cafe supplier changed again',
    note: 'the cafe supplier changed again',
  },
];

/**
 * The scripted model: one insert per tick, opening the tick's topic at the
 * level this doc writes its sections at.
 *
 * This is what a real run does after the container went away — every topic is
 * a sibling of the one before it, not a child of a reserved section.
 */
function openTopic(
  input: { outline: readonly prose.OutlineEntry[] },
  n: number,
): prose.BlockEdit[] {
  const t = TOPICS[n - 1];
  if (t === undefined) return [];
  return [
    {
      op: 'insert_at_end',
      markdown: `${notesTopicHashes(input.outline)} ${t.topic}\n\n- ${t.note}`,
    },
  ];
}

/** How many headings of the doc read exactly `text`. */
function countHeading(headings: readonly string[], text: string): number {
  return headings.filter((h) => h === text).length;
}

describe('a recording started again after a pause', () => {
  it('writes each topic once, not a second copy of every one', async () => {
    const heading = createNotesHeadingMemory();
    const ydoc = new Y.Doc();

    const first = createNotesTickHarness({
      ydoc,
      heading,
      meetingId: 'm-before-pause',
      compose: (input, tick) => openTopic(input, tick),
    });
    for (const t of TOPICS) await first.speak(t.said);
    await first.end();
    for (const t of TOPICS) {
      expect(countHeading(first.headings(), t.topic)).toBe(1);
    }

    // The pause. The record says the meeting stopped; the next recording is
    // a new meeting id, and `releaseNotesAuthorship` has dropped every mark
    // the first leg left, so nothing in the doc is attributed any more.
    const second = createNotesTickHarness({
      ydoc,
      heading,
      meetingId: 'm-after-pause',
      compose: (input, tick) => openTopic(input, tick),
    });
    for (const t of TOPICS) await second.speak(t.said);
    await second.end();

    const headings = second.headings();
    const repeated = TOPICS.filter((t) => countHeading(headings, t.topic) > 1).map((t) => t.topic);
    expect(repeated).toEqual([]);
  }, 20_000);

  it('files what was said after the pause under the topic it is about', async () => {
    // The half the count above cannot show: a topic written once is only the
    // right answer if the SECOND leg's notes reached it. A reuse that dropped
    // the words instead would pass the assertion above and lose the meeting.
    const heading = createNotesHeadingMemory();
    const ydoc = new Y.Doc();

    const first = createNotesTickHarness({
      ydoc,
      heading,
      meetingId: 'm-before-pause',
      compose: (input, tick) => openTopic(input, tick),
    });
    await first.speak(TOPICS[0]?.said ?? '');
    await first.speak(TOPICS[1]?.said ?? '');
    await first.end();

    const second = createNotesTickHarness({
      ydoc,
      heading,
      meetingId: 'm-after-pause',
      compose: (input) => [
        {
          op: 'insert_at_end',
          markdown: `${notesTopicHashes(input.outline)} Ferry timetable\n\n- the last sailing moved to seven`,
        },
      ],
    });
    await second.speak('the last sailing moved to seven');
    await second.end();

    const markdown = second.markdown();
    expect(countHeading(second.headings(), 'Ferry timetable')).toBe(1);
    expect(markdown).toContain('the last sailing moved to seven');
    // Under the ferry topic, which is what "one document" means to a reader:
    // before the next topic's heading rather than appended past it.
    expect(markdown.indexOf('the last sailing moved to seven')).toBeLessThan(
      markdown.indexOf('Slipway repairs'),
    );
  }, 20_000);

  it('carries the repeat check over the minutes’ own topics and no further', () => {
    // THE CONTROL, and the arm that says the widening is bounded. `Slipway
    // repairs` is a sibling the meeting wrote; `Grant paperwork` is one
    // nobody recorded — the reader's own section. A pass that ran to the end
    // of the doc would fold a note into the second as readily as the first.
    const doc = new Y.Doc();
    prose.applyMarkdownToFragment(
      prose.getProseFragment(doc),
      [
        '## Ferry timetable',
        '',
        '- the ferry leaves Harborlight at six',
        '',
        '## Slipway repairs',
        '',
        '- the slipway needs new planks',
        '',
        '## Grant paperwork',
        '',
        '- the grant form is due in March',
        '',
      ].join('\n'),
    );
    prose.ensureBlockIds(doc);
    const outline = prose.readOutline(doc);
    const idOf = (text: string): string => {
      const found = outline.find((e) => e.text === text);
      if (!found) throw new Error(`no block reading ${text}`);
      return found.id;
    };
    const notesHeadingId = idOf('Ferry timetable');
    const meetingTopics = new Set([notesHeadingId, idOf('Slipway repairs')]);
    const speech = ['the slipway needs new planks and the grant form is due in March'];

    const reused = dedupeNotesEdits(
      [{ op: 'insert_at_end', markdown: '## Slipway repairs\n\n- the tide table is on the wall' }],
      { notesHeadingId, outline, speech, authorId: NOTES_AUTHOR_ID, meetingTopics },
    );
    expect(reused.edits).toEqual([
      {
        op: 'insert_under_heading',
        headingId: idOf('Slipway repairs'),
        markdown: '- the tide table is on the wall',
      },
    ]);

    const untouched = dedupeNotesEdits(
      [{ op: 'insert_at_end', markdown: '## Grant paperwork\n\n- the tide table is on the wall' }],
      { notesHeadingId, outline, speech, authorId: NOTES_AUTHOR_ID, meetingTopics },
    );
    expect(untouched.edits).toEqual([
      { op: 'insert_at_end', markdown: '## Grant paperwork\n\n- the tide table is on the wall' },
    ]);

    // AND THE BASE: with nothing recorded, even the sibling the meeting wrote
    // is out of reach — which is the behaviour that re-opened eight topics.
    const base = dedupeNotesEdits(
      [{ op: 'insert_at_end', markdown: '## Slipway repairs\n\n- the tide table is on the wall' }],
      { notesHeadingId, outline, speech, authorId: NOTES_AUTHOR_ID },
    );
    expect(base.edits).toEqual([
      { op: 'insert_at_end', markdown: '## Slipway repairs\n\n- the tide table is on the wall' },
    ]);
  });
});
