/**
 * A note restated in fewer words is not written twice.
 *
 * Replayed meetings left pairs such as "X is one option, and Y is another"
 * followed by "Y is also an option": every word of the second already in the
 * first, so the second added nothing a reader did not have. The near-duplicate
 * check needed nearly all words shared both ways, and let it through.
 *
 * All fixtures are synthetic. The repo is public.
 */

import { describe, expect, it } from 'bun:test';
import { addNotes, createNotesTickHarness } from './notes-tick-harness.ts';

const count = (text: string, needle: string): number => text.split(needle).length - 1;

describe('a note whose every word the doc already carries', () => {
  const script = (second: string) =>
    createNotesTickHarness({
      compose: (input, tick) =>
        tick === 1
          ? addNotes(
              input,
              '### Saltmarsh slipway\n\n- A prebuilt crane is one option, and a hired crane with a driver is another',
            )
          : addNotes(input, `### Saltmarsh slipway\n\n${second}`),
    });

  it('is not written a second time in shorter words', async () => {
    const h = script('- A hired crane with a driver is also an option');
    await h.speak('a prebuilt crane is one option, a hired crane with a driver another');
    await h.speak('a hired crane with a driver is also an option');
    const notes = h.notes();
    expect(count(notes, 'hired crane')).toBe(1);
    expect(h.errors).toEqual([]);
  });

  it('CONTROL: a shorter note that adds a word is written', async () => {
    const h = script('- A hired crane with a driver costs less in winter');
    await h.speak('a prebuilt crane is one option, a hired crane with a driver another');
    await h.speak('a hired crane with a driver costs less in winter');
    expect(h.notes()).toContain('costs less in winter');
  });

  it('CONTROL: the same words said as their opposite are written', async () => {
    const h = script('- A hired crane with a driver is not an option');
    await h.speak('a prebuilt crane is one option, a hired crane with a driver another');
    await h.speak('a hired crane with a driver is not an option');
    expect(h.notes()).toContain('is not an option');
  });
});
