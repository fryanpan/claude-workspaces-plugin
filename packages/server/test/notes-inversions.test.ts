/**
 * A note that says the opposite of what was said is found, and quoted beside
 * the sentence it came from; faithful notes are left alone.
 *
 * The done-when this file holds: a fixture with two planted inversions flags
 * both, a clean fixture flags none. Driven through `invertedNotes` and then
 * through the stop-time report, the record and the review item, because the
 * record is where a reader meets the finding.
 *
 * All speech and notes are invented. The repo is public.
 */

import { describe, expect, it } from 'bun:test';
import { invertedNotes } from '../src/notes-inversions.ts';
import { buildNotesQualityReport, notesQualityLogLine } from '../src/notes-quality-report.ts';
import { buildNotesQualityReview } from '../src/notes-quality-review.ts';
import { notesQualityRecord } from '../src/notes-quality-store.ts';
import { verdictOf } from '../src/notes-quality-verdict.ts';

const TRANSCRIPT = [
  { text: 'The problem is the Saltmarsh drains overflow at every spring tide.' },
  { text: 'We repave the Riverbend high street this summer.' },
  { text: 'Who can reach the pumping station when the Harborlight gate is locked?' },
  { text: 'Alice sends the drain survey to Bob by Friday.' },
];

const CLEAN = [
  '## Meeting notes',
  '### Saltmarsh flooding',
  '- Problem: the Saltmarsh drains overflow at every spring tide',
  '- **Question:** who can reach the pumping station when the Harborlight gate is locked?',
  '### Riverbend repairs',
  '- Repave the Riverbend high street this summer',
  '- Alice sends the drain survey to Bob by Friday',
].join('\n');

/** The clean notes with two lines turned round: a problem written as a
 *  benefit, and "repave" written as "reassess". */
const PLANTED = CLEAN.replace(
  '- Problem: the Saltmarsh drains overflow at every spring tide',
  '- Benefit: the Saltmarsh drains overflow at every spring tide',
).replace(
  '- Repave the Riverbend high street this summer',
  '- Reassess the Riverbend high street this summer',
);

describe('invertedNotes', () => {
  it('flags both planted inversions, each with the sentence it came from', () => {
    const found = invertedNotes(PLANTED, TRANSCRIPT);
    expect(found.map((f) => f.kind).sort()).toEqual(['problem-as-benefit', 'verb-swap']);
    const swap = found.find((f) => f.kind === 'verb-swap');
    expect(swap?.source).toBe('We repave the Riverbend high street this summer.');
    expect(swap?.detail).toBe('"repave" became "reassess"');
    expect(found.find((f) => f.kind === 'problem-as-benefit')?.source).toContain('The problem is');
  });

  it('flags nothing in notes that keep the meaning', () => {
    expect(invertedNotes(CLEAN, TRANSCRIPT)).toEqual([]);
  });

  it('reads a synonym in the same class as a paraphrase, not a swap', () => {
    const notes = '- Resurface the Riverbend high street this summer';
    expect(invertedNotes(notes, TRANSCRIPT)).toEqual([]);
  });

  it('flags a question written as a settled claim', () => {
    const notes = '- Bob reaches the pumping station while the Harborlight gate is locked';
    expect(invertedNotes(notes, TRANSCRIPT).map((f) => f.kind)).toEqual(['question-as-claim']);
  });

  it('says nothing when another sentence supports the note', () => {
    const later = [...TRANSCRIPT, { text: 'Actually the Saltmarsh drains overflow is a benefit.' }];
    const notes = '- Benefit: the Saltmarsh drains overflow at every spring tide';
    expect(invertedNotes(notes, later)).toEqual([]);
  });

  it('says nothing about a note no sentence is about', () => {
    expect(invertedNotes('- Improve the ferry signage', TRANSCRIPT)).toEqual([]);
  });

  it('reads a note asking for a fix as a remedy, not a problem turned into a benefit', () => {
    const notes = '- Onboarding docs need to be better';
    expect(invertedNotes(notes, [{ text: 'The onboarding docs are confusing.' }])).toEqual([]);
    expect(invertedNotes(notes, [{ text: 'The onboarding docs are a problem.' }])).toEqual([]);
  });

  it('reads an everyday verb as a paraphrase, not a swap', () => {
    const said = [{ text: 'Bob will raise the pricing issue.' }];
    expect(invertedNotes('- Bob to add pricing to the agenda', said)).toEqual([]);
  });

  it('reads a question that only asks for agreement as a statement', () => {
    expect(invertedNotes('- Launch Friday', [{ text: 'We launch Friday, right?' }])).toEqual([]);
    expect(invertedNotes('- Launch Friday', [{ text: 'Do we launch Friday?' }])).toHaveLength(1);
  });
});

describe('the quality record', () => {
  it('records the planted inversions without flagging them, and quotes the source line', () => {
    const report = buildNotesQualityReport({ notes: PLANTED, transcript: TRANSCRIPT });
    expect(report.inversions).toHaveLength(2);
    // Counted, never a flag: a flag files a review item, and the rules are
    // not yet scored against real meetings.
    expect(report.flags).toEqual([]);
    expect(verdictOf(report).counts).toEqual({});
    expect(notesQualityRecord('d-1', 'm-1', report, 1).invertedNotes).toBe(2);
    expect(notesQualityLogLine(report)).toContain('2 inverted notes');
    const review = JSON.stringify(
      buildNotesQualityReview({ workspaceId: 'w-1', docId: 'd-1', report }),
    );
    expect(review).toContain('We repave the Riverbend high street this summer.');
    expect(review).toContain('Reassess the Riverbend high street this summer');
  });

  it('flags none over the clean notes', () => {
    const report = buildNotesQualityReport({ notes: CLEAN, transcript: TRANSCRIPT });
    expect(report.inversions).toEqual([]);
    expect(report.flags).toEqual([]);
    expect(notesQualityRecord('d-1', 'm-1', report, 1).invertedNotes).toBe(0);
  });
});
