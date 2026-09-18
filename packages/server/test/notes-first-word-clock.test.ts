/**
 * WHEN THE WORDS ON A TICK WERE SAID — the clock the ten-second goal is
 * measured on, and the one the timing row did not have.
 *
 * A turn is one person talking until they stop, so a turn can run for a
 * minute and reach the notes as four fragments. Every spoken clock the row
 * kept was stamped on the turn's FIRST frame, so the fourth fragment was
 * charged with the whole minute: a note reported thirteen seconds late for
 * words spoken seven seconds ago, whose opening was already in the doc. That
 * is the 12s median wait the board task was sent to explain.
 *
 * So the row now carries `firstSpokenAt` beside `spokenAt`: the earliest word
 * THIS tick carries, dated from `NotesTurn.fromWord` and the per-frame word
 * counts the session keeps. The old field stays — it is the age of the oldest
 * turn a tick names, which is a different and still-readable number.
 *
 * Every timer is the injected scheduler and every instant is the injected
 * clock: nothing here waits (testing-standards.md, 2 and 3).
 *
 * All speech here is invented. The repo is public.
 */

import { describe, expect, it } from 'bun:test';
import type { prose } from '@claude-workspaces/core';
import {
  type NotesComposeInput,
  type NotesTurn,
  type TickScheduler,
  beginNotesSession,
} from '../src/meeting-notes.ts';
import { type NotesTickTiming, createNotesTimingLog } from '../src/notes-timing.ts';

/** Timers with a clock behind them, advanced by hand. */
class Clock implements TickScheduler {
  now = 0;
  private timers = new Map<number, { at: number; fn: () => void }>();
  private n = 0;
  set(fn: () => void, ms: number): unknown {
    this.n++;
    this.timers.set(this.n, { at: this.now + ms, fn });
    return this.n;
  }
  clear(handle: unknown): void {
    this.timers.delete(handle as number);
  }
  advanceTo(t: number): void {
    for (;;) {
      let next: { handle: number; at: number; fn: () => void } | undefined;
      for (const [handle, timer] of this.timers) {
        if (timer.at > t) continue;
        if (next === undefined || timer.at < next.at) next = { handle, ...timer };
      }
      if (next === undefined) break;
      this.timers.delete(next.handle);
      this.now = next.at;
      next.fn();
    }
    this.now = Math.max(this.now, t);
  }
}

const CADENCE_MS = 6_000;

interface Run {
  rows: readonly NotesTickTiming[];
  composed: readonly NotesTurn[][];
}

/**
 * One person talking for `turnMs` without finishing a sentence, on a mock of
 * an engine that finalizes words inside a turn — which both shipped engines
 * do. Frames arrive every `frameMs`; each one's `spokenAt` dates its own last
 * word, exactly as the relay stamps it.
 */
async function oneLongTurn(opts: {
  turnMs: number;
  frameMs: number;
  wordMs: number;
}): Promise<Run> {
  const clock = new Clock();
  const timing = createNotesTimingLog();
  const composed: NotesTurn[][] = [];
  const session = beginNotesSession(
    {
      composer: {
        name: 'scripted',
        compose(input: NotesComposeInput): Promise<readonly prose.BlockEdit[]> {
          composed.push([...input.tick.turns]);
          // A real bullet, because the row only carries a latency for a tick
          // whose batch put words in the doc.
          return Promise.resolve([
            { op: 'insert_at_end', markdown: `- note for tick ${input.tick.tick}` },
          ]);
        },
      },
      cadenceMs: CADENCE_MS,
      schedule: clock,
      now: () => clock.now,
      openTiming: () => timing,
      // A batch that landed and put words in: the row only carries a latency
      // for a tick the doc took, and an empty edit list is not that.
      onNotes: () => true,
    },
    { docId: 'd-harbour', meetingId: 'm-1' },
  );

  const words: string[] = [];
  for (let at = opts.frameMs; at < opts.turnMs; at += opts.frameMs) {
    clock.advanceTo(at);
    while (words.length < Math.floor(at / opts.wordMs)) words.push(`w${words.length}`);
    if (words.length === 0) continue;
    session.onTurn(
      {
        turn: 0,
        text: words.join(' '),
        final: false,
        // The engine's own already-final prefix — one word behind the live
        // tail, which is what a streaming finalizer looks like.
        settledText: words.slice(0, -1).join(' '),
      },
      // The instant this frame's LAST word was spoken.
      clock.now,
    );
  }
  clock.advanceTo(opts.turnMs);
  while (words.length < Math.floor(opts.turnMs / opts.wordMs)) words.push(`w${words.length}`);
  session.onTurn({ turn: 0, text: `${words.join(' ')}.`, final: true }, clock.now);
  clock.advanceTo(clock.now + 4 * CADENCE_MS);
  await session.end();
  return { rows: timing.rows(), composed };
}

describe('the clock a tick’s own words are dated by', () => {
  it('dates a ceiling tick’s tail from the words it carries, not from the turn’s opening', async () => {
    // Fourteen seconds of one person talking, which is an ordinary turn in a
    // meeting where nobody pauses — and more than two ceilings.
    const run = await oneLongTurn({ turnMs: 14_000, frameMs: 500, wordMs: 350 });
    // Every tick but the stop: the end tick fires after the drain's silence
    // and its wait is that silence, which is evidence about nothing.
    const during = run.rows.filter((r) => r.reason !== 'end' && r.firstSpokenAt !== null);
    // The control on the script: it really did take more than one tick, so
    // there IS a tail to date differently from the opening.
    expect(during.length).toBeGreaterThan(1);

    // The wait the task was sent to explain: from the words being spoken to
    // the tick that carries them firing. Measured on the two clocks the row
    // now holds, over the same ticks.
    const oldWaits = during.map((r) => r.startedAt - (r.spokenAt ?? 0));
    const newWaits = during.map((r) => r.startedAt - (r.firstSpokenAt ?? 0));
    // Read off the turn's opening, the last tick of a fourteen-second turn is
    // charged with the whole turn — two ceilings and more.
    expect(oldWaits.at(-1) ?? 0).toBeGreaterThan(CADENCE_MS * 2);
    // Read off its own words, no tick waits longer than one ceiling. That is
    // the ceiling doing exactly what it says, which the old clock hid.
    for (const wait of newWaits) expect(wait).toBeLessThanOrEqual(CADENCE_MS + 1_000);
  });

  it('the first tick of a turn reads the same on both clocks — there is no tail yet', async () => {
    const run = await oneLongTurn({ turnMs: 14_000, frameMs: 500, wordMs: 350 });
    const first = run.rows.find((r) => r.firstSpokenAt !== null) as NotesTickTiming;
    // Its words start at word zero of the turn, so the frame that dates them
    // is the turn's own first frame — which is what `spokenAt` already was.
    expect(first.firstSpokenAt).toBe(first.spokenAt);
  });

  it('a tail really is a tail: the ticker says which word of the turn it starts at', async () => {
    const run = await oneLongTurn({ turnMs: 14_000, frameMs: 500, wordMs: 350 });
    const tails = run.composed.flat().filter((t) => (t.fromWord ?? 0) > 0);
    expect(tails.length).toBeGreaterThan(0);
    // Every tail is marked as continuing a sentence already in the notes, and
    // starts after the words an earlier tick carried.
    for (const t of tails) expect(t.continued).toBe(true);
  });

  it('a caller with no audio clock still records nulls rather than guesses', async () => {
    const clock = new Clock();
    const timing = createNotesTimingLog();
    const session = beginNotesSession(
      {
        composer: { name: 'scripted', compose: () => Promise.resolve([]) },
        cadenceMs: CADENCE_MS,
        schedule: clock,
        now: () => clock.now,
        openTiming: () => timing,
        onNotes: () => true,
      },
      { docId: 'd-river', meetingId: 'm-1' },
    );
    session.onTurn({ turn: 0, text: 'we can move the survey', final: false });
    session.onTurn({ turn: 0, text: 'We can move the survey.', final: true });
    clock.advanceTo(clock.now + 4 * CADENCE_MS);
    await session.end();
    const rows = timing.rows();
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.firstSpokenAt).toBeNull();
      expect(r.firstSpokenToWrittenMs).toBeNull();
    }
  });
});
