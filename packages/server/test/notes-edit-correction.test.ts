import { describe, expect, test } from 'bun:test';
/**
 * A correction the speaker made leaves one note, whichever edit the
 * note-taker wrote it with — and a new note about the same subject is not
 * mistaken for one.
 *
 * The shapes are from replays of a fictional correction meeting on
 * 2026-09-14: the model wrote the correction as a NEW bullet beside the note it
 * withdrew, or as a replace naming one word of that note's own. Every case
 * that asserts a doc runs the live write path, `applyNotesUpdate`. Fictional
 * throughout. The repo is public.
 */
import { type DocType, prose } from '@claude-workspaces/core';
import * as Y from 'yjs';
import {
  type NotesHeadingMemory,
  applyNotesUpdate,
  createNotesHeadingMemory,
} from '../src/meeting-notes-doc.ts';
import type { NotesUpdate } from '../src/meeting-notes.ts';
import { sectionIds } from '../src/notes-cleanup-scope.ts';
import { NOTES_AUTHOR_ID, type NotesDocStore } from '../src/notes-doc-access.ts';
import { correctedNote } from '../src/notes-edit-correction.ts';
import { oneDocStore } from './notes-doc-helpers.ts';

const ESTIMATE = 'Hull patch estimate was forty minutes; the crew took three hours';
const CHECKLIST = 'Hull patch crew wants the welding checklist printed before the shift';
const URGENT = 'Pier inbox hides which requests are urgent before opening them';
const TOTAL = 'Pier inbox should show the total waiting';
const TAKE_BACK =
  'Going back to the hull patch. Forget the estimated hours on the board, we will track the requests that come in instead.';

let seq = 0;

function update(edits: prose.BlockEdit[], speech: string[]): NotesUpdate {
  return {
    docId: 'd-yard',
    meetingId: 'm-yard',
    tick: { tick: ++seq, reason: 'pause', turns: speech.map((text, turn) => ({ turn, text })) },
    edits,
  };
}

interface Meeting {
  store: NotesDocStore;
  memory: NotesHeadingMemory;
  ydoc: Y.Doc;
}

/** A meeting that has written two topics, two notes under each. */
function meeting(): Meeting {
  const ydoc = new Y.Doc();
  prose.applyMarkdownToFragment(prose.getProseFragment(ydoc), '# Yard huddle\n');
  const store = oneDocStore('d-yard', { ydoc, meta: { type: 'markdown' as DocType } });
  const memory = createNotesHeadingMemory();
  const opened = applyNotesUpdate(
    store,
    update(
      [
        {
          op: 'insert_at_end',
          markdown: `## Meeting notes\n\n### Hull patch\n\n- ${ESTIMATE}\n- ${CHECKLIST}\n\n### Pier inbox\n\n- ${URGENT}\n- ${TOTAL}`,
        },
      ],
      ['The hull patch estimate was forty minutes and it took three hours.'],
    ),
    memory,
  );
  expect(opened).toBe(null);
  return { store, memory, ydoc };
}

const bullets = (ydoc: Y.Doc): string[] =>
  prose
    .readOutline(ydoc)
    .filter((e) => e.kind === 'listItem')
    .map((e) => e.text);

const idOf = (m: Meeting, text: string): string => {
  const id = prose.readOutline(m.ydoc).find((e) => e.text === text)?.id;
  expect(id, `no block reading "${text}"`).toBeDefined();
  return id as string;
};

function write(m: Meeting, edit: prose.BlockEdit, speech: string[]): string[] {
  applyNotesUpdate(m.store, update([edit], speech), m.memory);
  return bullets(m.ydoc);
}

describe('a correction written as a new bullet beside the note', () => {
  test('replaces the note it withdraws', () => {
    const m = meeting();
    const correction = 'Track incoming requests instead of hour estimates';
    const after = write(
      m,
      { op: 'insert_under_heading', headingId: idOf(m, 'Hull patch'), markdown: `- ${correction}` },
      [TAKE_BACK],
    );
    expect(after.filter((t) => /estimate|forty/i.test(t))).toEqual([correction]);
    expect(after).toContain(CHECKLIST);
    expect(after).toContain(URGENT);
  });

  test('is added when what it withdraws is not what the note said', () => {
    // The note's subject is named — before the cue — and the emailing after
    // it is what goes.
    const m = meeting();
    const note = 'Print the checklist at the yard instead of emailing it';
    const after = write(
      m,
      { op: 'insert_under_heading', headingId: idOf(m, 'Hull patch'), markdown: `- ${note}` },
      ["Let's stop emailing the checklist and print it at the yard instead."],
    );
    expect(after).toContain(CHECKLIST);
    expect(after).toContain(note);
  });

  test('is added when it fixes what the note complained about', () => {
    const m = meeting();
    const fix = 'Show urgent requests first instead of hiding them';
    const after = write(
      m,
      { op: 'insert_under_heading', headingId: idOf(m, 'Pier inbox'), markdown: `- ${fix}` },
      ["Let's show the urgent requests first instead of hiding them."],
    );
    expect(after).toContain(URGENT);
    expect(after).toContain(fix);
  });

  test('is added when it lands under another topic', () => {
    const m = meeting();
    const correction = 'Track incoming requests instead of hour estimates';
    const after = write(
      m,
      { op: 'insert_under_heading', headingId: idOf(m, 'Pier inbox'), markdown: `- ${correction}` },
      [TAKE_BACK],
    );
    expect(after).toContain(ESTIMATE);
    expect(after).toContain(correction);
  });

  test('is added when the speech takes nothing back', () => {
    const m = meeting();
    const correction = 'Track incoming requests instead of hour estimates';
    const after = write(
      m,
      { op: 'insert_under_heading', headingId: idOf(m, 'Hull patch'), markdown: `- ${correction}` },
      ['The estimated hours were on the board, and we track the requests that come in.'],
    );
    expect(after).toContain(ESTIMATE);
    expect(after).toContain(correction);
  });
});

describe('a correction written as a replace naming one word of the note', () => {
  test('leaves one note when the take-back names the note twice', () => {
    const m = meeting();
    const correction = 'Track incoming requests instead of the board estimate';
    const after = write(
      m,
      { op: 'replace_block', blockId: idOf(m, ESTIMATE), markdown: `- ${correction}` },
      [TAKE_BACK],
    );
    expect(after.filter((t) => /estimate|forty/i.test(t))).toEqual([correction]);
  });

  test('keeps both when the take-back names the note once too', () => {
    const m = meeting();
    const correction = 'Track incoming requests instead of the board estimate';
    const after = write(
      m,
      { op: 'replace_block', blockId: idOf(m, ESTIMATE), markdown: `- ${correction}` },
      ['Forget the board estimate, we will track the requests that come in instead.'],
    );
    expect(after).toContain(ESTIMATE);
    expect(after).toContain(correction);
  });
});

describe('correctedNote', () => {
  const m = meeting();
  const outline = prose.readOutline(m.ydoc);
  const heading = outline.find((e) => e.text === 'Meeting notes')?.id as string;
  const scope = {
    outline,
    section: sectionIds(outline, heading).blocks,
    speech: [TAKE_BACK],
    headingId: idOf(m, 'Hull patch'),
    authorId: NOTES_AUTHOR_ID,
  };
  const correction = '- Track incoming requests instead of hour estimates';
  const estimateId = idOf(m, ESTIMATE);

  test('names the note a single-bullet correction withdraws', () => {
    expect(correctedNote(correction, scope)?.id).toBe(estimateId);
  });

  test('names nothing another author wrote', () => {
    expect(correctedNote(correction, { ...scope, authorId: 'agent:someone-else' })).toBe(undefined);
  });

  test('names nothing a person has commented on', () => {
    expect(correctedNote(correction, { ...scope, commented: new Set([estimateId]) })).toBe(
      undefined,
    );
  });

  test('judges no insert carrying more than one note', () => {
    expect(correctedNote(`${correction}\n- Welding checklist goes out Monday`, scope)).toBe(
      undefined,
    );
  });
});
