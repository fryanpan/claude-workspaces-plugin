/**
 * A topic is headed once whatever level the model opens it at again.
 *
 * Replayed meetings left a topic headed `##` and again `###` a few ticks
 * later, often straight under the first. The dedupe matched a repeat only at
 * the same level, so both stood, and a reader saw one topic twice.
 *
 * All fixtures are synthetic. The repo is public.
 */

import { describe, expect, it } from 'bun:test';
import { addNotes, createNotesTickHarness } from './notes-tick-harness.ts';

const headingLines = (notes: string, topic: string): number =>
  notes.split('\n').filter((l) => /^#{1,6}\s/.test(l) && l.includes(topic)).length;

describe('a topic heading opened again at another level', () => {
  it('is reused, and its notes join the first', async () => {
    const h = createNotesTickHarness({
      compose: (input, tick) => {
        if (tick === 1) return addNotes(input, '### Saltmarsh ferry\n\n- Two sailings leave daily');
        if (tick === 2) return addNotes(input, '### Crew rota\n\n- Rota changes every Monday');
        return [
          {
            op: 'insert_at_end',
            markdown: '#### Saltmarsh ferry\n\n- Winter sailings stop at six',
          },
        ];
      },
    });
    await h.speak('two sailings leave daily');
    await h.speak('the rota changes every Monday');
    await h.speak('winter sailings stop at six');
    const notes = h.notes();
    expect(headingLines(notes, 'Saltmarsh ferry')).toBe(1);
    expect(notes).toContain('Winter sailings stop at six');
    expect(notes.indexOf('Winter sailings')).toBeLessThan(notes.indexOf('### Crew rota'));
    expect(h.errors).toEqual([]);
  });

  it('opened twice in one batch at two levels, is one heading', async () => {
    const h = createNotesTickHarness({
      compose: (input) =>
        addNotes(
          input,
          '### Riverbend slipway\n\n- Costs rose\n\n#### Riverbend slipway\n\n- Crane booked',
        ),
    });
    await h.speak('the slipway costs rose and the crane is booked');
    const notes = h.notes();
    expect(headingLines(notes, 'Riverbend slipway')).toBe(1);
    expect(notes).toContain('Crane booked');
  });
});
