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
import {
  CLEANUP_DIRECTIVE,
  CLEANUP_TRANSCRIPT_LABEL,
  MAX_CLEANUP_TRANSCRIPT_CHARS,
  confineToSection,
  runNotesCleanupPass,
  sectionIds,
} from '../src/notes-cleanup-pass.ts';
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

describe('the section a cleanup may touch', () => {
  it('runs from the meeting heading to the next section, and no further', () => {
    const { store } = docStoreFrom(
      ['## Meeting notes', '### Topic', '- one', '## Other section', '- outside'].join('\n'),
      ['Meeting notes'],
    );
    const outline = store.readOutline(DOC)?.blocks ?? [];
    const heading = outline.find((b) => b.text === 'Meeting notes');
    const ids = sectionIds(outline, heading?.id ?? '');
    expect([...ids.blocks].map((id) => outline.find((b) => b.id === id)?.text)).toEqual([
      'Meeting notes',
      'Topic',
      'one',
    ]);
    expect(ids.headings.size).toBe(2);
  });
});

describe('what the gate refuses', () => {
  // `h1` is OWNED as well as being the section heading — that is the real
  // state a meeting leaves behind, and the heading-delete case below is
  // vacuous without it: an unowned heading is refused by the ownership
  // check, so the guard it means to prove is never reached.
  const scope = {
    blocks: new Set(['h1', 'b1', 'b2']),
    headings: new Set(['h1']),
    owned: new Set(['h1', 'b1']),
    headingId: 'h1',
  };

  it('drops an edit aimed at a block the note-taker does not own', () => {
    const { kept, refused } = confineToSection(
      [{ op: 'replace_block', blockId: 'b2', markdown: '- rewritten' }],
      scope,
    );
    expect(kept).toEqual([]);
    expect(refused).toBe(1);
  });

  it('drops an edit aimed outside the section', () => {
    const { kept } = confineToSection([{ op: 'delete_block', blockId: 'elsewhere' }], scope);
    expect(kept).toEqual([]);
  });

  it('refuses insert_at_end, which is how a second section gets opened', () => {
    const { kept } = confineToSection(
      [{ op: 'insert_at_end', markdown: '## Meeting notes' }],
      scope,
    );
    expect(kept).toEqual([]);
  });

  it('refuses a delete of the section heading itself — it orphans every note under it', () => {
    const { kept } = confineToSection([{ op: 'delete_block', blockId: 'h1' }], scope);
    expect(kept).toEqual([]);
    // And a rewrite of it, for the same reason: the heading is the address
    // the meeting's own notes are found at.
    expect(
      confineToSection([{ op: 'replace_block', blockId: 'h1', markdown: '## Notes' }], scope).kept,
    ).toEqual([]);
  });

  it("keeps a rewrite of the note-taker's own bullet, and an insert under its heading", () => {
    const { kept, refused } = confineToSection(
      [
        { op: 'replace_block', blockId: 'b1', markdown: '- tightened' },
        { op: 'insert_under_heading', headingId: 'h1', markdown: '- added' },
      ],
      scope,
    );
    expect(kept).toHaveLength(2);
    expect(refused).toBe(0);
  });

  it("refuses a nest whose members are not all the note-taker's", () => {
    const { kept } = confineToSection(
      [{ op: 'nest_blocks', leadBlockId: 'b1', blockIds: ['b2'] }],
      scope,
    );
    expect(kept).toEqual([]);
  });
});

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
