/**
 * THE GUESSES A MEETING LEFT MARKED ARE NAMED TO THE PASS THAT CAN SETTLE
 * THEM, AND COUNTED AFTERWARDS.
 *
 * A clause asking the cleanup to fix "a point marked (unconfirmed) that the
 * rest of the meeting confirms or refutes" shipped once; three survived a real
 * 41-minute meeting. `notes-unconfirmed.ts` has why — the clause was
 * conditional, it named no ids, and on that meeting every cleanup edit was
 * dropped by the section gate anyway. These cases pin the two halves that
 * replace it: the directive names each marked note by id, and the pass reports
 * how many were still marked when it finished.
 *
 * All notes and all names are invented. The repo is public.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { type prose, prose as proseNs } from '@claude-workspaces/core';
import * as Y from 'yjs';
import { runNotesCleanupPass } from '../src/notes-cleanup-pass.ts';
import { NOTES_AUTHOR_ID } from '../src/notes-doc-access.ts';
import { unconfirmedDirective, unconfirmedNotes } from '../src/notes-unconfirmed.ts';
import {
  DOC,
  MEETING,
  depsFor,
  docStoreFrom,
  dropFreshDirs,
  freshDir,
  idOf,
  stubComposer,
  writeTranscript,
} from './notes-cleanup-fixture.ts';

afterEach(dropFreshDirs);

/** A finished meeting whose section carries two guesses and one settled note,
 *  with a marked line outside the section that is none of the pass's business. */
const MARKED_NOTES = [
  '# Riverbend ferry review',
  '',
  'My own line about the slipway (unconfirmed), which nobody may rewrite.',
  '',
  '## Meeting notes',
  '',
  '### Ferry timetable',
  '',
  '- The harbour run moves to the half hour from April',
  '- The crane booking may slip to May (unconfirmed)',
  '- Kestrel Lane keeps the winter crew (unconfirmed)',
  '',
  '## Agenda',
  '',
  '- The pontoon survey is overdue (unconfirmed)',
].join('\n');

describe('which notes are named', () => {
  const store = docStoreFrom(MARKED_NOTES, ['Meeting notes']).store;
  const outline = (): readonly prose.OutlineEntry[] => store.readOutline(DOC)?.blocks ?? [];

  it("names only the note-taker's own marked notes inside the section", () => {
    const found = unconfirmedNotes(outline(), {
      headingId: idOf(store, 'Meeting notes'),
      author: NOTES_AUTHOR_ID,
    });
    expect(found.map((n) => n.text)).toEqual([
      'The crane booking may slip to May (unconfirmed)',
      'Kestrel Lane keeps the winter crew (unconfirmed)',
    ]);
  });

  it('leaves a commented note out — the pass cannot rewrite one', () => {
    const marked = idOf(store, 'crane booking');
    const found = unconfirmedNotes(outline(), {
      headingId: idOf(store, 'Meeting notes'),
      author: NOTES_AUTHOR_ID,
      commented: new Set([marked]),
    });
    expect(found.map((n) => n.id)).not.toContain(marked);
    expect(found).toHaveLength(1);
  });

  it('a section with no guesses in it asks for nothing', () => {
    const clean = docStoreFrom(
      ['## Meeting notes', '', '- The harbour run moves to the half hour'].join('\n'),
      ['Meeting notes'],
    ).store;
    const found = unconfirmedNotes(clean.readOutline(DOC)?.blocks ?? [], {
      headingId: idOf(clean, 'Meeting notes'),
      author: NOTES_AUTHOR_ID,
    });
    expect(found).toEqual([]);
    expect(unconfirmedDirective(found)).toBeNull();
  });
});

describe('what the directive asks for', () => {
  it('names every id, and asks for the marker to go rather than the note', () => {
    const directive =
      unconfirmedDirective([
        { id: 'b7', text: 'The crane booking may slip to May (unconfirmed)' },
        { id: 'b8', text: 'Kestrel Lane keeps the winter crew (unconfirmed)' },
      ]) ?? '';
    expect(directive).toContain('b7');
    expect(directive).toContain('b8');
    expect(directive).toContain('replace_block');
    expect(directive).toContain('Do not delete the note');
    expect(directive).toContain('2 NOTES');
  });
});

describe('a pass counts the guesses it left behind', () => {
  it('settles the notes it was told about, and reports none still marked', async () => {
    const { store, markdownNow } = docStoreFrom(MARKED_NOTES, ['Meeting notes']);
    const dataDir = freshDir();
    writeTranscript(dataDir, [
      { turn: 1, text: 'the crane booking is confirmed for May, the yard wrote back' },
      { turn: 2, text: 'and Kestrel Lane is definitely keeping the winter crew' },
    ]);
    const composer = stubComposer([
      {
        op: 'replace_block',
        blockId: idOf(store, 'crane booking'),
        markdown: '- The crane booking slips to May',
      },
      {
        op: 'replace_block',
        blockId: idOf(store, 'Kestrel Lane'),
        markdown: '- Kestrel Lane keeps the winter crew',
      },
    ]);
    const result = await runNotesCleanupPass(
      depsFor(store, composer, dataDir, idOf(store, 'Meeting notes')),
      { docId: DOC, meetingId: MEETING },
    );
    expect(result.unconfirmed).toBe(2);
    expect(result.unconfirmedLeft).toBe(0);
    // The two outside the section are untouched: a person's own line and the
    // agenda are not the pass's to settle.
    const after = markdownNow();
    expect(after).toContain('My own line about the slipway (unconfirmed)');
    expect(after).toContain('The pontoon survey is overdue (unconfirmed)');
  });

  it('a pass that settles nothing says so instead of assuming it did', async () => {
    const { store } = docStoreFrom(MARKED_NOTES, ['Meeting notes']);
    const dataDir = freshDir();
    writeTranscript(dataDir, [{ turn: 1, text: 'nobody said anything conclusive' }]);
    const result = await runNotesCleanupPass(
      depsFor(store, stubComposer([]), dataDir, idOf(store, 'Meeting notes')),
      { docId: DOC, meetingId: MEETING },
    );
    expect(result.unconfirmed).toBe(2);
    expect(result.unconfirmedLeft).toBe(2);
    expect(result.line).toContain('2 still marked');
  });

  it('the composer is handed the ids, not left to find them', async () => {
    const { store } = docStoreFrom(MARKED_NOTES, ['Meeting notes']);
    const dataDir = freshDir();
    writeTranscript(dataDir, [{ turn: 1, text: 'the crane booking came back confirmed' }]);
    const composer = stubComposer([]);
    await runNotesCleanupPass(depsFor(store, composer, dataDir, idOf(store, 'Meeting notes')), {
      docId: DOC,
      meetingId: MEETING,
    });
    const prompt = composer.seen[0]?.extraPrompt ?? '';
    expect(prompt).toContain(idOf(store, 'crane booking'));
    expect(prompt).toContain(idOf(store, 'Kestrel Lane'));
    // And not the ones outside the section.
    expect(prompt).not.toContain(idOf(store, 'pontoon survey'));
  });
});

/** Anchor a thread over `needle` exactly as the editor does. */
function commentOn(ydoc: Y.Doc, needle: string): void {
  const walk = proseNs.walkProse(proseNs.getProseFragment(ydoc));
  const at = walk.plainText.indexOf(needle);
  if (at < 0) throw new Error(`no text matching ${needle}`);
  const seg = walk.segments.find((s) => at >= s.docOffset && at < s.docOffset + s.length);
  if (!seg) throw new Error('the bullet has no text segment');
  const thread = new Y.Map<unknown>();
  thread.set('anchor', {
    kind: 'text-range',
    startRel: Y.encodeRelativePosition(
      Y.createRelativePositionFromTypeIndex(seg.node, at - seg.docOffset),
    ),
    endRel: Y.encodeRelativePosition(
      Y.createRelativePositionFromTypeIndex(seg.node, at - seg.docOffset + needle.length),
    ),
    snippet: { text: needle },
  });
  (ydoc.getMap('threads') as Y.Map<Y.Map<unknown>>).set('t1', thread);
}

describe('a commented guess is not asked about and is still counted', () => {
  it('survives the pass, and the pass says so', async () => {
    const { store, ydoc, markdownNow } = docStoreFrom(MARKED_NOTES, ['Meeting notes']);
    // Somebody is already discussing the crane booking, so the pass may not
    // rewrite it — but the marker is still on the page.
    commentOn(ydoc, 'crane booking');
    const dataDir = freshDir();
    writeTranscript(dataDir, [{ turn: 1, text: 'the yard confirmed the crane booking for May' }]);
    const composer = stubComposer([
      {
        op: 'replace_block',
        blockId: idOf(store, 'Kestrel Lane'),
        markdown: '- Kestrel Lane keeps the winter crew',
      },
    ]);
    const result = await runNotesCleanupPass(
      depsFor(store, composer, dataDir, idOf(store, 'Meeting notes')),
      { docId: DOC, meetingId: MEETING },
    );
    // Asked about one — the uncommented one.
    expect(result.unconfirmed).toBe(1);
    expect(composer.seen[0]?.extraPrompt ?? '').not.toContain(idOf(store, 'crane booking'));
    // And the commented one is still marked, which the count and the line say.
    expect(result.unconfirmedLeft).toBe(1);
    expect(result.line).toContain('1 still marked');
    expect(markdownNow()).toContain('The crane booking may slip to May (unconfirmed)');
  });
});
