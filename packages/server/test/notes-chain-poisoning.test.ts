/**
 * One thrown step must not end the note-taking for the rest of the meeting.
 *
 * Every write a meeting makes — each tick's compose, a rename, the engine's
 * late reattribution, a note-taker change line — is ordered behind one
 * promise, because the order between them is load-bearing: a rename has to
 * land after the compose that read the old name, not under it.
 *
 * A promise chain has a failure mode that a queue does not. If one step
 * REJECTS, every `chain.then(step)` appended after it skips its callback and
 * re-raises the same rejection. The chain is not slowed down or degraded; it
 * has stopped, permanently, and nothing says so:
 *
 * - no later tick composes, so the notes simply stop growing;
 * - no `notes_progress` frame reaches the browser, so the live transcript
 *   keeps every word it has and never gives one back;
 * - `end()` awaits the same chain, so the stop throws before the meeting can
 *   report its own coverage — and the one line a finished meeting leaves in
 *   the log is missing.
 *
 * The last of those is what makes this worth a test rather than a comment.
 * The evidence of the failure is an ABSENCE: a meeting that wrote one note
 * and then went quiet reads in the log exactly like a meeting nobody spoke
 * in. A production meeting was found in that state with nothing to
 * distinguish the two.
 *
 * `onRelabel` is the step these tests throw from because it is a real one: a
 * person tapping a speaker pill to name a voice mid-meeting puts it on the
 * chain, and `withServerNotesSinks` runs a caller's own sink after the doc's
 * without a guard around it.
 *
 * All fixtures are synthetic. The repo is public.
 */

import { describe, expect, it } from 'bun:test';
import { addNotes, createNotesTickHarness } from './notes-tick-harness.ts';

/** Short, because the failure this is about is a wait that never ends: on a
 *  chain that can be poisoned these cases hang rather than assert. */
const TICK_TIMEOUT_MS = 4_000;

describe('a throwing step does not stop the meeting', () => {
  it('the ticks behind a thrown rename still compose and still reach the doc', async () => {
    const h = createNotesTickHarness({
      tickTimeoutMs: TICK_TIMEOUT_MS,
      onRelabel: () => {
        throw new Error('the rename sink threw');
      },
      compose: (input, tick) => addNotes(input, `- note ${tick}`),
    });

    await h.speak('The first thing.');
    // Control: the notes really were being written before the throw.
    expect(h.notes()).toContain('note 1');

    h.nameSpeaker('A', 'the second voice');

    await h.speak('The second thing.');
    await h.speak('The third thing.');

    expect(h.notes()).toContain('note 2');
    expect(h.notes()).toContain('note 3');
  });

  it('the meeting still reports its own coverage when a step threw', async () => {
    const h = createNotesTickHarness({
      tickTimeoutMs: TICK_TIMEOUT_MS,
      onRelabel: () => {
        throw new Error('the rename sink threw');
      },
      compose: (input, tick) => addNotes(input, `- note ${tick}`),
    });

    await h.speak('The first thing.');
    h.nameSpeaker('A', 'the second voice');
    await h.speak('The second thing.');
    await h.end();

    const summary = h.summary();
    // The line whose absence was the only symptom in production.
    expect(summary).not.toBeNull();
    expect(summary?.turnsSettled).toBe(2);
    expect(summary?.turnsLost).toBe(0);
  });

  it('the throw is reported rather than swallowed', async () => {
    const h = createNotesTickHarness({
      tickTimeoutMs: TICK_TIMEOUT_MS,
      onRelabel: () => {
        throw new Error('the rename sink threw');
      },
      compose: (input, tick) => addNotes(input, `- note ${tick}`),
    });

    await h.speak('The first thing.');
    h.nameSpeaker('A', 'the second voice');
    await h.speak('The second thing.');
    await h.end();

    // A meeting that recovered silently would be the same bug one layer
    // down: nobody would know the rename never reached the notes.
    expect(h.errors.some((e) => e.includes('the rename sink threw'))).toBe(true);
  });

  it('a throwing error sink does not stop the meeting either', async () => {
    // The recovery callback runs a function the CALLER supplied. A throw out
    // of it rejects the chain exactly as the original step did, which would
    // rebuild this whole bug one layer down and leave the recovery looking
    // like the fix.
    const h = createNotesTickHarness({
      tickTimeoutMs: TICK_TIMEOUT_MS,
      errorSinkThrows: true,
      onRelabel: () => {
        throw new Error('the rename sink threw');
      },
      compose: (input, tick) => addNotes(input, `- note ${tick}`),
    });

    await h.speak('The first thing.');
    expect(h.notes()).toContain('note 1');

    h.nameSpeaker('A', 'the second voice');

    await h.speak('The second thing.');
    await h.end();

    expect(h.notes()).toContain('note 2');
    expect(h.summary()).not.toBeNull();
  });

  it('a throwing progress sink does not write the same words up twice', async () => {
    // The `written` frame is announced from INSIDE the compose's own
    // try/catch, after the doc has taken the edits. A throw out of the sink
    // landed in the handler for a compose that FAILED, which puts a tick's
    // turns back in the carry — so the next tick composed words that were
    // already in the notes and wrote them a second time.
    const seen: number[][] = [];
    const h = createNotesTickHarness({
      tickTimeoutMs: TICK_TIMEOUT_MS,
      onLifecycle: (event) => {
        if (event.phase === 'written') throw new Error('the progress sink threw');
      },
      compose: (input, tick) => {
        seen.push(input.tick.turns.map((t) => t.turn));
        return addNotes(input, `- note ${tick}`);
      },
    });

    await h.speak('The first thing.');
    await h.speak('The second thing.');

    // The second tick's compose saw the second turn and only that one.
    expect(seen).toEqual([[0], [1]]);
    expect(h.errors.some((e) => e.includes('the progress sink threw'))).toBe(true);
  });
});
