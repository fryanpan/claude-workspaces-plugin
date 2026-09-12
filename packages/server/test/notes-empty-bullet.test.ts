/**
 * The first thing said in a meeting reaches the notes, and a blank line never
 * stands there wearing the fresh-note tint.
 *
 * THE MEASURED FAILURE (production, 2026-09-11). A recording's section opened
 * with one empty bullet. The first turn never reached the notes at all, the
 * blank line stood for the rest of the meeting, and later turns arrived
 * normally — so the reader watched a blue bar on nothing for minutes while
 * the meeting's opening sentence was gone.
 *
 * Two things let that happen, and this file is a pair of tests for each:
 *
 *   - `applyBlockEdits` refuses markdown that parses to NO BLOCKS. Markdown
 *     reading `- ` parses to one real list item holding nothing, so it is
 *     applied — and a tick that "wrote" counts its turns composed and never
 *     offers them again. `notes-edit-guard.ts` RULE 3 is the answer.
 *   - `notes-section-tidy.ts` removes empty PARAGRAPHS, and an empty bullet is
 *     a list item, so nothing ever cleared one already in the doc.
 *
 * Every control here is the same code with the rule out of the way, so no
 * assertion passes without proof that the unguarded path really does lose the
 * words.
 *
 * All fixtures are invented place names. The repo is public.
 */
import { describe, expect, test } from 'bun:test';
import { prose, suggestOps } from '@claude-workspaces/core';
import * as Y from 'yjs';
import { MEETING_NOTES_HEADING } from '../src/notes-doc-access.ts';
import { guardNotesEdits } from '../src/notes-edit-guard.ts';
import { tidyNotesSection } from '../src/notes-section-tidy.ts';
import { addNotes, createNotesTickHarness } from './notes-tick-harness.ts';

const AUTHOR = 'notes-agent';
const WHO = {
  author: AUTHOR,
  suggestionAuthor: { id: AUTHOR, name: 'Note-taker', color: '#888888' },
};

/** The answer the model gave on the tick that opened the section: the heading,
 *  and a bullet with nothing in it. */
const OPENED_WITH_A_BLANK = `## ${MEETING_NOTES_HEADING}\n\n- `;

const FIRST_TURN = 'The Harborlight survey starts on the first Monday of March.';
const SECOND_TURN = 'Riverbend needs two more boats before the thaw.';

/** A doc the note-taker has just opened a section in. */
function sectionDoc(markdown: string): { doc: Y.Doc; headingId: string } {
  const doc = new Y.Doc();
  prose.applyMarkdownToFragment(prose.getProseFragment(doc), '# Survey planning\n');
  prose.applyBlockEdits(doc, [{ op: 'insert_at_end', markdown }], WHO);
  const heading = prose.readOutline(doc).find((e) => e.text.trim() === MEETING_NOTES_HEADING);
  if (!heading) throw new Error('fixture opened no section');
  return { doc, headingId: heading.id };
}

/** The bullets of the doc, as a reader sees them — words and all. */
function bullets(doc: Y.Doc): string[] {
  return prose
    .readOutline(doc)
    .filter((e) => e.kind === 'listItem')
    .map((e) => e.text);
}

describe('a bullet with no words in it is not a note', () => {
  test('CONTROL: unguarded, the blank bullet lands in the section and stays there', () => {
    const { doc } = sectionDoc(OPENED_WITH_A_BLANK);
    // One list item, holding nothing. This is the blue bar on nothing.
    expect(bullets(doc)).toEqual(['']);
  });

  test('the guard refuses a batch whose only note was that bullet', () => {
    const guarded = guardNotesEdits([{ op: 'insert_at_end', markdown: OPENED_WITH_A_BLANK }], {});
    expect(guarded.edits).toHaveLength(0);
    expect(guarded.refused.length).toBeGreaterThan(0);
    // Refused rather than trimmed to the heading alone: applying the heading
    // would mark this tick's speech composed, and the words would be gone.
    const doc = new Y.Doc();
    prose.applyMarkdownToFragment(prose.getProseFragment(doc), '# Survey planning\n');
    prose.applyBlockEdits(doc, [...guarded.edits], WHO);
    expect(prose.readOutline(doc).some((e) => e.text === MEETING_NOTES_HEADING)).toBe(false);
  });

  test('a blank bullet beside a real note is dropped and the real note lands', () => {
    const guarded = guardNotesEdits(
      [
        {
          op: 'insert_at_end',
          markdown: `## ${MEETING_NOTES_HEADING}\n\n- \n- ${FIRST_TURN}`,
        },
      ],
      {},
    );
    expect(guarded.edits).toHaveLength(1);
    const doc = new Y.Doc();
    prose.applyMarkdownToFragment(prose.getProseFragment(doc), '# Survey planning\n');
    prose.applyBlockEdits(doc, [...guarded.edits], WHO);
    expect(bullets(doc)).toEqual([FIRST_TURN]);
  });

  test('a marker whose words are indented under it is a wrapped bullet, and survives', () => {
    // Dropping this marker would orphan the nested list hanging off it, which
    // is how a regroup writes a group's lead line.
    const regroup = '- \n  - the ferry timetable slips a week';
    const guarded = guardNotesEdits([{ op: 'insert_at_end', markdown: regroup }], {});
    expect(guarded.edits).toHaveLength(1);
    expect((guarded.edits[0] as { markdown: string }).markdown).toBe(regroup);
  });

  test('an ordinary batch of real notes is untouched', () => {
    // The mutation control for the rule itself: a guard that refused every
    // insert would pass every test above and fail this one.
    const edits = [{ op: 'insert_at_end' as const, markdown: `- ${FIRST_TURN}` }];
    const guarded = guardNotesEdits(edits, {});
    expect(guarded.refused).toHaveLength(0);
    expect(guarded.edits).toEqual(edits);
  });
});

describe('the first thing said reaches the notes by the next tick', () => {
  /**
   * The meeting from the report, scripted: the tick that opens the section
   * answers with a blank bullet, and every tick after it writes what it heard.
   * What must be true is that the first turn is still owed after tick one and
   * is written on tick two — the pipeline's own answer, not the composer's
   * goodwill, because the composer here never looks at `missed`.
   */
  function meeting() {
    return createNotesTickHarness({
      doc: '# Survey planning\n\nWhat we agreed before the recording started.\n',
      compose: (input, tick) =>
        tick === 1
          ? [{ op: 'insert_at_end', markdown: OPENED_WITH_A_BLANK }]
          : addNotes(input, input.tick.turns.map((t) => `- ${t.text}`).join('\n')),
    });
  }

  test('the first turn is in the notes after the second tick', async () => {
    const h = meeting();
    await h.speak(FIRST_TURN);
    await h.speak(SECOND_TURN);
    expect(h.notes()).toContain('Harborlight survey');
    expect(h.notes()).toContain('Riverbend');
  });

  test('and no bullet in the section is blank', async () => {
    const h = meeting();
    await h.speak(FIRST_TURN);
    await h.speak(SECOND_TURN);
    expect(bullets(h.ydoc).filter((b) => b.trim().length === 0)).toEqual([]);
  });

  test('the section is opened once, by the tick that finally writes a note', async () => {
    const h = meeting();
    await h.speak(FIRST_TURN);
    await h.speak(SECOND_TURN);
    expect(h.countHeadings(MEETING_NOTES_HEADING)).toBe(1);
  });
});

describe('an empty bullet already in the section does not stand', () => {
  /** A section holding one blank bullet of the note-taker's own and one real
   *  note, which is what a doc carries when a tick wrote the blank before this
   *  rule existed. */
  function sectionWithABlank(): { doc: Y.Doc; headingId: string } {
    const made = sectionDoc(`## ${MEETING_NOTES_HEADING}\n\n- \n- ${SECOND_TURN}`);
    expect(bullets(made.doc)).toEqual(['', SECOND_TURN]);
    return made;
  }

  test('CONTROL: a tidy not told whose bullets to judge leaves it exactly where it is', () => {
    // The empty-paragraph repair is the whole of what this used to do, and it
    // does not see a list item. Nothing here changes with the rule, which is
    // what makes the next test a difference rather than a coincidence.
    const { doc, headingId } = sectionWithABlank();
    tidyNotesSection(doc, headingId);
    expect(bullets(doc)).toEqual(['', SECOND_TURN]);
  });

  test('told whose bullets to judge, it removes the blank and keeps the note', () => {
    const { doc, headingId } = sectionWithABlank();
    const tidied = tidyNotesSection(doc, headingId, new Set(), { bulletsAuthoredBy: AUTHOR });
    expect(tidied.bullets).toBe(1);
    expect(bullets(doc)).toEqual([SECOND_TURN]);
  });

  test('the list goes with it when every bullet in it was blank', () => {
    const { doc, headingId } = sectionDoc(OPENED_WITH_A_BLANK);
    tidyNotesSection(doc, headingId, new Set(), { bulletsAuthoredBy: AUTHOR });
    expect(bullets(doc)).toEqual([]);
    expect(prose.readOutline(doc).some((e) => e.text === MEETING_NOTES_HEADING)).toBe(true);
  });

  test('a person’s own blank bullet is left alone', () => {
    // Somebody who has pressed Enter in the notes has an empty bullet under
    // the cursor until they type, and a live meeting is when that is most
    // likely. A block a person has touched carries no author, which is the
    // whole safety of the rule — so here nothing is claimed at all.
    const doc = new Y.Doc();
    prose.applyMarkdownToFragment(
      prose.getProseFragment(doc),
      `# Survey planning\n\n## ${MEETING_NOTES_HEADING}\n\n- ${SECOND_TURN}\n- \n`,
    );
    prose.ensureBlockIds(doc);
    const outline = prose.readOutline(doc);
    const headingId = outline.find((e) => e.text.trim() === MEETING_NOTES_HEADING)?.id;
    if (headingId === undefined) throw new Error('fixture opened no section');
    expect(outline.find((e) => e.kind === 'listItem' && e.text === '')?.author).toBeUndefined();
    tidyNotesSection(doc, headingId, new Set(), { bulletsAuthoredBy: AUTHOR });
    expect(bullets(doc).filter((b) => b.length === 0)).toHaveLength(1);
  });

  test('a blank lead bullet with points nested under it survives', () => {
    const { doc, headingId } = sectionDoc(
      `## ${MEETING_NOTES_HEADING}\n\n- \n  - the ferry timetable slips a week`,
    );
    tidyNotesSection(doc, headingId, new Set(), { bulletsAuthoredBy: AUTHOR });
    expect(prose.readOutline(doc).some((e) => e.text.includes('ferry timetable'))).toBe(true);
  });

  test('the offered words of an unanswered suggestion survive', () => {
    // MEASURED WHILE BUILDING THIS. A proposal on a person's own line keeps
    // its offered words in a NEW bullet of the note-taker's, and a suggested
    // insertion is left out of the serialization — so that bullet reads as an
    // authored blank one. Removing it threw the offer away and left the
    // strike-through standing on the line it was made about.
    const doc = new Y.Doc();
    prose.applyMarkdownToFragment(
      prose.getProseFragment(doc),
      `# Survey planning\n\n## ${MEETING_NOTES_HEADING}\n\n- ${SECOND_TURN}\n`,
    );
    prose.ensureBlockIds(doc);
    const outline = prose.readOutline(doc);
    const headingId = outline.find((e) => e.text.trim() === MEETING_NOTES_HEADING)?.id;
    const theirs = outline.find((e) => e.kind === 'listItem')?.id;
    if (headingId === undefined || theirs === undefined) throw new Error('fixture built nothing');
    // No flag asks for a proposal: a replace of a block the note-taker does
    // not own becomes one, which is exactly the shape a cleanup pass makes.
    prose.applyBlockEdits(
      doc,
      [{ op: 'replace_block', blockId: theirs, markdown: `- ${FIRST_TURN}` }],
      WHO,
    );
    expect(suggestOps.listSuggestions(doc)).toHaveLength(1);

    const tidied = tidyNotesSection(doc, headingId, new Set(), { bulletsAuthoredBy: AUTHOR });
    expect(tidied.bullets).toBe(0);
    expect(suggestOps.listSuggestions(doc)[0]?.insertedText).toBe(FIRST_TURN);
  });

  test('a blank bullet somebody has commented on survives', () => {
    const { doc, headingId } = sectionDoc(OPENED_WITH_A_BLANK);
    const blank = prose.readOutline(doc).find((e) => e.kind === 'listItem');
    if (!blank) throw new Error('fixture wrote no bullet');
    tidyNotesSection(doc, headingId, new Set([blank.id]), { bulletsAuthoredBy: AUTHOR });
    expect(bullets(doc)).toEqual(['']);
  });
});
