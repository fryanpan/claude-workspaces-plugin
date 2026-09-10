/**
 * The at-stop tidy-up pass, driven directly.
 *
 * The composer is a stub that returns whatever a case hands it, because the
 * questions worth asking here are not about a model: they are about what
 * happens to an edit list once it comes back. A pass that behaves when the
 * model is well-behaved is not the one that needs proving — the one that
 * matters is the pass handed edits aimed at a person's paragraph, at another
 * meeting's notes, and at the end of the document.
 *
 * All notes and all speech here are invented and every name is fictional.
 * The repo is public.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { prose } from '@claude-workspaces/core';
import * as Y from 'yjs';
import {
  CLEANUP_DIRECTIVE,
  CLEANUP_TRANSCRIPT_LABEL,
  MAX_CLEANUP_TRANSCRIPT_CHARS,
  runNotesCleanupPass,
} from '../src/notes-cleanup-pass.ts';
import { notesMarksLive } from '../src/notes-cleanup-scope.ts';
import { NOTES_AUTHOR_ID } from '../src/notes-doc-access.ts';
import {
  DOC,
  MEETING,
  NOTES,
  depsFor,
  docStoreFrom,
  dropFreshDirs,
  freshDir,
  idOf,
  stubComposer,
  writeTranscript,
} from './notes-cleanup-fixture.ts';

afterEach(dropFreshDirs);

describe('running a pass', () => {
  it('leaves the document byte for byte identical when the model changes nothing', async () => {
    const { store, markdownNow } = docStoreFrom(NOTES, ['Meeting notes']);
    const dataDir = freshDir();
    writeTranscript(dataDir, [{ turn: 0, text: 'The harbour run moves to the half hour.' }]);
    const before = markdownNow();
    const result = await runNotesCleanupPass(
      depsFor(store, stubComposer([]), dataDir, idOf(store, 'Meeting notes')),
      { docId: DOC, meetingId: MEETING },
    );
    expect(result.ok).toBe(true);
    expect(result.touched).toBe(0);
    expect(markdownNow()).toBe(before);
  });

  it("adds a missing point under the meeting's own heading", async () => {
    const { store, markdownNow } = docStoreFrom(NOTES, ['Meeting notes']);
    const dataDir = freshDir();
    writeTranscript(dataDir, [{ turn: 0, text: 'The slipway closes in October.' }]);
    const headingId = idOf(store, 'Ferry timetable');
    const result = await runNotesCleanupPass(
      depsFor(
        store,
        stubComposer([
          { op: 'insert_under_heading', headingId, markdown: '- The slipway closes in October' },
        ]),
        dataDir,
        idOf(store, 'Meeting notes'),
      ),
      { docId: DOC, meetingId: MEETING },
    );
    expect(result.applied).toBe(1);
    expect(result.touched).toBe(1);
    expect(markdownNow()).toContain('The slipway closes in October');
  });

  it("leaves a person's line alone, and files no redline on it either", async () => {
    const { store, markdownNow } = docStoreFrom(NOTES, ['Meeting notes']);
    const dataDir = freshDir();
    writeTranscript(dataDir, [{ turn: 0, text: 'Something about the slipway.' }]);
    const humanId = idOf(store, 'My own line about the slipway');
    const result = await runNotesCleanupPass(
      depsFor(
        store,
        stubComposer([{ op: 'replace_block', blockId: humanId, markdown: 'Rewritten by a robot' }]),
        dataDir,
        idOf(store, 'Meeting notes'),
      ),
      { docId: DOC, meetingId: MEETING },
    );
    expect(result.refused).toBe(1);
    expect(result.touched).toBe(0);
    expect(result.suggested).toBe(0);
    const after = markdownNow();
    expect(after).toContain('My own line about the slipway, which nobody may rewrite.');
    expect(after).not.toContain('Rewritten by a robot');
  });

  it('hands the composer the whole transcript under its own label, with the cleanup rules', async () => {
    const { store } = docStoreFrom(NOTES, ['Meeting notes']);
    const dataDir = freshDir();
    writeTranscript(
      dataDir,
      [
        { turn: 0, text: 'Opening remarks.', speaker: 'A' },
        { turn: 1, text: 'A later point.', speaker: 'B' },
      ],
      { A: 'Wren' },
    );
    const composer = stubComposer([]);
    await runNotesCleanupPass(depsFor(store, composer, dataDir, idOf(store, 'Meeting notes')), {
      docId: DOC,
      meetingId: MEETING,
    });
    const input = composer.seen[0];
    expect(input?.tick.turns).toHaveLength(2);
    expect(input?.tick.turns[0]?.speaker).toBe('Wren');
    expect(input?.tick.turns[0]?.speakerLabel).toBe('A');
    expect(input?.transcriptLabel).toBe(CLEANUP_TRANSCRIPT_LABEL);
    expect(input?.extraPrompt).toBe(CLEANUP_DIRECTIVE);
    expect(input?.multiSpeaker).toBe(true);
  });

  it('reports a composer that is down rather than throwing into the route', async () => {
    const { store, markdownNow } = docStoreFrom(NOTES, ['Meeting notes']);
    const dataDir = freshDir();
    writeTranscript(dataDir, [{ turn: 0, text: 'Anything at all.' }]);
    const before = markdownNow();
    const result = await runNotesCleanupPass(
      depsFor(
        store,
        stubComposer(() => {
          throw new Error('unreachable');
        }),
        dataDir,
        idOf(store, 'Meeting notes'),
      ),
      { docId: DOC, meetingId: MEETING },
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('compose-failed');
    expect(markdownNow()).toBe(before);
  });

  it('refuses a meeting with no transcript, and one with no composer', async () => {
    const { store } = docStoreFrom(NOTES, ['Meeting notes']);
    const dataDir = freshDir();
    const heading = idOf(store, 'Meeting notes');
    const noTranscript = await runNotesCleanupPass(
      depsFor(store, stubComposer([]), dataDir, heading),
      { docId: DOC, meetingId: MEETING },
    );
    expect(noTranscript.reason).toBe('no-transcript');
    writeTranscript(dataDir, [{ turn: 0, text: 'Words.' }]);
    const noComposer = await runNotesCleanupPass(depsFor(store, null, dataDir, heading), {
      docId: DOC,
      meetingId: MEETING,
    });
    expect(noComposer.reason).toBe('no-composer');
  });

  it('refuses a transcript past the ceiling rather than reading half a meeting', async () => {
    const { store } = docStoreFrom(NOTES, ['Meeting notes']);
    const dataDir = freshDir();
    writeTranscript(dataDir, [{ turn: 0, text: 'x'.repeat(MAX_CLEANUP_TRANSCRIPT_CHARS + 1) }]);
    const result = await runNotesCleanupPass(
      depsFor(store, stubComposer([]), dataDir, idOf(store, 'Meeting notes')),
      { docId: DOC, meetingId: MEETING },
    );
    expect(result.reason).toBe('transcript-too-long');
  });

  it("does not reach an earlier meeting's notes on the same doc", async () => {
    const two = [
      '## Meeting notes',
      '- last week: the crew rota was agreed',
      '',
      '## Meeting notes',
      '- today: the timetable moves',
    ].join('\n');
    const { store, markdownNow } = docStoreFrom(two, ['Meeting notes']);
    const dataDir = freshDir();
    writeTranscript(dataDir, [{ turn: 0, text: 'The timetable moves.' }]);
    const outline = store.readOutline(DOC)?.blocks ?? [];
    const headings = outline.filter((b) => b.text === 'Meeting notes');
    const older = outline.find((b) => b.text.includes('crew rota'));
    const result = await runNotesCleanupPass(
      depsFor(
        store,
        stubComposer([{ op: 'delete_block', blockId: older?.id ?? '' }]),
        dataDir,
        headings[1]?.id ?? '',
      ),
      { docId: DOC, meetingId: MEETING },
    );
    expect(result.refused).toBe(1);
    expect(markdownNow()).toContain('the crew rota was agreed');
  });
});

/**
 * A PERSON'S BULLET, INSIDE THE NOTE-TAKER'S OWN SECTION.
 *
 * This is the case criterion 2.3 is about and the one the loosened gate had
 * to keep refusing. The doc still carries the note-taker's marks, and one
 * bullet in the middle of its section carries none — because a person typed
 * it there during the meeting, or because they edited one of the note-taker's
 * and `clearAuthorshipOnPersonEdit` handed it back. The doc records those two
 * the same way, and both are theirs.
 *
 * The section check does not cover it. The person's line in `NOTES` sits
 * ABOVE the meeting heading, so it is out of reach on section membership
 * alone and proves nothing about ownership; this one is inside the section,
 * where only `claimable` stands between it and a rewrite.
 */
describe("a person's bullet inside the section, on a doc whose marks are live", () => {
  it('is not rewritten, not deleted, and not marked up', async () => {
    const { store, markdownNow } = docStoreFrom(NOTES, ['Meeting notes'], ['Kestrel Lane']);
    const dataDir = freshDir();
    writeTranscript(dataDir, [{ turn: 0, text: 'Kestrel Lane keeps the winter crew.' }]);
    const before = markdownNow();
    const result = await runNotesCleanupPass(
      depsFor(
        store,
        stubComposer([
          {
            op: 'replace_block',
            blockId: idOf(store, 'Kestrel Lane'),
            markdown: '- [@Ivo](speaker:B) keeps the winter crew on Kestrel Lane',
          },
          { op: 'delete_block', blockId: idOf(store, 'Kestrel Lane') },
        ]),
        dataDir,
        idOf(store, 'Meeting notes'),
      ),
      { docId: DOC, meetingId: MEETING },
    );
    expect(result.refused).toBe(2);
    // Not a redline either: nobody asked for their writing to be marked up.
    expect(result.suggested).toBe(0);
    expect(result.touched).toBe(0);
    expect(markdownNow()).toBe(before);
  });

  it('is named to the model as theirs, and is not in what the pass claims', async () => {
    // A gate the prompt contradicts is only half a rule. The model is told
    // the same thing the gate enforces, so it does not spend a pass proposing
    // edits that will be dropped.
    const { store } = docStoreFrom(NOTES, ['Meeting notes'], ['Kestrel Lane']);
    const dataDir = freshDir();
    writeTranscript(dataDir, [{ turn: 0, text: 'Kestrel Lane keeps the winter crew.' }]);
    const composer = stubComposer([]);
    await runNotesCleanupPass(depsFor(store, composer, dataDir, idOf(store, 'Meeting notes')), {
      docId: DOC,
      meetingId: MEETING,
    });
    const input = composer.seen[0];
    expect(input?.humanNotes).toContain('Kestrel Lane keeps the winter crew');
    expect(input?.claimed?.has(idOf(store, 'Kestrel Lane'))).toBe(false);
    // And the note-taker's own bullet beside it IS claimed.
    expect(input?.claimed?.has(idOf(store, 'harbour run'))).toBe(true);
  });
});

/**
 * What happens on a doc where NOTHING is marked.
 *
 * `cwAuthor` is a Yjs attribute, so it does not survive a markdown round trip
 * — a doc reparsed from disk comes back with no authorship at all — and
 * `releaseNotesAuthorship` drops the previous meeting's claim the moment a new
 * recording starts. Both leave the same state, and it is not the state above:
 * the doc records nothing about ANYBODY, so an unmarked block is unknown
 * rather than a person's.
 *
 * The gate used to read the two states identically and refuse both. It could
 * then not change a single word on a reparsed doc — including words it had
 * written itself — while still being free to append new bullets under the
 * heading, because an insert names a heading and no owner. Able to add to a
 * document it could not tidy was the worst of both, and Bryan chose the
 * looser rule ("Bring into line") over gating on authorship.
 */
describe('a doc whose marks have all been lost', () => {
  /** Round-trip a doc through markdown, the way a reparse from disk does. */
  const reparsed = (ydoc: Y.Doc): Y.Doc => {
    const markdown = prose.serializeFragmentToMarkdown(prose.getProseFragment(ydoc));
    const fresh = new Y.Doc();
    prose.applyMarkdownToFragment(prose.getProseFragment(fresh), markdown);
    prose.readOutline(fresh);
    return fresh;
  };

  it('really does lose cwAuthor through a markdown round trip', () => {
    // The premise every assertion below rests on, measured rather than
    // assumed — and with a positive control that it was there to begin with.
    const { ydoc } = docStoreFrom(NOTES, ['Meeting notes']);
    expect(prose.readOutline(ydoc).some((b) => b.author === NOTES_AUTHOR_ID)).toBe(true);
    expect(notesMarksLive(ydoc)).toBe(true);
    expect(prose.readOutline(reparsed(ydoc)).some((b) => b.author !== undefined)).toBe(false);
    expect(notesMarksLive(reparsed(ydoc))).toBe(false);
  });

  it('brings an unmarked bullet in its own section into line', async () => {
    // THE CASE THE OLD GATE REFUSED. Same edit, same doc, same section: all
    // that differs from the case above is that no mark survives anywhere, so
    // nothing here is recorded as a person's.
    const { store, markdownNow } = docStoreFrom(NOTES, []);
    const dataDir = freshDir();
    writeTranscript(dataDir, [{ turn: 0, text: 'The harbour run moves to the half hour.' }]);
    const result = await runNotesCleanupPass(
      depsFor(
        store,
        stubComposer([
          {
            op: 'replace_block',
            blockId: idOf(store, 'harbour run'),
            markdown: '- [@Ivo](speaker:B) moves the harbour run to the half hour from April',
          },
        ]),
        dataDir,
        idOf(store, 'Meeting notes'),
      ),
      { docId: DOC, meetingId: MEETING },
    );
    expect(result.refused).toBe(0);
    // APPLIED, not suggested. There are two ownership rules and loosening the
    // gate alone leaves the second one turning every rewrite into a redline —
    // "Show me first" is the option Bryan did not pick.
    expect(result.applied).toBe(1);
    expect(result.suggested).toBe(0);
    expect(result.touched).toBe(1);
    expect(markdownNow()).toContain('moves the harbour run to the half hour from April');
    expect(markdownNow()).not.toContain('The harbour run moves to the half hour from April');
  });

  it('tells the model the section is its own, rather than calling every line theirs', async () => {
    // Without this the loosening would be inert: the outline prints `theirs`
    // straight off the mark, so on this doc every line would read as a
    // person's and the model would leave all of them alone whatever the gate
    // allowed.
    const { store } = docStoreFrom(NOTES, []);
    const dataDir = freshDir();
    writeTranscript(dataDir, [{ turn: 0, text: 'The harbour run moves to the half hour.' }]);
    const composer = stubComposer([]);
    await runNotesCleanupPass(depsFor(store, composer, dataDir, idOf(store, 'Meeting notes')), {
      docId: DOC,
      meetingId: MEETING,
    });
    const input = composer.seen[0];
    expect(input?.claimed?.has(idOf(store, 'harbour run'))).toBe(true);
    expect(input?.humanNotes ?? []).not.toContain(
      'The harbour run moves to the half hour from April',
    );
    // The doc's own body, outside the meeting's section, is still theirs —
    // the pass has no business claiming a line it never wrote near.
    expect(input?.claimed?.has(idOf(store, 'My own line about the slipway'))).toBe(false);
    expect(input?.humanNotes).toContain('My own line about the slipway, which nobody may rewrite.');
  });

  it("still leaves the doc's own body alone, outside the meeting's section", async () => {
    const { store, markdownNow } = docStoreFrom(NOTES, []);
    const dataDir = freshDir();
    writeTranscript(dataDir, [{ turn: 0, text: 'Something about the slipway.' }]);
    const result = await runNotesCleanupPass(
      depsFor(
        store,
        stubComposer([
          {
            op: 'replace_block',
            blockId: idOf(store, 'My own line about the slipway'),
            markdown: 'Rewritten by a robot',
          },
        ]),
        dataDir,
        idOf(store, 'Meeting notes'),
      ),
      { docId: DOC, meetingId: MEETING },
    );
    expect(result.refused).toBe(1);
    expect(result.suggested).toBe(0);
    const after = markdownNow();
    expect(after).toContain('My own line about the slipway, which nobody may rewrite.');
    expect(after).not.toContain('Rewritten by a robot');
  });

  it('may still ADD a point it heard, as it always could', async () => {
    const { store, markdownNow } = docStoreFrom(NOTES, []);
    const dataDir = freshDir();
    writeTranscript(dataDir, [{ turn: 0, text: 'The slipway closes in October.' }]);
    const result = await runNotesCleanupPass(
      depsFor(
        store,
        stubComposer([
          {
            op: 'insert_under_heading',
            headingId: idOf(store, 'Ferry timetable'),
            markdown: '- The slipway closes in October',
          },
        ]),
        dataDir,
        idOf(store, 'Meeting notes'),
      ),
      { docId: DOC, meetingId: MEETING },
    );
    expect(result.refused).toBe(0);
    expect(result.touched).toBe(1);
    expect(markdownNow()).toContain('The slipway closes in October');
  });
});
