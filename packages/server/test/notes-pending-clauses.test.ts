/**
 * A note's trailing "not finished yet" report is taken off, and a note that
 * is only that report is dropped. All fixtures are synthetic.
 */

import { describe, expect, it } from 'bun:test';
import { stripPendingClauses, withoutPendingClause } from '../src/notes-pending-clauses.ts';

describe('withoutPendingClause', () => {
  it.each([
    [
      '- [@Alice](speaker:A) says the crane is booked; her point is unfinished',
      '- [@Alice](speaker:A) says the crane is booked',
    ],
    [
      '- Bob asks who owns the tide tables. Speaker has not finished.',
      '- Bob asks who owns the tide tables.',
    ],
    [
      '- Alice describes the Riverbend survey (unfinished)',
      '- Alice describes the Riverbend survey',
    ],
    [
      '- Bob starts to say the priority for the group, but the point is not finished yet.',
      '- Bob starts to say the priority for the group.',
    ],
    ['- Alice wants a second crane — still being made', '- Alice wants a second crane'],
  ])('takes the report off %s', (line, want) => {
    expect(withoutPendingClause(line)).toBe(want);
  });

  it('drops a note that is only the report', () => {
    expect(withoutPendingClause('- [@Bob](speaker:B) point still being made')).toBeNull();
  });

  it('leaves a note about something unfinished alone when that IS the point', () => {
    // Control: the slipway is unfinished, and that is what was said.
    const line =
      '- The Saltmarsh slipway is unfinished and opens in May, because the crane was late';
    expect(withoutPendingClause(line)).toBe(line);
    expect(withoutPendingClause('- Harborlight ferry runs hourly')).toBe(
      '- Harborlight ferry runs hourly',
    );
    // A thing that IS incomplete is a point, not a report on the speech.
    for (const kept of [
      '- The Riverbend survey is incomplete',
      '- Bob checked the tides; the survey is incomplete',
    ]) {
      expect(withoutPendingClause(kept)).toBe(kept);
    }
  });
});

describe('stripPendingClauses', () => {
  it('rewrites notes, keeps headings, and drops an edit left with nothing', () => {
    const { edits, stripped } = stripPendingClauses([
      {
        op: 'insert_at_end',
        markdown: '### Crane booking\n\n- Alice booked the crane; not finished yet',
      },
      { op: 'insert_under_heading', headingId: 'h1', markdown: '- Bob is still speaking' },
      { op: 'delete_block', blockId: 'b2' },
    ]);
    expect(stripped).toBe(2);
    expect(edits).toEqual([
      { op: 'insert_at_end', markdown: '### Crane booking\n\n- Alice booked the crane' },
      { op: 'delete_block', blockId: 'b2' },
    ]);
  });
});
