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

  it("leaves the doc's own body alone, and files no redline there either", async () => {
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
    // Outside the meeting's own section nothing is offered on either: the
    // pass has no business redlining the doc's prose. Inside the section a
    // person's line DOES get an offer — see the suggestion cases below, which
    // is what makes this zero a boundary rather than a blanket.
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
 * WHAT HAPPENS ON A DOC WHERE NOTHING IS MARKED.
 *
 * `cwAuthor` is a Yjs attribute, so it does not survive a markdown round trip
 * — a doc reparsed from disk comes back with no authorship at all — and
 * `releaseNotesAuthorship` drops the previous meeting's claim the moment a new
 * recording starts. A person editing the last marked block reaches the same
 * state one block at a time. The document does not record which of those
 * happened, so the pass treats every line there as somebody else's: it offers,
 * and it adds, and it rewrites nothing.
 *
 * An earlier reading of this PR went the other way — nothing marked meant
 * nothing was anybody's, so the pass could bring the whole section into line.
 * The cases below are that reading's own cases, inverted, with the document
 * asserted rather than the counts.
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
    // The premise every case below rests on, measured rather than assumed —
    // and with a positive control that the mark was there to begin with.
    const { ydoc } = docStoreFrom(NOTES, ['Meeting notes']);
    expect(prose.readOutline(ydoc).some((b) => b.author === NOTES_AUTHOR_ID)).toBe(true);
    expect(prose.readOutline(reparsed(ydoc)).some((b) => b.author !== undefined)).toBe(false);
  });

  it('never deletes a bullet in its own section, and never moves one', async () => {
    // Both were admitted while an unmarked block counted as nobody's. Neither
    // is an improvement to a line somebody may have written, and neither can
    // be offered as a redline, so both are dropped.
    const { store, markdownNow } = docStoreFrom(NOTES, []);
    const dataDir = freshDir();
    writeTranscript(dataDir, [{ turn: 0, text: 'The harbour run moves to the half hour.' }]);
    const before = markdownNow();
    const result = await runNotesCleanupPass(
      depsFor(
        store,
        stubComposer([
          { op: 'delete_block', blockId: idOf(store, 'Kestrel Lane') },
          {
            op: 'nest_blocks',
            leadBlockId: idOf(store, 'harbour run'),
            blockIds: [idOf(store, 'Kestrel Lane')],
          },
        ]),
        dataDir,
        idOf(store, 'Meeting notes'),
      ),
      { docId: DOC, meetingId: MEETING },
    );
    expect(result.refused).toBe(2);
    expect(result.touched).toBe(0);
    expect(markdownNow()).toBe(before);
  });

  it('tells the model those lines are not its own, and claims none of them', async () => {
    // The prompt and the gate are one answer. The model is told the section is
    // somebody's, so it spends the pass offering and adding rather than
    // proposing rewrites the gate would turn into redlines it never intended.
    const { store } = docStoreFrom(NOTES, []);
    const dataDir = freshDir();
    writeTranscript(dataDir, [{ turn: 0, text: 'The harbour run moves to the half hour.' }]);
    const composer = stubComposer([]);
    await runNotesCleanupPass(depsFor(store, composer, dataDir, idOf(store, 'Meeting notes')), {
      docId: DOC,
      meetingId: MEETING,
    });
    const input = composer.seen[0];
    expect(input?.claimed?.size).toBe(0);
    expect(input?.humanNotes).toContain('The harbour run moves to the half hour from April');
    // Control: the same fixture with the marks intact names that very bullet
    // as the pass's own, so the zero above is the missing mark.
    const live = docStoreFrom(NOTES, ['Meeting notes']);
    const seenLive = stubComposer([]);
    await runNotesCleanupPass(
      depsFor(live.store, seenLive, dataDir, idOf(live.store, 'Meeting notes')),
      { docId: DOC, meetingId: MEETING },
    );
    expect(seenLive.seen[0]?.claimed?.has(idOf(live.store, 'harbour run'))).toBe(true);
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
