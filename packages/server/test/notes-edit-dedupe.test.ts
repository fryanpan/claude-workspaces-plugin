/**
 * Each topic heading once, each note once, and no decision nobody took —
 * through the live notes path, the way a meeting's ticks write them.
 *
 * Every script below is a shape a 2026-09-14 meeting left in a real doc, on
 * fictional content:
 *
 * - a topic heading the section already had, opened again at the end of the
 *   section, four and five times, most with nothing under them;
 * - flat first-pass bullets still standing after the same points were
 *   restated under their topics;
 * - a replace the guard turned into an add, so a note stood beside its own
 *   restatement;
 * - a `Decision:` label on something a speaker only described doing.
 *
 * All fixtures are synthetic. The repo is public.
 */

import { describe, expect, it } from 'bun:test';
import { type DocType, prose } from '@claude-workspaces/core';
import * as Y from 'yjs';
import { applyNotesUpdate, createNotesHeadingMemory } from '../src/meeting-notes-doc.ts';
import type { NotesComposeInput, NotesUpdate } from '../src/meeting-notes.ts';
import { NOTES_AUTHOR_ID } from '../src/notes-doc-access.ts';
import { dedupeNotesEdits, sameNote } from '../src/notes-edit-dedupe.ts';
import { oneDocStore } from './notes-doc-helpers.ts';
import { addNotes, createNotesTickHarness } from './notes-tick-harness.ts';

const count = (text: string, needle: string): number => text.split(needle).length - 1;

/** The id of the outline entry whose text includes `needle`. */
function idOf(input: NotesComposeInput, needle: string): string {
  const found = input.outline.find((e) => e.text.includes(needle));
  if (!found) throw new Error(`no block reading ${needle}`);
  return found.id;
}

describe('a topic heading the section already has', () => {
  it('is written once, and the notes under the repeat join the first', async () => {
    const h = createNotesTickHarness({
      compose: (input, tick) => {
        const heading = input.notesHeadingId;
        if (tick === 1) return addNotes(input, '### Ferry timetable\n\n- Two sailings leave daily');
        if (tick === 2) return addNotes(input, '### Crew rota\n\n- Rota changes every Monday');
        if (tick === 3 && heading) {
          return [
            {
              op: 'insert_at_end',
              markdown: '### Ferry timetable\n\n- Winter sailings stop at six',
            },
          ];
        }
        return [{ op: 'insert_at_end', markdown: '### Ferry timetable' }];
      },
    });
    await h.speak('two sailings leave daily');
    await h.speak('the rota changes every Monday');
    await h.speak('winter sailings stop at six');
    await h.speak('back to the ferry timetable');
    const notes = h.notes();
    expect(count(notes, '### Ferry timetable')).toBe(1);
    expect(count(notes, '### Crew rota')).toBe(1);
    // Under the topic it is about, not under the last heading in the section.
    expect(notes.indexOf('Winter sailings')).toBeLessThan(notes.indexOf('### Crew rota'));
    expect(h.errors).toEqual([]);
  });

  it('reworded as a longer name for the same topic, is still written once', async () => {
    const h = createNotesTickHarness({
      compose: (input, tick) => {
        if (tick === 1) return addNotes(input, '### Harbour review\n\n- Queue is short most days');
        if (tick === 2) return addNotes(input, '### Crew rota\n\n- Rota changes every Monday');
        return [
          {
            op: 'insert_at_end',
            markdown: '### Initial feedback on harbour review\n\n- Review order helps the crew',
          },
        ];
      },
    });
    await h.speak('the queue is short most days');
    await h.speak('the rota changes every Monday');
    await h.speak('the review order helps the crew');
    const notes = h.notes();
    expect(notes).not.toContain('Initial feedback');
    expect(notes.indexOf('Review order helps')).toBeLessThan(notes.indexOf('### Crew rota'));
    // The control: a different topic that shares a word is its own heading.
    expect(count(notes, '### Crew rota')).toBe(1);
  });

  it('opened twice in one batch, is written once with both notes under it', async () => {
    const h = createNotesTickHarness({
      compose: (input, tick) =>
        tick === 1
          ? addNotes(input, '- Slipway work is booked')
          : [
              {
                op: 'insert_at_end',
                markdown: '### Slipway repairs\n\n- Cradle needs a new winch',
              },
              { op: 'insert_at_end', markdown: '### Crew rota\n\n- Rota changes every Monday' },
              {
                op: 'insert_at_end',
                markdown: '### Initial slipway repairs\n\n- Paint arrives on Friday',
              },
            ],
    });
    await h.speak('slipway work is booked');
    await h.speak('the cradle needs a new winch and paint arrives on Friday');
    const notes = h.notes();
    expect(count(notes, '### Slipway')).toBe(1);
    expect(notes).toContain('Cradle needs a new winch');
    expect(notes).not.toContain('Initial slipway');
    expect(notes.indexOf('Paint arrives on Friday')).toBeLessThan(notes.indexOf('### Crew rota'));
  });
});

describe('a note the section already carries', () => {
  it('restated under a new topic, is moved there rather than written twice', async () => {
    const h = createNotesTickHarness({
      compose: (input, tick) =>
        tick === 1
          ? addNotes(input, '- Harbour crane inspection is overdue by a week')
          : [
              {
                op: 'insert_at_end',
                markdown: '### Crane\n\n- Harbour crane inspection is overdue by a week',
              },
            ],
    });
    await h.speak('the harbour crane inspection is overdue by a week');
    await h.speak('so on the crane');
    const notes = h.notes();
    expect(count(notes, 'crane inspection is overdue')).toBe(1);
    expect(notes.indexOf('crane inspection')).toBeGreaterThan(notes.indexOf('### Crane'));
  });

  it('restated with its label and speaker tag changed, is still the same note', () => {
    expect(
      sameNote(
        '- **Question:** [@Deckhand](speaker:A) Does the crane inspection slip again?',
        'Does the crane inspection slip again (unconfirmed)',
      ),
    ).toBe(true);
    // The opposite fact is not a restatement, however many words it shares.
    expect(
      sameNote(
        'Crane is safe for the Monday inspection',
        "Crane isn't safe for the Monday inspection",
      ),
    ).toBe(false);
    expect(
      sameNote(
        'Crane is safe for the Monday inspection',
        'Crane is not safe for the Monday inspection',
      ),
    ).toBe(false);
    // The control: two notes about one crane are not one note.
    expect(
      sameNote('Crane inspection slips a week', 'Crane inspection needs a second engineer'),
    ).toBe(false);
  });

  it('re-sent word for word under the same heading, is not written again', async () => {
    const h = createNotesTickHarness({
      compose: (input) => addNotes(input, '- Pontoon lights are out at Saltmarsh'),
    });
    await h.speak('the pontoon lights are out at Saltmarsh');
    await h.speak('yes the pontoon lights');
    expect(count(h.notes(), 'Pontoon lights are out')).toBe(1);
    expect(h.errors).toEqual([]);
  });

  it('re-sent as the whole batch, is reported as words in the doc, not as a write with none', () => {
    // The not-written notice reads this answer: a batch whose note was already
    // there has the room's words in the doc, and must not keep that notice up.
    const ydoc = new Y.Doc();
    const store = oneDocStore('d', { ydoc, meta: { type: 'markdown' as DocType } });
    const memory = createNotesHeadingMemory();
    const update = (edits: prose.BlockEdit[]): NotesUpdate => ({
      docId: 'd',
      meetingId: 'm-d',
      tick: { tick: 1, reason: 'pause', turns: [{ turn: 0, text: 'the pontoon lights are out' }] },
      edits,
    });
    applyNotesUpdate(
      store,
      update([{ op: 'insert_at_end', markdown: '## Meeting notes\n\n- Pontoon lights are out' }]),
      memory,
    );
    const headingId = memory.headingId({ docId: 'd', meetingId: 'm-d' }, prose.readOutline(ydoc));
    let words = false;
    const res = applyNotesUpdate(
      store,
      update([
        {
          op: 'insert_under_heading',
          headingId: headingId as string,
          markdown: '- Pontoon lights are out',
        },
      ]),
      memory,
      {
        onWordsLanded: () => {
          words = true;
        },
      },
    );
    expect(res).toBe(null);
    expect(words).toBe(true);
    expect(count(prose.serializeFragmentToMarkdown(prose.getProseFragment(ydoc)), 'Pontoon')).toBe(
      1,
    );
  });

  it('re-sent as a bare line with no list marker, is still not written again', () => {
    const doc = new Y.Doc();
    prose.applyMarkdownToFragment(
      prose.getProseFragment(doc),
      '## Meeting notes\n\n- Pontoon lights are out at Saltmarsh\n',
    );
    prose.ensureBlockIds(doc);
    const outline = prose.readOutline(doc);
    const heading = outline.find((e) => e.text === 'Meeting notes')?.id;
    const res = dedupeNotesEdits(
      [{ op: 'insert_at_end', markdown: 'Pontoon lights are out at Saltmarsh\n\nAgenda first' }],
      { notesHeadingId: heading, outline, speech: ['lights'], authorId: NOTES_AUTHOR_ID },
    );
    expect(res.alreadyWritten).toBe(1);
    expect(res.edits).toEqual([{ op: 'insert_at_end', markdown: 'Agenda first' }]);
  });

  it('inside a paragraph wrapped across lines, is kept with the rest of that paragraph', () => {
    const doc = new Y.Doc();
    prose.applyMarkdownToFragment(
      prose.getProseFragment(doc),
      '## Meeting notes\n\n- Pontoon lights are out at Saltmarsh\n',
    );
    prose.ensureBlockIds(doc);
    const outline = prose.readOutline(doc);
    const heading = outline.find((e) => e.text === 'Meeting notes')?.id;
    const ctx = { notesHeadingId: heading, outline, speech: ['lights'], authorId: NOTES_AUTHOR_ID };
    for (const markdown of [
      'Pontoon lights are out at Saltmarsh\nuntil the new cable arrives',
      'The shed is locked\nPontoon lights are out at Saltmarsh',
      '- Pontoon lights are out at Saltmarsh\nuntil the new cable arrives',
    ]) {
      const edits = [{ op: 'insert_at_end' as const, markdown }];
      expect(dedupeNotesEdits(edits, ctx).edits).toEqual(edits);
    }
    // CONTROL: a bullet followed by a sibling that has notes of its own is
    // still a leaf, and still a repeat.
    const res = dedupeNotesEdits(
      [
        {
          op: 'insert_at_end',
          markdown:
            '- Pontoon lights are out at Saltmarsh\n- Shed\n  - Spare bulbs are in the shed',
        },
      ],
      ctx,
    );
    expect(res.alreadyWritten).toBe(1);
  });

  it("a person's own bullet is never deleted by a move", () => {
    const doc = new Y.Doc();
    prose.applyMarkdownToFragment(
      prose.getProseFragment(doc),
      '## Meeting notes\n\n- Pontoon lights are out at Saltmarsh\n\n### Lights\n\n- Spare bulbs are in the shed\n',
    );
    prose.ensureBlockIds(doc);
    const outline = prose.readOutline(doc);
    const heading = outline.find((e) => e.text === 'Meeting notes')?.id;
    const lights = outline.find((e) => e.text === 'Lights')?.id as string;
    const res = dedupeNotesEdits(
      [
        {
          op: 'insert_under_heading',
          headingId: lights,
          markdown: '- Pontoon lights are out at Saltmarsh',
        },
      ],
      { notesHeadingId: heading, outline, speech: ['lights'], authorId: NOTES_AUTHOR_ID },
    );
    expect(res.edits).toEqual([]);
    expect(res.alreadyWritten).toBe(1);
  });

  it('said again by a later recording continuing the section, is that meeting’s own note', () => {
    const doc = new Y.Doc();
    prose.applyMarkdownToFragment(
      prose.getProseFragment(doc),
      '## Meeting notes\n\n- Pontoon lights are out at Saltmarsh\n',
    );
    prose.ensureBlockIds(doc);
    const outline = prose.readOutline(doc);
    const heading = outline.find((e) => e.text === 'Meeting notes')?.id;
    const earlier = outline.find((e) => e.kind === 'listItem')?.id as string;
    const edits = [
      { op: 'insert_at_end' as const, markdown: '- Pontoon lights are out at Saltmarsh' },
    ];
    const ctx = { notesHeadingId: heading, outline, speech: ['lights'], authorId: NOTES_AUTHOR_ID };
    expect(dedupeNotesEdits(edits, { ...ctx, prior: new Set([earlier]) }).edits).toEqual(edits);
    // CONTROL: the same note written earlier by THIS meeting is a repeat.
    expect(dedupeNotesEdits(edits, ctx).alreadyWritten).toBe(1);
  });
});

describe('a fenced code block inside a note', () => {
  it('is carried whole: a heading-like or bullet-like line in it is neither', () => {
    const doc = new Y.Doc();
    prose.applyMarkdownToFragment(
      prose.getProseFragment(doc),
      '## Meeting notes\n\n### Crew rota\n\n- Rota changes every Monday\n',
    );
    prose.ensureBlockIds(doc);
    const outline = prose.readOutline(doc);
    const heading = outline.find((e) => e.text === 'Meeting notes')?.id;
    // A new topic opens, so the edit is rebuilt rather than passed through —
    // the path that would split the fence at `### Crew rota`.
    const markdown =
      '### Slipway script\n\n- Winch check runs nightly\n\n```sh\n### Crew rota\n- Rota changes every Monday\n```';
    const res = dedupeNotesEdits([{ op: 'insert_at_end', markdown }], {
      notesHeadingId: heading,
      outline,
      speech: ['the winch check'],
      authorId: NOTES_AUTHOR_ID,
    });
    expect(res.edits).toEqual([{ op: 'insert_at_end', markdown }]);
    expect(res.alreadyWritten).toBe(0);
  });
});

describe('a replace the guard turns into an add', () => {
  it('leaves one copy of each note when the old note was restated in the same batch', async () => {
    const h = createNotesTickHarness({
      compose: (input, tick) =>
        tick === 1
          ? addNotes(input, '- Harbour crane inspection is overdue by a week')
          : [
              {
                op: 'insert_at_end',
                markdown: '### Crane\n\n- Harbour crane inspection is overdue by a week',
              },
              {
                op: 'replace_block',
                blockId: idOf(input, 'crane inspection'),
                markdown: '- Ferry fares to Riverbend rise in April',
              },
            ],
    });
    await h.speak('the harbour crane inspection is overdue by a week');
    await h.speak('and ferry fares to Riverbend rise in April');
    const notes = h.notes();
    expect(count(notes, 'crane inspection is overdue')).toBe(1);
    expect(count(notes, 'Ferry fares to Riverbend')).toBe(1);
  });

  it('leaves one copy when the replacement is a note the section already has', async () => {
    const h = createNotesTickHarness({
      compose: (input, tick) =>
        tick === 1
          ? addNotes(
              input,
              '- Harbour crane inspection is overdue by a week\n- Ferry fares to Riverbend rise in April',
            )
          : [
              {
                op: 'replace_block',
                blockId: idOf(input, 'crane inspection'),
                markdown: '- Ferry fares to Riverbend rise in April',
              },
            ],
    });
    await h.speak('the crane inspection is overdue and ferry fares rise in April');
    await h.speak('ferry fares again');
    const notes = h.notes();
    expect(count(notes, 'crane inspection is overdue')).toBe(1);
    expect(count(notes, 'Ferry fares to Riverbend')).toBe(1);
  });
});

describe('a replace of a bullet written with no list marker', () => {
  it('that the guard keeps as an add, lands as a bullet rather than a bare line', async () => {
    const h = createNotesTickHarness({
      compose: (input, tick) =>
        tick === 1
          ? addNotes(input, '- Harbour crane inspection is overdue by a week')
          : [
              {
                op: 'replace_block',
                blockId: idOf(input, 'crane inspection'),
                markdown: 'Ferry fares to Riverbend rise in April',
              },
            ],
    });
    await h.speak('the harbour crane inspection is overdue by a week');
    await h.speak('ferry fares to Riverbend rise in April');
    expect(h.notes()).toContain('- Ferry fares to Riverbend rise in April');
    expect(h.notes()).toContain('- Harbour crane inspection is overdue by a week');
  });
});

describe('a Decision label', () => {
  const script = (said: string) =>
    createNotesTickHarness({
      compose: (input) => addNotes(input, '- **Decision:** Group small slipway jobs together'),
    }).speak(said);

  it('is removed when the speech only describes a habit', async () => {
    const snap = await script('sometimes I group the small slipway jobs together');
    expect(snap.notes).toContain('Group small slipway jobs together');
    expect(snap.notes).not.toContain('Decision');
  });

  it('stays when the speech decides — the control on the cue list', async () => {
    const snap = await script("let's group the small slipway jobs together from now on");
    expect(snap.notes).toContain('**Decision:** Group small slipway jobs together');
  });

  it('is judged note by note: a decision beside it licenses only its own note', async () => {
    const snap = await createNotesTickHarness({
      compose: (input) =>
        addNotes(
          input,
          '- **Decision:** Ferry leaves at seven\n- **Decision:** Group small slipway jobs together',
        ),
    }).speak('we decided the ferry leaves at seven; sometimes I group the small slipway jobs');
    expect(snap.notes).toContain('**Decision:** Ferry leaves at seven');
    expect(snap.notes).not.toContain('**Decision:** Group small');
    expect(snap.notes).toContain('Group small slipway jobs together');
  });
});

describe('a lead bullet rewritten by the note-taker', () => {
  it('keeps the notes nested under it, the main problem among them', async () => {
    const h = createNotesTickHarness({
      compose: (input, tick) =>
        tick === 1
          ? addNotes(
              input,
              '- Harbour queue\n  - Crew cannot tell which items matter before opening them',
            )
          : [
              {
                op: 'replace_block',
                blockId: idOf(input, 'Harbour queue'),
                markdown: '- **Question:** How should the harbour queue show what is in it?',
              },
            ],
    });
    await h.speak('the crew cannot tell which items matter before opening them');
    await h.speak('so how should the queue show what is in it');
    const notes = h.notes();
    expect(notes).toContain('How should the harbour queue show what is in it?');
    expect(notes).toContain('Crew cannot tell which items matter before opening them');
  });
});

describe("the editor's trailing blank line", () => {
  it('is never left stranded between the topics a meeting opens', async () => {
    const h = createNotesTickHarness({
      compose: (input, tick) => {
        // What the browser's TrailingNode does before every tick.
        const fragment = prose.getProseFragment(h.ydoc);
        const last = fragment.get(fragment.length - 1);
        if (!(last instanceof Y.XmlElement && last.nodeName === 'paragraph' && last.length === 0)) {
          h.ydoc.transact(
            () => fragment.insert(fragment.length, [new Y.XmlElement('paragraph')]),
            'browser',
          );
        }
        return addNotes(input, `### Topic ${tick}\n\n- Point ${tick} about the pier`);
      },
    });
    for (let i = 0; i < 4; i++) await h.speak(`point ${i + 1} about the pier`);
    const blocks = prose.getProseFragment(h.ydoc).toArray() as Y.XmlElement[];
    const blanks = blocks
      .slice(0, -1)
      .filter((el) => el.nodeName === 'paragraph' && el.length === 0);
    expect(blanks).toHaveLength(0);
  });
});
