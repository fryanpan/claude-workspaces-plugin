import { describe, expect, test } from 'bun:test';
import { type DocType, prose } from '@claude-workspaces/core';
import * as Y from 'yjs';
import { createNotesHeadingMemory, notesSectionForMeeting } from '../src/meeting-notes-doc.ts';
import { NOTES_AUTHOR_ID, type NotesDocStore, readNotesOutline } from '../src/notes-doc-access.ts';
import { lastNotesHeadingIndex, notesSectionFits } from '../src/notes-section-fit.ts';
import { oneDocStore } from './notes-doc-helpers.ts';

const AGENT = 'agent:notes';

function outline(
  rows: Array<[kind: 'heading' | 'bullet', text: string, author?: string]>,
): readonly prose.OutlineEntry[] {
  return rows.map(([kind, text, author], i) => ({
    id: `b${i}`,
    kind,
    level: kind === 'heading' ? 2 : 0,
    text,
    author,
  })) as unknown as readonly prose.OutlineEntry[];
}

describe('which heading the answer is about', () => {
  test('a doc with no notes heading has none', () => {
    expect(lastNotesHeadingIndex(outline([['heading', 'Agenda']]))).toBe(-1);
  });

  test('the LAST one, because that is the one both readers take', () => {
    const o = outline([
      ['heading', 'Meeting notes'],
      ['bullet', 'a person’s line'],
      ['heading', 'Meeting notes'],
    ]);
    expect(lastNotesHeadingIndex(o)).toBe(2);
  });
});

describe('a section new minutes may reuse', () => {
  test('a doc with no notes heading at all: nothing to be stranded by', () => {
    expect(
      notesSectionFits(
        outline([
          ['heading', 'Agenda'],
          ['bullet', 'ship the trail map'],
        ]),
      ),
    ).toBe(true);
  });

  test('an empty notes section somebody typed', () => {
    expect(notesSectionFits(outline([['heading', 'Meeting notes']]))).toBe(true);
  });

  test('a notes section holding only the person’s own lines', () => {
    // THE SHAPE THE EVAL SEEDS, and the one that scored 0% on "a person's
    // bullet is never edited" while nothing had edited it.
    const o = outline([
      ['heading', 'Meeting notes'],
      ['bullet', 'my own note: check this against the brief before we commit'],
    ]);
    expect(notesSectionFits(o)).toBe(true);
  });

  test('a section whose lines a person has since taken over', () => {
    // `clearAuthorshipOnPersonEdit` drops the author when a person edits a
    // line, which is what makes "authorless" and "not this agent's" one
    // answer rather than two.
    const o = outline([
      ['heading', 'Meeting notes'],
      ['bullet', 'was the note-taker’s, now rewritten by hand'],
    ]);
    expect(notesSectionFits(o)).toBe(true);
  });
});

describe('a section new minutes must NOT reuse', () => {
  test('a previous meeting’s minutes', () => {
    const o = outline([
      ['heading', 'Meeting notes'],
      ['heading', 'Boardwalk survey', AGENT],
      ['bullet', 'Maya: the survey lands before the plaque wording', AGENT],
    ]);
    expect(notesSectionFits(o)).toBe(false);
  });

  test('MUTATION CONTROL: strip the authorship and the same doc fits', () => {
    // The rule is authorship and nothing else — same texts, same shape, same
    // heading. If this passed either way the check would be measuring the
    // heading count rather than whose work is under it.
    const rows: Array<['heading' | 'bullet', string, string?]> = [
      ['heading', 'Meeting notes'],
      ['heading', 'Boardwalk survey', AGENT],
      ['bullet', 'Maya: the survey lands before the plaque wording', AGENT],
    ];
    expect(notesSectionFits(outline(rows))).toBe(false);
    expect(notesSectionFits(outline(rows.map(([k, t]) => [k, t])))).toBe(true);
  });

  test('one authored line among the person’s own is enough', () => {
    const o = outline([
      ['heading', 'Meeting notes'],
      ['bullet', 'my own note'],
      ['bullet', 'Devin: the ferry dock argument again', AGENT],
      ['bullet', 'another of my own'],
    ]);
    expect(notesSectionFits(o)).toBe(false);
  });
});

describe('the body runs to the end of the doc, not to the next heading', () => {
  test('minutes under a topic heading inside the section still count as minutes', () => {
    // Every topic heading a meeting writes lives INSIDE the section, so a
    // reader that stopped at the next heading would call a full set of
    // minutes an empty section and reuse it.
    const o = outline([
      ['heading', 'Meeting notes'],
      ['heading', 'Plaque wording', AGENT],
      ['bullet', 'Devin: settled on the shorter text', AGENT],
    ]);
    expect(notesSectionFits(o)).toBe(false);
  });

  test('content ABOVE the last notes heading is not this section’s', () => {
    // A previous meeting's minutes sitting above a fresh empty heading are
    // not a reason to refuse the fresh one — the reader would never read
    // them as this section either.
    const o = outline([
      ['heading', 'Meeting notes'],
      ['bullet', 'yesterday’s minutes', AGENT],
      ['heading', 'Meeting notes'],
    ]);
    expect(notesSectionFits(o)).toBe(true);
  });
});

describe('the section a meeting adopts, end to end', () => {
  // The rule only bites through `notesSectionForMeeting`, which is what
  // records the answer in the heading memory. Adoption is the half that
  // makes reuse STICK: without it the bullets this meeting had just written
  // would read as somebody's work on the next tick and it would open a
  // second section anyway.
  const ids = { docId: 'd-fit', meetingId: 'm-fit-1' };

  function docWith(markdown: string, claim: boolean): NotesDocStore {
    const ydoc = new Y.Doc();
    prose.applyMarkdownToFragment(prose.getProseFragment(ydoc), markdown);
    if (claim) {
      for (const el of prose.addressableBlocks(prose.getProseFragment(ydoc))) {
        prose.claimSubtree(el, NOTES_AUTHOR_ID);
      }
    }
    return oneDocStore(ids.docId, { ydoc, meta: { type: 'markdown' as DocType } });
  }

  function adopted(markdown: string, claim: boolean): string | undefined {
    const store = docWith(markdown, claim);
    return notesSectionForMeeting(
      createNotesHeadingMemory(),
      ids,
      readNotesOutline(store, ids.docId),
      store,
    );
  }

  const PERSONAL = '## Meeting notes\n\n- my own note: check this before we commit\n';

  test('a notes section holding only a person’s line is adopted', () => {
    expect(adopted(PERSONAL, false)).toBeDefined();
  });

  test('MUTATION CONTROL: the same doc as a previous meeting’s minutes is not', () => {
    // Same markdown, same heading, same bullet. Only the authorship moves.
    expect(adopted(PERSONAL, true)).toBeUndefined();
  });

  test('an empty section is still adopted, as it was before the rule widened', () => {
    expect(adopted('## Meeting notes\n', false)).toBeDefined();
  });

  test('a doc with no notes section adopts nothing, and the composer opens one', () => {
    expect(adopted('# Riverbend kickoff\n\n- an agenda line\n', false)).toBeUndefined();
  });

  test('once adopted, the meeting keeps that section after it has written in it', () => {
    // The re-open this closes: the meeting's OWN bullets are authored, so a
    // fresh fit test on tick two would answer "somebody's" and open a second
    // heading. The memory is what stops that.
    const store = docWith(PERSONAL, false);
    const memory = createNotesHeadingMemory();
    const first = notesSectionForMeeting(memory, ids, readNotesOutline(store, ids.docId), store);
    expect(first).toBeDefined();
    // Now the meeting writes, and its lines are its own.
    for (const el of prose.addressableBlocks(prose.getProseFragment(store.get(ids.docId)!.ydoc))) {
      prose.claimSubtree(el, NOTES_AUTHOR_ID);
    }
    expect(notesSectionForMeeting(memory, ids, readNotesOutline(store, ids.docId), store)).toBe(
      first,
    );
  });
});
