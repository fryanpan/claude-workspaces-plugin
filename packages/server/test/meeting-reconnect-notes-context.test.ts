/**
 * A MEASUREMENT, not a feature: what a reconnect costs the note-taker.
 *
 * Resume-on-reconnect keeps the meeting — same id, same section, continued
 * turn numbering on the audio side. What it does NOT keep is the notes
 * session: the socket that dropped took its `beginNotesSession` with it, and
 * the resuming socket opens a new one. Everything that session held starts
 * again, and `onSessionStart` runs in full.
 *
 * This file exists to put an answer on the record, because the alternative is
 * somebody asking the question again in six months. It builds nothing — the
 * two legs below are the shape the relay already has, and every assertion
 * reads what already happens. The answer is written up in
 * `docs/architecture/meeting-assistant.md` under "What a reconnect resets".
 *
 * WIRED WITH A DATA DIR, because that is the only shape prod runs in: the
 * heading memory is backed by a file store when there is a dir to put it in,
 * and that store is the whole reason the section survives. Without one the
 * resuming leg opens a SECOND empty `Meeting notes` heading — measured, and
 * the reason this file does not take the dir away to "keep the test simple".
 *
 * All speech and notes are invented. The repo is public.
 */

import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prose, suggestOps } from '@claude-workspaces/core';
import * as Y from 'yjs';
import { createNotesHeadingMemory } from '../src/meeting-notes-doc.ts';
import type { NotesComposeInput } from '../src/meeting-notes.ts';

import { createNotesHeadingFileStore } from '../src/notes-heading-store.ts';
import { addNotes, createNotesTickHarness, type NotesTickHarness, SCRIPT_TOPIC } from './notes-tick-harness.ts';

const DOC = 'd-ferry-doc';
/** ONE meeting id across both legs — that is what a resume means. */
const MEETING = 'm-1760000000000';
const FIRST_LEG_NOTE = 'The ferry runs hourly until six.';

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

interface Reconnected {
  ydoc: Y.Doc;
  /** The first leg's only compose input. */
  before: NotesComposeInput;
  /** The resuming leg's first compose input — the measurement. */
  after: NotesComposeInput;
  leg2: NotesTickHarness;
}

/**
 * Two notes sessions over one doc, one heading memory and one meeting id:
 * the relay's own shape for a socket that dropped and came back.
 *
 * The first leg is never `end()`ed, because a dropped socket does not stop a
 * meeting — that is the whole difference between this and a second recording.
 */
async function droppedAndResumed(
  secondLeg: (input: NotesComposeInput) => readonly prose.BlockEdit[],
): Promise<Reconnected> {
  const dataDir = mkdtempSync(join(tmpdir(), 'cw-reconnect-notes-'));
  dirs.push(dataDir);
  const ydoc = new Y.Doc();
  // One memory per SERVER, backed by the file store — how `withServerNotesSinks`
  // builds it when a data dir is configured.
  const heading = createNotesHeadingMemory(createNotesHeadingFileStore(dataDir));
  const shared = { ydoc, heading, dataDir, docId: DOC, meetingId: MEETING } as const;

  const leg1 = createNotesTickHarness({
    ...shared,
    compose: (input) => addNotes(input, `- ${FIRST_LEG_NOTE}`),
  });
  const first = await leg1.speak(
    'The ferry runs hourly until six, and then it is done for the day.',
  );
  const before = first.input;
  if (!before) throw new Error('the first leg composed nothing');

  let captured: NotesComposeInput | undefined;
  const leg2 = createNotesTickHarness({
    ...shared,
    compose: (input) => {
      captured = input;
      return secondLeg(input);
    },
  });
  await leg2.speak('The slipway costs more than the timetable change does.');
  if (!captured) throw new Error('the resuming leg composed nothing');
  return { ydoc, before, after: captured, leg2 };
}

/** The id of the doc's one `Meeting notes` heading. */
function headingIdOf(harness: NotesTickHarness): string {
  const found = prose
    .readOutline(harness.ydoc)
    .find((e) => e.kind === 'heading' && e.text.trim() === SCRIPT_TOPIC);
  if (!found) throw new Error('the doc holds no notes section');
  return found.id;
}

describe('what a reconnect resets in the note-taker', () => {
  it('keeps the section and hands back an empty running context', async () => {
    const { before, after, leg2 } = await droppedAndResumed(() => []);

    // KEPT. The heading memory is keyed by meeting id and backed by a file,
    // so the resuming leg adopts the section the dropped one opened rather
    // than starting a second one below it. (The first leg's own first tick
    // carries no heading id: that is the tick that OPENS the section.)
    expect(before.notesHeadingId).toBeUndefined();
    expect(leg2.countHeadings(SCRIPT_TOPIC)).toBe(1);
    expect(after.notesHeadingId).toBe(headingIdOf(leg2));

    // RESET 1: tick numbering. The resuming leg's first tick is tick 1 again,
    // so anything keyed on how far into the meeting a tick is starts over.
    expect(before.tick.tick).toBe(1);
    expect(after.tick.tick).toBe(1);

    // RESET 2: the transcript the model is handed carries only what was said
    // after the socket came back. The first leg's sentence is not re-offered,
    // and nothing in the input marks the seam.
    const said = after.tick.turns.map((t) => t.text).join(' ');
    expect(said).toContain('slipway');
    expect(said).not.toContain('ferry');

    // RESET 3, the expensive one: authorship. Starting a notes session
    // releases the note-taker's claim on the whole doc, so the bullet the
    // FIRST leg wrote comes back to the resuming one as a person's line.
    expect(after.outline.filter((e) => e.author !== undefined)).toEqual([]);
    expect(after.humanNotes ?? []).toContain(FIRST_LEG_NOTE);
  });

  it('costs the resuming leg direct edits on its own earlier notes', async () => {
    // What RESET 3 means in the doc: the resuming leg revises the bullet the
    // dropped one wrote, and the revision lands as a SUGGESTION rather than a
    // rewrite, because the doc no longer records that bullet as its own.
    const { ydoc, after } = await droppedAndResumed((input) => {
      const bullet = input.outline.find((e) => e.kind !== 'heading');
      return bullet === undefined
        ? []
        : [
            {
              op: 'replace_block',
              blockId: bullet.id,
              markdown: '- The ferry runs hourly until five.',
            },
          ];
    });

    expect(after.outline.some((e) => e.kind !== 'heading')).toBe(true);
    expect(suggestOps.listSuggestions(ydoc).length).toBeGreaterThan(0);
  });
});
