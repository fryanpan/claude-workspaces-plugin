/**
 * Whether a recording carries on under the heading a meeting already wrote.
 *
 * THERE IS NO RESERVED SECTION, so nothing here is found by its words. The
 * question is answered from the RECORD — the claims a doc carries — and these
 * cases are written in claims for that reason. A heading nobody claimed is
 * the document's own, whatever it is called, and this meeting never writes
 * into it.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { describe, expect, test } from 'bun:test';
import { type DocType, prose } from '@claude-workspaces/core';
import * as Y from 'yjs';
import { createNotesHeadingMemory, notesSectionForMeeting } from '../src/meeting-notes-doc.ts';
import { NOTES_AUTHOR_ID, type NotesDocStore, readNotesOutline } from '../src/notes-doc-access.ts';
import type { NotesSectionClaim } from '../src/notes-heading-store.ts';
import {
  NOTES_CONTINUATION_WINDOW_MS,
  lastClaimedHeadingIndex,
  notesSectionEnd,
  notesSectionFits,
} from '../src/notes-section-fit.ts';
import { oneDocStore } from './notes-doc-helpers.ts';

const AGENT = 'agent:notes';

/** A fixed "now" for the rule's one time comparison, so how long ago a
 *  meeting stopped is data the case states rather than a clock it races. */
const NOW = 1_760_000_000_000;

/**
 * The claims a doc carries, by heading block id.
 *
 * A row with no age is a meeting that never recorded a stop — one recording
 * right now, or one the process died under. A row with an age is a meeting
 * that stopped that many milliseconds before `NOW`.
 */
function claims(
  ...rows: Array<[id: string, stoppedMsAgo?: number]>
): Map<string, NotesSectionClaim> {
  return new Map(
    rows.map(([id, ago]) => [
      id,
      ago === undefined ? { headingId: id } : { headingId: id, endedAt: NOW - ago },
    ]),
  );
}

/**
 * Levels matter here, so they are the real ones rather than one flat number.
 * A doc whose sections are `##` puts a meeting's topics at `##` and the
 * sub-topics under them at `###`, so a heading with no level given defaults
 * to 3 — INSIDE the section. Pass a level explicitly for a heading that is
 * meant to end one.
 */
function outline(
  rows: Array<[kind: 'heading' | 'bullet', text: string, author?: string, level?: number]>,
): readonly prose.OutlineEntry[] {
  return rows.map(([kind, text, author, level], i) => ({
    id: `b${i}`,
    kind,
    level: kind === 'heading' ? (level ?? 3) : 0,
    text,
    author,
  })) as unknown as readonly prose.OutlineEntry[];
}

describe('which heading the answer is about', () => {
  test('a doc no meeting has written into has none', () => {
    const o = outline([
      ['heading', 'Agenda', undefined, 2],
      ['bullet', 'ship the trail map'],
    ]);
    expect(lastClaimedHeadingIndex(o, claims())).toBe(-1);
  });

  test('a heading nobody claimed is the document’s own, whatever it says', () => {
    // THE WHOLE POINT OF THE REBUILD, in one case: these words used to be the
    // reserved section and are now just a heading somebody typed.
    const o = outline([['heading', 'Meeting notes', undefined, 2]]);
    expect(lastClaimedHeadingIndex(o, claims())).toBe(-1);
    expect(notesSectionFits(o, claims(), NOW)).toBe(true);
  });

  test('the LAST claimed one, because writing into an earlier one buries it', () => {
    const o = outline([
      ['heading', 'Ferry timetable', AGENT, 2],
      ['bullet', 'a line'],
      ['heading', 'Plaque wording', AGENT, 2],
    ]);
    expect(lastClaimedHeadingIndex(o, claims(['b0'], ['b2']))).toBe(2);
  });

  test('CONTROL: claim only the earlier one and that is the one it answers', () => {
    const o = outline([
      ['heading', 'Ferry timetable', AGENT, 2],
      ['bullet', 'a line'],
      ['heading', 'Plaque wording', undefined, 2],
    ]);
    expect(lastClaimedHeadingIndex(o, claims(['b0']))).toBe(0);
  });
});

describe('the section stops where the next section of the same level starts', () => {
  const followed = outline([
    ['heading', 'Ferry timetable', AGENT, 2],
    ['bullet', 'my own line'],
    ['heading', 'Action items', undefined, 2],
    ['bullet', 'the ferry dock quote', AGENT],
  ]);

  test('a block in the NEXT section is outside this one', () => {
    expect(notesSectionEnd(followed, 0)).toBe(2);
  });

  test('a deeper heading is a sub-topic and does not end the section', () => {
    const topics = outline([
      ['heading', 'Ferry timetable', AGENT, 2],
      ['heading', 'Harbour run', AGENT, 3],
      ['bullet', 'it moves to the half hour', AGENT],
    ]);
    expect(notesSectionEnd(topics, 0)).toBe(3);
  });

  test('MUTATION CONTROL: a doc written at level three reads its own levels', () => {
    // The case a hardcoded `2` gets wrong. Every heading here is level 3, so
    // the second one ENDS the first section; a reader that assumed sections
    // are level 2 would call a `###` a sub-topic and run past it.
    const deep = outline([
      ['heading', 'Ferry timetable', AGENT, 3],
      ['bullet', 'my own line'],
      ['heading', 'Action items', undefined, 3],
    ]);
    expect(notesSectionEnd(deep, 0)).toBe(2);
  });
});

describe('a claimed heading with nothing under it', () => {
  /**
   * The shape a meeting leaves when it writes a heading and then nothing:
   * cut short, every tick refused, or a room that said nothing worth a
   * bullet. The claim outlives the meeting, so the next one meets a heading
   * that is somebody's record and is also completely empty.
   */
  const emptyClaimed = outline([
    ['heading', 'Agenda', undefined, 2],
    ['bullet', 'the boardwalk'],
    ['heading', 'Ferry timetable', AGENT, 2],
  ]);

  test('fits, so no second identical heading is written under it', () => {
    expect(notesSectionFits(emptyClaimed, claims(['b2']), NOW)).toBe(true);
  });

  test('MUTATION CONTROL: give that same claimed heading one line and it does not fit', () => {
    const withMinutes = outline([
      ['heading', 'Agenda', undefined, 2],
      ['bullet', 'the boardwalk'],
      ['heading', 'Ferry timetable', AGENT, 2],
      ['bullet', 'a previous meeting’s bullet'],
    ]);
    expect(notesSectionFits(withMinutes, claims(['b2']), NOW)).toBe(false);
  });
});

/**
 * A SECOND RECORDING ON A DOC WHOSE LAST MEETING IS OVER.
 *
 * Bryan stopped a recording and started another one minutes later, and the
 * notes opened a second heading at the bottom of the page while the section
 * from minutes earlier sat above it. The claim was doing it: a heading some
 * meeting had recorded was that meeting's forever.
 *
 * So a claim now says whose the section is while the meeting is RUNNING, and
 * stops saying it once the meeting has stopped — with a window past which the
 * doc's last meeting is not this conversation any more.
 */
describe('a claimed section whose meeting has stopped', () => {
  const minutes = outline([
    ['heading', 'Ferry timetable', AGENT, 2],
    ['heading', 'Harbour run', AGENT, 3],
    ['bullet', 'it moves to the half hour', AGENT],
  ]);

  test('a recording minutes after the last one continues it', () => {
    expect(notesSectionFits(minutes, claims(['b0', 12 * 60_000]), NOW)).toBe(true);
  });

  test('MUTATION CONTROL: the same section under a meeting still recording does not', () => {
    // Same doc, same claim, same bullets — only the stop is missing. Two
    // recordings live on one doc keep their sections apart.
    expect(notesSectionFits(minutes, claims(['b0']), NOW)).toBe(false);
  });

  test('a meeting that stopped past the window gets a topic of its own', () => {
    const ago = NOTES_CONTINUATION_WINDOW_MS + 60_000;
    expect(notesSectionFits(minutes, claims(['b0', ago]), NOW)).toBe(false);
  });

  test('the window is read against the stop, right up to its edge', () => {
    expect(notesSectionFits(minutes, claims(['b0', NOTES_CONTINUATION_WINDOW_MS]), NOW)).toBe(true);
  });
});

describe('the section a meeting adopts, end to end', () => {
  // The rule only bites through `notesSectionForMeeting`, which is what
  // records the answer in the heading memory. Adoption is the half that makes
  // reuse STICK: without it the bullets this meeting had just written would
  // read as somebody's work on the next tick and it would start a second
  // topic anyway.
  const ids = { docId: 'd-fit', meetingId: 'm-fit-2' };
  const earlier = { docId: 'd-fit', meetingId: 'm-fit-1' };

  function docWith(markdown: string): NotesDocStore {
    const ydoc = new Y.Doc();
    prose.applyMarkdownToFragment(prose.getProseFragment(ydoc), markdown);
    return oneDocStore(ids.docId, { ydoc, meta: { type: 'markdown' as DocType } });
  }

  /** The id of the doc's heading with these words — what an earlier meeting
   *  would have recorded, looked up the way a test has to. */
  function headingId(store: NotesDocStore, text: string): string {
    const found = readNotesOutline(store, ids.docId).find(
      (e) => e.kind === 'heading' && e.text.trim() === text,
    );
    if (found === undefined) throw new Error(`no heading ${text}`);
    return found.id;
  }

  const DOC = '# Riverbend kickoff\n\n## Ferry timetable\n\n- the harbour run moves\n';

  test('a heading no meeting ever claimed is never adopted', () => {
    const store = docWith(DOC);
    expect(
      notesSectionForMeeting(
        createNotesHeadingMemory(),
        ids,
        readNotesOutline(store, ids.docId),
        store,
      ),
    ).toBeUndefined();
  });

  test('the previous meeting’s heading, once that meeting has stopped, is', () => {
    const store = docWith(DOC);
    const memory = createNotesHeadingMemory();
    memory.adopt(earlier, headingId(store, 'Ferry timetable'));
    memory.endMeeting(earlier, Date.now() - 12 * 60_000);
    expect(
      notesSectionForMeeting(memory, ids, readNotesOutline(store, ids.docId), store),
    ).toBe(headingId(store, 'Ferry timetable'));
  });

  test('MUTATION CONTROL: the same heading under a meeting still recording is not', () => {
    // Same doc, same claim. Only the stop is missing.
    const store = docWith(DOC);
    const memory = createNotesHeadingMemory();
    memory.adopt(earlier, headingId(store, 'Ferry timetable'));
    expect(
      notesSectionForMeeting(memory, ids, readNotesOutline(store, ids.docId), store),
    ).toBeUndefined();
  });

  test('once adopted, the meeting keeps that heading after it has written in it', () => {
    // The re-open this closes: the meeting's OWN bullets are authored, so a
    // fresh fit test on tick two would answer "somebody's" and start a second
    // topic. The memory is what stops that.
    const store = docWith(DOC);
    const memory = createNotesHeadingMemory();
    memory.adopt(earlier, headingId(store, 'Ferry timetable'));
    memory.endMeeting(earlier, Date.now() - 12 * 60_000);
    const first = notesSectionForMeeting(memory, ids, readNotesOutline(store, ids.docId), store);
    expect(first).toBeDefined();
    for (const el of prose.addressableBlocks(prose.getProseFragment(store.get(ids.docId)!.ydoc))) {
      prose.claimSubtree(el, NOTES_AUTHOR_ID);
    }
    expect(notesSectionForMeeting(memory, ids, readNotesOutline(store, ids.docId), store)).toBe(
      first,
    );
  });
});
