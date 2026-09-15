import { describe, expect, test } from 'bun:test';
/**
 * RULE 2 judged on the words only the replaced note has, and a correction the
 * speaker made applied as the replace it is.
 *
 * Both shapes are from a live meeting on 2026-09-14, retold with fictional
 * content:
 *
 * - **Drift.** The note-taker rewrote its newest bullet tick after tick. Each
 *   rewrite kept the topic's words ("pier inbox") and dropped the rest, every
 *   one passed as a revision, and the meeting's main problem left the doc.
 * - **A correction kept twice.** The speaker withdrew a note ("stop showing
 *   hour guesses, count the requests instead"), the replace shared only the
 *   subject, and the guard kept the withdrawn note beside its correction.
 *
 * Every case runs the live write path, `applyNotesUpdate`, so what is asserted
 * is what the reader's doc holds. Fictional throughout. The repo is public.
 */
import { type DocType, prose } from '@claude-workspaces/core';
import * as Y from 'yjs';
import {
  type NotesHeadingMemory,
  applyNotesUpdate,
  createNotesHeadingMemory,
} from '../src/meeting-notes-doc.ts';
import type { NotesUpdate } from '../src/meeting-notes.ts';
import type { NotesDocStore } from '../src/notes-doc-access.ts';
import { oneDocStore } from './notes-doc-helpers.ts';

const MAIN = 'Pier inbox hides which requests are urgent before opening them';
const TOTAL = 'Pier inbox should show the total waiting';
const HOURS = 'Hour estimates for the hull patch were far off, three hours against forty minutes';

let seq = 0;

function update(edits: prose.BlockEdit[], speech: string[], meetingId = 'm-harbour'): NotesUpdate {
  return {
    docId: 'd-harbour',
    meetingId,
    tick: {
      tick: ++seq,
      reason: 'pause',
      turns: speech.map((text, turn) => ({ turn, text })),
    },
    edits,
  };
}

/** A meeting that has written its section: a topic and three notes. */
function meeting(hours = HOURS): {
  store: NotesDocStore;
  memory: NotesHeadingMemory;
  ydoc: Y.Doc;
} {
  const ydoc = new Y.Doc();
  prose.applyMarkdownToFragment(prose.getProseFragment(ydoc), '# Harbour huddle\n');
  const store = oneDocStore('d-harbour', { ydoc, meta: { type: 'markdown' as DocType } });
  const memory = createNotesHeadingMemory();
  const opened = applyNotesUpdate(
    store,
    update(
      [
        {
          op: 'insert_at_end',
          markdown: `## Meeting notes\n\n### Pier inbox\n\n- ${MAIN}\n- ${TOTAL}\n- ${hours}`,
        },
      ],
      ['The pier inbox hides which requests are urgent until I open each one.'],
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

function replace(
  fixture: ReturnType<typeof meeting>,
  note: string,
  markdown: string,
  speech: string[],
): string[] {
  const id = prose.readOutline(fixture.ydoc).find((e) => e.text === note)?.id;
  expect(id, `no bullet reading "${note}"`).toBeDefined();
  applyNotesUpdate(
    fixture.store,
    update([{ op: 'replace_block', blockId: id as string, markdown }], speech),
    fixture.memory,
  );
  return bullets(fixture.ydoc);
}

describe('a replace that keeps only the topic’s words', () => {
  test('is added beside the note, so the note it would have replaced stays', () => {
    const after = replace(
      meeting(),
      MAIN,
      '- Pier inbox should show a stacked bar of requests per pier',
      ['A stacked bar per pier across the top would help.'],
    );
    expect(after).toContain(MAIN);
    expect(after).toContain('Pier inbox should show a stacked bar of requests per pier');
  });

  test('a revision that keeps the note’s own words still replaces it in place', () => {
    const revised = 'Pier inbox hides which requests are urgent until each is opened';
    const after = replace(meeting(), MAIN, `- ${revised}`, [
      'You cannot tell which are urgent until each one is opened.',
    ]);
    expect(after).not.toContain(MAIN);
    expect(after.filter((t) => t.includes('urgent'))).toEqual([revised]);
  });
});

describe('a replace the speaker said as a correction', () => {
  const CORRECTED = 'Stop showing hour estimates; count requests instead';

  test('leaves one note, the correction, not both', () => {
    const after = replace(meeting(), HOURS, `- ${CORRECTED}`, [
      "And actually, let's stop showing hour guesses altogether and just count the requests instead.",
    ]);
    expect(after.filter((t) => /hour/i.test(t))).toEqual([CORRECTED]);
    expect(after).toContain(MAIN);
    expect(after).toContain(TOTAL);
  });

  test('leaves one note when the note, the speech and the correction each name the subject differently', () => {
    const timeNote =
      'Time estimates on the hull patch were far off, three hours against forty minutes';
    const corrected = 'Stop showing time estimates; count requests instead';
    const after = replace(meeting(timeNote), timeNote, `- ${corrected}`, [
      "And actually, let's stop showing hour guesses altogether and just count the requests instead.",
    ]);
    expect(after.filter((t) => /estimate/i.test(t))).toEqual([corrected]);
  });

  test('leaves one note when the correction writes the take-back as a removal', () => {
    const removed = 'Remove hour estimates; count requests instead';
    const after = replace(meeting(), HOURS, `- ${removed}`, [
      "And actually, let's stop showing hour guesses altogether and just count the requests instead.",
    ]);
    expect(after.filter((t) => /hour/i.test(t))).toEqual([removed]);
  });

  test('leaves one note when the take-back says the note’s word in another form', () => {
    // "estimated" in the speech, "estimates" in the correction: one word,
    // and with "hours" the take-back's second word in common with it.
    const after = replace(meeting(), HOURS, `- ${CORRECTED}`, [
      'Forget the estimated hours, we will track what comes in instead.',
    ]);
    expect(after.filter((t) => /hour/i.test(t))).toEqual([CORRECTED]);
  });

  test('keeps both when the take-back shares only an inflected word with the correction', () => {
    const after = replace(meeting(), HOURS, `- ${CORRECTED}`, [
      "Let's stop estimating the ferry crossings instead.",
    ]);
    expect(after).toContain(HOURS);
    expect(after).toContain(CORRECTED);
  });

  test('keeps both when the speech uses the note’s words in another form but takes nothing back', () => {
    const after = replace(meeting(), HOURS, `- ${CORRECTED}`, [
      'We estimated forty minutes for the hull patch and it took three hours, so count the requests.',
    ]);
    expect(after).toContain(HOURS);
    expect(after).toContain(CORRECTED);
  });

  test('keeps both when the speech takes back something the correction does not report', () => {
    const after = replace(meeting(), HOURS, `- ${CORRECTED}`, [
      "Let's drop the Sunday ferry instead.",
    ]);
    expect(after).toContain(HOURS);
    expect(after).toContain(CORRECTED);
  });

  test('keeps both when the speech takes nothing back', () => {
    const after = replace(meeting(), HOURS, `- ${CORRECTED}`, [
      'The hour estimates were far off on the hull patch, and we count the requests each morning.',
    ]);
    expect(after).toContain(HOURS);
    expect(after).toContain(CORRECTED);
  });

  test('keeps both when what the speech takes back is another subject', () => {
    const after = replace(meeting(), HOURS, '- Hour estimates stay; the Saltmarsh run stops', [
      "Let's stop the Saltmarsh run on Sundays instead.",
    ]);
    expect(after).toContain(HOURS);
  });

  test('keeps both when the replace shares one word of the note and the speech takes that back', () => {
    const after = replace(meeting(), HOURS, '- Hull crew goes home early instead', [
      'The hull crew goes home early instead.',
    ]);
    expect(after).toContain(HOURS);
  });
});
