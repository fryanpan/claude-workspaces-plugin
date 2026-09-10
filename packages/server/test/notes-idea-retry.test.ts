/**
 * A meeting whose note-taker drops something says so, and asks again.
 *
 * WHY THIS IS NOT COVERED BY `notes-turn-coverage.test.ts`. That audit asks
 * whether every settled turn reached a COMPOSE. This asks the question a
 * reader of the notes asks — whether anything came of it — which is the one
 * that was going unanswered: a minute of conversation reached the composer,
 * the composer wrote nothing, and the meeting reported `turnsLost: 0`.
 *
 * All speech here is synthetic. The repo is public.
 */

import { describe, expect, it } from 'bun:test';
import type { prose } from '@claude-workspaces/core';
import type { NotesComposeInput } from '../src/meeting-notes.ts';
import { addNotes, createNotesTickHarness } from './notes-tick-harness.ts';

const SAID = 'The export dialog forgets the date range people picked.';
const NOTE = '- The export dialog loses the chosen date range.';
const LATER = 'Billing also wants a currency column in the invoice CSV.';

describe('an idea that reached no note', () => {
  it('is put back into the next tick, and counted lost when it is missed twice', async () => {
    const seen: string[][] = [];
    const h = createNotesTickHarness({
      compose: (input: NotesComposeInput): prose.BlockEdit[] => {
        seen.push([...(input.missed ?? []), ...input.tick.turns].map((t) => t.text));
        // A note-taker that writes nothing at all. This is the behaviour the
        // metric exists to see; the old one could not tell it from a healthy
        // meeting.
        return addNotes(input, '');
      },
    });
    await h.speak(SAID);
    await h.speak(LATER);
    await h.speak('And that is everything for today, thanks all.');
    await h.end();

    // The retry: the second tick's speech carries the first tick's sentence
    // again, ahead of the words that were actually just said.
    expect(seen[1]).toEqual([SAID, LATER]);
    // And only once. A third tick re-sending it would be an unbounded queue.
    expect(seen[2]?.includes(SAID)).toBe(false);

    const summary = h.summary();
    expect(summary?.turnsLost).toBe(0);
    expect(summary?.ideas.seen).toBeGreaterThan(0);
    expect(summary?.ideas.lost).toBe(summary?.ideas.seen);
    expect(summary?.ideas.carried).toBe(0);
    expect(summary?.ideas.retried).toBeGreaterThan(0);
  });

  it('is counted carried when the retry lands, and is not re-sent again', async () => {
    const seen: string[][] = [];
    let ticks = 0;
    const h = createNotesTickHarness({
      compose: (input: NotesComposeInput): prose.BlockEdit[] => {
        seen.push([...(input.missed ?? []), ...input.tick.turns].map((t) => t.text));
        ticks++;
        // Nothing on the first tick; on the second, a note for everything it
        // was handed — which is the retried sentence plus what was just said.
        return addNotes(
          input,
          ticks === 1
            ? ''
            : [...(input.missed ?? []), ...input.tick.turns]
                .map((t) => `- ${t.text.replace(/\.$/, '')}, noted.`)
                .join('\n'),
        );
      },
    });
    await h.speak(SAID);
    await h.speak(LATER);
    await h.speak('Right, that is all.');
    await h.end();

    expect(seen[1]).toEqual([SAID, LATER]);
    expect(seen[2]?.includes(SAID)).toBe(false);
    const summary = h.summary();
    expect(summary?.ideas.retried).toBe(1);
    expect(summary?.ideas.lost).toBe(0);
    expect(summary?.ideas.carried).toBe(summary?.ideas.seen);
  });

  it('counts nothing lost when the first tick already wrote the note', async () => {
    // The control: the same script through a note-taker that behaves. Without
    // it a metric that always reported total loss would pass the two cases
    // above.
    const seen: string[][] = [];
    const h = createNotesTickHarness({
      compose: (input: NotesComposeInput): prose.BlockEdit[] => {
        seen.push([...(input.missed ?? []), ...input.tick.turns].map((t) => t.text));
        return addNotes(input, input.tick.turns.some((t) => t.text === SAID) ? NOTE : '');
      },
    });
    await h.speak(SAID);
    await h.speak('Right, that is all.');
    await h.end();

    expect(seen[1]?.includes(SAID)).toBe(false);
    const summary = h.summary();
    expect(summary?.ideas.lost).toBe(0);
    expect(summary?.ideas.retried).toBe(0);
    expect(summary?.ideas.carried).toBe(summary?.ideas.seen);
  });
});

/**
 * A compose that never lands cannot have answered anything.
 *
 * The ledger settles the previous tick's ideas BEFORE the compose that is
 * meant to answer them, because the retries have to be in that compose's
 * input. So when the compose then throws, the settle's verdicts describe a
 * tick that produced no notes at all, and letting them stand spends the
 * idea's one retry on nothing — the tick after it reads the same miss as a
 * SECOND miss and writes the idea off.
 */
describe('an idea whose retry rode a compose that failed', () => {
  it('gets a real second look instead of being written off', async () => {
    const seen: string[][] = [];
    let ticks = 0;
    const h = createNotesTickHarness({
      compose: (input: NotesComposeInput): prose.BlockEdit[] => {
        seen.push([...(input.missed ?? []), ...input.tick.turns].map((t) => t.text));
        ticks++;
        // Tick 1 writes nothing, so the sentence is owed a retry. Tick 2 is
        // handed that retry and THROWS, so its words carry forward. Tick 3
        // is the first compose that can actually answer, and it does.
        if (ticks === 2) throw new Error('notes composer failed');
        if (ticks < 3) return addNotes(input, '');
        return addNotes(
          input,
          [...(input.missed ?? []), ...input.tick.turns]
            .map((t) => `- ${t.text.replace(/\.$/, '')}, noted.`)
            .join('\n'),
        );
      },
    });
    await h.speak(SAID);
    await h.speak(LATER);
    await h.speak('Right, that is all.');
    await h.end();

    // The failed tick's words carry, so the sentence is in front of tick 3.
    expect(seen[2]?.includes(SAID)).toBe(true);
    const summary = h.summary();
    // The note it eventually got is the whole point: nothing is lost, and
    // the retry that never reached a written note was not charged to it.
    expect(summary?.ideas.lost).toBe(0);
    expect(summary?.ideas.carried).toBe(summary?.ideas.seen);
  });
});
