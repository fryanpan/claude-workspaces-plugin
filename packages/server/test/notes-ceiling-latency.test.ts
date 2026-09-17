/**
 * HOW LONG A SENTENCE WAITS WHEN NOBODY EVER PAUSES — the ceiling's job,
 * measured as a wait in milliseconds rather than asserted as a constant.
 *
 * WHY THIS FILE EXISTS BESIDE THE ONE THAT PINS THE NUMBER.
 * `meeting-notes.test.ts` asserts `DEFAULT_NOTES_CADENCE_MS === 6_000` and
 * that a session with no overrides arms a timer at that delay. Both pass on
 * a system that never writes a note: they read the constant and the arming,
 * not the wait. The board's goal is a wait — Bryan sees the note for what he
 * just said within ten seconds — and the measured failure was that in a real
 * conversation nobody is silent for four seconds, so the quiet tick almost
 * never fires and every note pays the ceiling in full. That is a statement
 * about a SEQUENCE of frames on a clock, so it is tested on a clock.
 *
 * THE CLOCK IS VIRTUAL AND NOTHING HERE SLEEPS. `VirtualClock` is a
 * `TickScheduler` that holds a `now` and jumps it to the next due timer, so
 * a minute of conversation costs microseconds and the numbers this file
 * asserts are exact rather than machine-dependent (testing-standards.md, 2
 * and 3: poll-or-drive, never a fixed sleep, and never a wall-clock
 * assertion). `CW_TEST_TIMING_SCALE` scales the DOC's debounces and touches
 * nothing here — no timer in this file is a real one.
 *
 * WHAT MAKES IT FAIL WHEN THE CEILING MOVES. The bound is
 * `TICKER_SHARE_OF_GOAL_MS`, which comes from the board's ten seconds minus
 * what the model takes, NOT from `DEFAULT_NOTES_CADENCE_MS` — a bound read
 * off the constant under test moves with it and catches nothing. The last
 * case is the control: the same speech under the fifteen-second ceiling this
 * replaced, which blows the bound. So "someone put the ceiling back" fails
 * here as a late note, with the number, rather than as a diff nobody read.
 *
 * All speech here is invented. The repo is public.
 */

import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_NOTES_CADENCE_MS,
  DEFAULT_NOTES_ENDPOINT_CONFIRM_MS,
  DEFAULT_NOTES_QUIET_MS,
  type NotesTick,
  type TickScheduler,
  createPauseTicker,
} from '../src/pause-ticker.ts';

/**
 * A scheduler with a clock behind it: timers carry the instant they are due,
 * and `advanceTo` runs them in that order, moving `now` to each one as it
 * fires.
 *
 * Moving `now` BEFORE the callback is what makes a wait measurable: a tick's
 * own handler reads the clock and gets the instant the tick fired, not the
 * instant the test asked to advance to. Re-arming inside a callback works for
 * the same reason — the new timer is due from the instant it was set, which
 * is how the ceiling behaves when a tick leaves unwritten words behind.
 */
class VirtualClock implements TickScheduler {
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
  /** Run every timer due at or before `t`, in due order, then land on `t`. */
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

/**
 * The ticker's share of the board's ten seconds.
 *
 * The goal is ten seconds from the words settling to the note being in the
 * doc, and the ticker owns only the first leg of that: after it fires, the
 * compose call and the doc write still have to happen. Those were measured on
 * the 15 September meeting at a 1.1s median and a 1.6s p90, worst 5.1s — so
 * eight seconds leaves the model its p90 and most of its tail. A ceiling of
 * six comes in under this with room; the fifteen it replaced cannot.
 */
const TICKER_SHARE_OF_GOAL_MS = 8_000;

/**
 * Conversation, not dictation: the next voice starts before the last one has
 * been quiet for a second.
 *
 * Every sentence takes `SENTENCE_MS` to say, and the next speaker's first
 * partial arrives `OVERLAP_MS` after the previous sentence settles — inside
 * `DEFAULT_NOTES_ENDPOINT_CONFIRM_MS`, so the endpoint window the settled
 * turn opened is closed by that partial and the four-second quiet clock is
 * pushed back before it can ever elapse. This is the meeting shape the
 * ceiling exists for, and the assertion below checks the script really is
 * that shape rather than trusting the arithmetic.
 */
const SENTENCE_MS = 2_000;
const OVERLAP_MS = 400;
/** Long enough to cross several ceilings, short enough to read in a failure. */
const CONVERSATION_MS = 90_000;

/** One sentence, and the instant it settled on the ticker's clock. */
interface Settled {
  turn: number;
  at: number;
}

interface Run {
  ticks: NotesTick[];
  /** The ticks that fired while people were still talking — the run's own
   *  subject. The drain below the loop lets the quiet clock elapse on
   *  purpose, and the pause tick that produces is not evidence about a
   *  conversation nobody paused in. */
  duringConversation: NotesTick[];
  /** Per sentence, how long it waited from settling to the tick carrying it.
   *  A sentence no tick ever carried is absent — `carried` counts them. */
  waits: number[];
  carried: number;
  settled: number;
}

/**
 * Talk continuously for `CONVERSATION_MS` under a given ceiling, and report
 * what every sentence waited.
 *
 * The ticker is driven exactly as the engine drives it — a partial, then the
 * settled sentence — and the clock is advanced to each frame's instant in
 * turn, so the timers the ticker arms fire between frames wherever they are
 * due, which is what a real stream does.
 */
function talkContinuously(cadenceMs: number | undefined): Run {
  const clock = new VirtualClock();
  const ticks: NotesTick[] = [];
  /** When each tick fired, by tick number — read off the clock inside the
   *  callback, which is the instant the ceiling elapsed. */
  const firedAt = new Map<number, number>();
  const ticker = createPauseTicker({
    quietMs: DEFAULT_NOTES_QUIET_MS,
    ...(cadenceMs === undefined ? {} : { cadenceMs }),
    endpointConfirmMs: DEFAULT_NOTES_ENDPOINT_CONFIRM_MS,
    schedule: clock,
    onTick: (t) => {
      ticks.push(t);
      firedAt.set(t.tick, clock.now);
    },
  });

  const settled: Settled[] = [];
  let turn = 0;
  // The first voice starts at zero; each sentence settles SENTENCE_MS later,
  // and the next one's first partial arrives OVERLAP_MS after that.
  for (let start = 0; start + SENTENCE_MS <= CONVERSATION_MS; start += SENTENCE_MS + OVERLAP_MS) {
    clock.advanceTo(start);
    ticker.onTurn({ turn, text: `partial words of sentence ${turn}`, final: false });
    clock.advanceTo(start + SENTENCE_MS);
    ticker.onTurn({ turn, text: `Sentence ${turn} is a complete thought.`, final: true });
    settled.push({ turn, at: clock.now });
    turn++;
  }
  // THE DRAIN. Everybody has stopped talking; anything still armed runs out,
  // so a sentence waiting on the last ceiling is counted rather than silently
  // dropped by the test ending. The room going quiet here is the one pause in
  // the script, and `duringConversation` is what excludes it.
  const talkingEndedAt = clock.now;
  clock.advanceTo(clock.now + 4 * Math.max(DEFAULT_NOTES_QUIET_MS, cadenceMs ?? 0));

  const waits: number[] = [];
  let carried = 0;
  for (const s of settled) {
    const tick = ticks.find((t) => t.turns.some((x) => x.turn === s.turn && !x.partial));
    if (tick === undefined) continue;
    const at = firedAt.get(tick.tick);
    if (at === undefined) continue;
    carried++;
    waits.push(at - s.at);
  }
  const duringConversation = ticks.filter((t) => (firedAt.get(t.tick) ?? 0) <= talkingEndedAt);
  return { ticks, duringConversation, waits, carried, settled: settled.length };
}

const worst = (xs: readonly number[]): number => xs.reduce((a, b) => Math.max(a, b), 0);

describe('a note under continuous speech', () => {
  it('the script really is speech with no pause in it: no tick fires on quiet', () => {
    // A positive control on every case below. If the script let the quiet
    // clock elapse, the waits would be short for a reason that has nothing
    // to do with the ceiling and the fifteen-second control would pass too.
    const run = talkContinuously(DEFAULT_NOTES_CADENCE_MS);
    expect(run.duringConversation.length).toBeGreaterThan(0);
    expect(run.duringConversation.map((t) => t.reason).filter((r) => r !== 'cadence')).toEqual([]);
  });

  it('every sentence reaches a tick inside the ticker share of the ten-second goal', () => {
    const run = talkContinuously(DEFAULT_NOTES_CADENCE_MS);
    // Nothing is left behind: a ceiling that carried half the conversation
    // would also show a short worst wait.
    expect(run.carried).toBe(run.settled);
    expect(worst(run.waits)).toBeLessThanOrEqual(TICKER_SHARE_OF_GOAL_MS);
  });

  it('the oldest words on a tick are the ones that waited, and they waited a ceiling at most', () => {
    // The wait the board's goal is about is charged from the OLDEST words a
    // tick carries, which is the number the timing log calls
    // settledToWrittenMs. No sentence may wait longer than one ceiling
    // window, because the ceiling is armed by the first unwritten word and
    // speech does not reset it.
    const run = talkContinuously(DEFAULT_NOTES_CADENCE_MS);
    expect(worst(run.waits)).toBeLessThanOrEqual(DEFAULT_NOTES_CADENCE_MS);
  });

  it('the ceiling it replaced misses the goal on the same speech — which is why this bound bites', () => {
    // The control. Fifteen seconds was the shipped ceiling until 2026-09-10;
    // the same conversation under it leaves a sentence waiting well past the
    // ticker's share of ten seconds. Without this case the bound above could
    // be passed by any ceiling at all.
    const old = talkContinuously(15_000);
    expect(old.duringConversation.map((t) => t.reason).filter((r) => r !== 'cadence')).toEqual([]);
    expect(worst(old.waits)).toBeGreaterThan(TICKER_SHARE_OF_GOAL_MS);
  });

  it('with no ceiling at all, continuous speech produces no note before the meeting ends', () => {
    // The state the ceiling was added for, kept as the far end of the scale:
    // a conversation nobody pauses in wrote nothing until somebody stopped
    // talking.
    const run = talkContinuously(undefined);
    expect(run.duringConversation).toEqual([]);
    // Every sentence of the ninety seconds waited for the room to fall
    // quiet: the whole conversation arrives in the drain's one pause tick.
    expect(run.ticks.map((t) => t.reason)).toEqual(['pause']);
    // The oldest sentence waited nearly the whole ninety seconds. The slack
    // in the bound is the last cycle that did not fit plus the quiet window
    // the drain runs out; the point is the order of magnitude, which is the
    // meeting this ceiling was added for.
    expect(worst(run.waits)).toBeGreaterThan(CONVERSATION_MS - 4 * (SENTENCE_MS + OVERLAP_MS));
  });
});
