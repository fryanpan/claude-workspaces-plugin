/**
 * What a meeting wrote, read off a doc whose notes are NOT in one section.
 *
 * The shape every case here is built on is the one whole-doc note-taking
 * produces and the old reading could not see: a prepared document with its
 * own headings, a person's own bullet among the notes, and the meeting's
 * bullets filed under the heading for their topic. The section reading finds
 * the tail; this module has to find all of it.
 *
 * All notes and all speech here are invented and every name is fictional.
 * The repo is public.
 */

import { describe, expect, it } from 'bun:test';
import { prose } from '@claude-workspaces/core';
import * as Y from 'yjs';
import { NOTES_AUTHOR_ID, type NotesDocStore } from '../src/notes-doc-access.ts';
import { allBullets } from '../src/notes-quality.ts';
import { readMeetingNotes, readSectionMarkdown } from '../src/notes-written.ts';

const DOC = 'd-riverbend';

/** A meeting that filed its notes under the document's own headings, and
 *  opened one small section of its own at the end. */
const WHOLE_DOC_NOTES = [
  '# Riverbend ferry review',
  '',
  '## Timetable',
  '',
  '- Prep note: check the April sailings',
  '- The harbour run moves to the half hour',
  '- The winter crew stays on until April',
  '',
  '## Slipway',
  '',
  '- The cradle needs a new winch',
  '',
  '## Meeting notes',
  '',
  '- Paint arrives on Friday',
].join('\n');

/** The note-taker's own bullets, by the words in them. Everything else in the
 *  doc reads as a person's writing, which is how the live doc distinguishes
 *  them (`clearAuthorshipOnPersonEdit` takes the mark off an edited block). */
const WRITTEN_BY_MEETING = [
  'harbour run moves',
  'winter crew stays on',
  'cradle needs a new winch',
  'Paint arrives on Friday',
  'Meeting notes',
];

function docStoreFrom(
  markdown: string,
  ours: readonly string[] = WRITTEN_BY_MEETING,
): { store: NotesDocStore; headingId: (text: string) => string; idOf: (text: string) => string } {
  const ydoc = new Y.Doc();
  const fragment = prose.getProseFragment(ydoc);
  prose.applyMarkdownToFragment(fragment, markdown);
  prose.readOutline(ydoc); // mints the ids
  for (const el of prose.addressableBlocks(fragment)) {
    if (ours.some((phrase) => el.toString().includes(phrase))) {
      prose.setBlockAuthor(el, NOTES_AUTHOR_ID);
    }
  }
  const store: NotesDocStore = {
    get: (docId) => (docId === DOC ? { ydoc, meta: { type: 'markdown' as const } } : undefined),
    readOutline: (docId) => (docId === DOC ? { blocks: prose.readOutline(ydoc) } : null),
    applyBlockEdits: () => {
      throw new Error('reading the notes must not write');
    },
  };
  const find = (text: string, kind?: 'heading'): string => {
    const hit = prose
      .readOutline(ydoc)
      .find((b) => (kind === undefined || b.kind === kind) && b.text.includes(text));
    if (!hit) throw new Error(`no block saying ${text}`);
    return hit.id;
  };
  return { store, headingId: (t) => find(t, 'heading'), idOf: (t) => find(t) };
}

describe('the notes a meeting wrote, wherever they sit', () => {
  it('finds every bullet the meeting wrote, under whosever heading it sits', () => {
    const { store, headingId } = docStoreFrom(WHOLE_DOC_NOTES);
    const notes = readMeetingNotes(store, DOC, headingId('Meeting notes')).markdown;
    expect(allBullets(notes)).toEqual([
      'The harbour run moves to the half hour',
      'The winter crew stays on until April',
      'The cradle needs a new winch',
      'Paint arrives on Friday',
    ]);
  });

  it("leaves the person's own bullet out of the meeting's notes", () => {
    const { store, headingId } = docStoreFrom(WHOLE_DOC_NOTES);
    const notes = readMeetingNotes(store, DOC, headingId('Meeting notes')).markdown;
    expect(notes).not.toContain('Prep note');
  });

  it('brings the heading a note sits under, so the notes still read as topics', () => {
    const { store, headingId } = docStoreFrom(WHOLE_DOC_NOTES);
    const notes = readMeetingNotes(store, DOC, headingId('Meeting notes')).markdown;
    expect(notes).toContain('## Timetable');
    expect(notes).toContain('## Slipway');
  });

  it('THE CONTROL: the section reading sees one of those four bullets', () => {
    // The measure this module replaces, on the same doc. A real run on
    // 2026-09-16 read 4 bullets this way and missed 182.
    const { store, headingId } = docStoreFrom(WHOLE_DOC_NOTES);
    const section = readSectionMarkdown(store, DOC, headingId('Meeting notes'));
    expect(allBullets(section)).toEqual(['Paint arrives on Friday']);
  });

  it('reads exactly the section when the doc carries no marks at all', () => {
    // A doc that went through a markdown round trip has no authorship left.
    // Losing notes from this reading is the direction it is allowed to fail
    // in; picking up somebody else's is not.
    const { store, headingId } = docStoreFrom(WHOLE_DOC_NOTES, []);
    const head = headingId('Meeting notes');
    expect(readMeetingNotes(store, DOC, head).markdown).toBe(readSectionMarkdown(store, DOC, head));
  });

  it('reads the notes of a meeting that opened no section of its own', () => {
    const { store } = docStoreFrom(WHOLE_DOC_NOTES);
    const notes = readMeetingNotes(store, DOC, undefined).markdown;
    expect(allBullets(notes)).toContain('The harbour run moves to the half hour');
  });

  it('drops a block the previous recording wrote', () => {
    const { store, headingId, idOf } = docStoreFrom(WHOLE_DOC_NOTES);
    const notes = readMeetingNotes(
      store,
      DOC,
      headingId('Meeting notes'),
      new Set([idOf('winter crew stays on')]),
    ).markdown;
    expect(notes).not.toContain('winter crew');
    expect(notes).toContain('The harbour run moves');
  });

  it('writes a nested bullet once, so grouped notes are not read as repeats', () => {
    const { store, headingId } = docStoreFrom(
      ['## Slipway', '', '- The cradle needs a new winch', '  - Paint arrives on Friday'].join(
        '\n',
      ),
    );
    const notes = readMeetingNotes(store, DOC, headingId('Slipway')).markdown;
    expect(notes.split('Paint arrives on Friday').length - 1).toBe(1);
  });

  it('is empty for a doc that is gone', () => {
    const { store } = docStoreFrom(WHOLE_DOC_NOTES);
    expect(readMeetingNotes(store, 'd-nowhere', undefined).markdown).toBe('');
  });
});

/* ===== The 2026-09-15 zero, and the three states that end it ===== */

/**
 * On 2026-09-15 one meeting's quality item was filed seven times on one doc
 * with one headline, the denominator climbing 15, 33, 75, 160, 199, 262, each
 * one saying 100% of what was said had reached no note. 172 notes had been
 * written. The reader returned zero bullets, so every idea was uncovered by
 * construction and the flag could never clear.
 *
 * The shape below is that meeting's: a prepared document, the notes filed
 * under the document's own headings, and no section of the meeting's own —
 * which is what whole-doc note-taking produces and what the reading of the
 * day could not address. The first case drives the reader the server runs
 * today; the control drives the reading it ran then, over the same document.
 */
describe('the shape that read zero from a document holding notes', () => {
  it('reads the notes a meeting filed under the document own headings', () => {
    const { store } = docStoreFrom(WHOLE_DOC_NOTES);
    const reading = readMeetingNotes(store, DOC, undefined);
    expect(allBullets(reading.markdown).length).toBeGreaterThan(0);
    expect(reading.source).toBe('notes');
  });

  it('THE CONTROL: the 2026-09-15 reading of the same document finds none', () => {
    // Section-only, with no section to name — the reading that produced the
    // zero. Same document, same notes, same marks.
    const { store } = docStoreFrom(WHOLE_DOC_NOTES);
    expect(allBullets(readSectionMarkdown(store, DOC, undefined))).toEqual([]);
  });

  it('calls a reading that found nothing in a document holding blocks unreadable', () => {
    // Every recording LEG releases the note-taker's authorship marks on its
    // own start (`releaseNotesAuthorship`), so a leg that composed nothing
    // new has no marks AND — on a prepared doc — no section. Both halves of
    // the address fail at once, and the notes are still sitting in the doc.
    const { store } = docStoreFrom(WHOLE_DOC_NOTES, []);
    const reading = readMeetingNotes(store, DOC, undefined);
    expect(reading.markdown).toBe('');
    expect(reading.source).toBe('unreadable');
    expect(reading.missing ?? '').not.toBe('');
  });

  it('THE CONTROL: a genuinely empty document reads as a real zero', () => {
    // The state that must NOT be called unreadable: there are no blocks for
    // the reading to have missed, so nothing written down is a fact about the
    // meeting and a coverage verdict over it is honest.
    const { store } = docStoreFrom('');
    const reading = readMeetingNotes(store, DOC, undefined);
    expect(reading.markdown).toBe('');
    expect(reading.source).toBe('notes');
  });

  it('calls a document it could not reach unreadable, not empty', () => {
    const { store } = docStoreFrom(WHOLE_DOC_NOTES);
    expect(readMeetingNotes(store, 'd-nowhere', undefined).source).toBe('unreadable');
  });
});
