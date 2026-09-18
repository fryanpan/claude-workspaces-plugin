/**
 * A HEADING THE NOTE-TAKER OPENED AND NEVER FILLED DOES NOT REACH THE READER,
 * on the shape the product actually writes since 2026-09-15.
 *
 * WHAT THIS REPRODUCES. Twenty-four of about forty-one headings in Bryan's
 * 16 September meeting carried no bullets. The repair for exactly that shape
 * already existed — `notes-section-tidy.ts` has removed an empty topic heading
 * of the note-taker's own since 2026-09-14 — and it had stopped reaching them
 * the day before that meeting. The reserved `## Meeting notes` container went
 * away (#1048, 2026-09-15) and a meeting's topics became SIBLINGS of the
 * heading the tidy is given as its section, so its walk broke at the second
 * topic and every heading after the first was never judged. Nothing emptied
 * those headings afterwards: each was written empty and stayed.
 *
 * So the cases below drive topics at the doc's OWN section level, which the
 * pre-existing cases in `notes-section-tidy.test.ts` do not — they write
 * `###` topics under a `##` section, the nested shape the product no longer
 * produces, which is why they stayed green through the regression.
 *
 * The grouping the headings exist for is asserted alongside: every topic that
 * has notes keeps its heading and its bullets, in order.
 *
 * All fixtures are synthetic. The repo is public.
 */

import { describe, expect, it } from 'bun:test';
import { prose } from '@claude-workspaces/core';
import * as Y from 'yjs';
import type { NotesComposeInput } from '../src/meeting-notes.ts';
import { notesTopicHashes } from '../src/notes-heading-level.ts';
import { tidyNotesSection } from '../src/notes-section-tidy.ts';
import { createNotesTickHarness } from './notes-tick-harness.ts';

const AUTHOR = 'notes-agent';
const WHO = {
  author: AUTHOR,
  suggestionAuthor: { id: AUTHOR, name: 'Note-taker', color: '#888888' },
};

/** Every top-level heading in a doc, in order. */
const headingsOf = (doc: Y.Doc): string[] =>
  prose
    .readOutline(doc)
    .filter((e) => e.kind === 'heading')
    .map((e) => e.text);

/** Every bullet in the doc, in order. */
const bullets = (ydoc: Y.Doc): string[] =>
  prose
    .readOutline(ydoc)
    .filter((e) => e.kind === 'listItem')
    .map((e) => e.text);

/** One tick's answer: a topic heading at the level this doc writes sections
 *  at, with the notes that go under it — or with none at all. */
function openTopic(input: NotesComposeInput, topic: string, notes = ''): prose.BlockEdit[] {
  const hashes = notesTopicHashes(input.outline);
  return [
    {
      op: 'insert_at_end',
      markdown: notes === '' ? `${hashes} ${topic}` : `${hashes} ${topic}\n\n${notes}`,
    },
  ];
}

/** A meeting that opens six topics and writes notes under three of them —
 *  the shape of the 16 September doc, at six headings instead of forty-one. */
const SCRIPT: Array<{ topic: string; notes: string }> = [
  { topic: 'Ferry timetable', notes: '- Harborlight wants the 07:10 sailing kept\n' },
  { topic: 'Slipway costs', notes: '' },
  { topic: 'Riverbend staffing', notes: '- Alice covers the weekend shift\n' },
  { topic: 'Saltmarsh signage', notes: '' },
  { topic: 'Budget review', notes: '- Bob redoes the Q3 sheet before Friday\n' },
  { topic: 'Winter timetable', notes: '' },
];

const scripted = (input: NotesComposeInput, tick: number): prose.BlockEdit[] => {
  const step = SCRIPT[tick - 1];
  return step === undefined ? [] : openTopic(input, step.topic, step.notes);
};

describe('topics a meeting opened and never filled', () => {
  it('are gone from a finished meeting, and the topics with notes are not', async () => {
    const harness = createNotesTickHarness({ compose: scripted });
    for (const step of SCRIPT) await harness.speak(`the room talks about ${step.topic}`);
    await harness.end();

    expect(harness.headings()).toEqual(['Ferry timetable', 'Riverbend staffing', 'Budget review']);
    expect(bullets(harness.ydoc)).toEqual([
      'Harborlight wants the 07:10 sailing kept',
      'Alice covers the weekend shift',
      'Bob redoes the Q3 sheet before Friday',
    ]);
  });

  it('go while the meeting is still running, once a later topic follows them', async () => {
    const harness = createNotesTickHarness({ compose: scripted });
    for (const step of SCRIPT.slice(0, 5))
      await harness.speak(`the room talks about ${step.topic}`);

    // Tick 5 opened `Budget review`, so the two empty topics before it are
    // both followed by a topic that will never be theirs.
    expect(harness.headings()).toEqual(['Ferry timetable', 'Riverbend staffing', 'Budget review']);
  });

  it('CONTROL: the topic a tick has just opened stays, so the next tick can fill it', async () => {
    const harness = createNotesTickHarness({ compose: scripted });
    for (const step of SCRIPT.slice(0, 2))
      await harness.speak(`the room talks about ${step.topic}`);
    expect(harness.headings()).toContain('Slipway costs');
  });

  it("CONTROL: a person's own empty heading is left exactly where it is", async () => {
    const harness = createNotesTickHarness({
      doc: '# Harbour review\n\n## Ferry timetable\n\n- the 07:10 is the one people use\n\n## Anything else\n',
      compose: (input, tick) =>
        tick === 1
          ? openTopic(input, 'Slipway costs', '- the haul-out quote is in\n')
          : openTopic(input, 'Crew rota', '- the rota changes every Monday\n'),
    });
    await harness.speak('the haul-out quote is in');
    await harness.speak('the rota changes every Monday');
    await harness.end();

    expect(harness.headings()).toEqual([
      'Harbour review',
      'Ferry timetable',
      'Anything else',
      'Slipway costs',
      'Crew rota',
    ]);
  });
});

describe('where the walk stops', () => {
  /** A meeting's three topics with a person's own section dropped in the
   *  middle of them — the one shape the walk cannot see past. */
  function docWithAPersonsSection(): { doc: Y.Doc; headingId: string } {
    const doc = new Y.Doc();
    // The page as the person wrote it: nothing here carries an author.
    prose.applyMarkdownToFragment(
      prose.getProseFragment(doc),
      '# Harbour review\n\n## Ferry timetable\n\n- the 07:10 sailing is kept\n\n## Anything else\n\n- I will chase the quote\n',
    );
    prose.ensureBlockIds(doc);
    // And the topic this meeting opened past it, still empty.
    prose.applyBlockEdits(doc, [{ op: 'insert_at_end', markdown: '## Slipway costs' }], WHO);
    const heading = prose.readOutline(doc).find((e) => e.text.trim() === 'Ferry timetable');
    if (!heading) throw new Error('fixture opened no section');
    return { doc, headingId: heading.id };
  }

  it("stops at a heading the document's own author wrote, and touches nothing past it", () => {
    // The conservative direction, and the same one `notes-regroup.ts` takes:
    // an empty topic beyond somebody else's section stays rather than risk a
    // pass reaching into a page it does not own. Pinned so that widening it
    // is a decision rather than a side effect.
    const { doc, headingId } = docWithAPersonsSection();
    const tidied = tidyNotesSection(doc, headingId, new Set(), {
      blanks: false,
      bulletsAuthoredBy: AUTHOR,
      lastTopic: true,
    });
    expect(tidied.emptied).toBe(0);
    expect(headingsOf(doc)).toContain('Anything else');
    expect(headingsOf(doc)).toContain('Slipway costs');
  });
});
