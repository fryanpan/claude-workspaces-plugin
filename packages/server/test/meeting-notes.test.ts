/**
 * Pause-driven notes ticks: the quiet threshold, the delta each tick
 * carries, the composer seam, and the whole pipeline through the real
 * server's audio socket.
 *
 * Every timer is the injected manual scheduler — no test here waits for
 * real quiet, for the same reason the mock engine advances per chunk
 * instead of per second: the thing under test is a sequence, not a clock.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MEETING_AUDIO_ENCODING,
  MEETING_SAMPLE_RATE,
  meetingSocketPath,
  prose,
} from '@claude-workspaces/core';
import { createHaikuNotesComposer } from '../src/meeting-notes-composer.ts';
import {
  DEFAULT_NOTES_CADENCE_MS,
  DEFAULT_NOTES_ENDPOINT_CONFIRM_MS,
  DEFAULT_NOTES_QUIET_MS,
  type NotesComposeInput,
  type NotesComposer,
  type NotesCorrection,
  type NotesReattribution,
  type NotesRelabel,
  type NotesTick,
  type NotesUpdate,
  type TickScheduler,
  beginNotesSession,
  createPauseTicker,
  createStubNotesComposer,
} from '../src/meeting-notes.ts';
import { QUOTA_NOTICE_MARK, QUOTA_NOTICE_TEXT } from '../src/notes-notice.ts';
import { createNotesTimingLog } from '../src/notes-timing.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { createMockTranscriptionEngine } from '../src/transcribe.ts';
import { seedBoard } from './workspace-seed.ts';

/**
 * A scheduler the test advances by hand. `fire()` runs whatever is armed;
 * `fireAt(ms)` runs only the timer set for that delay, which is how a test
 * says "the speaker never went quiet" while still letting the cadence clock
 * run out. The ticker keeps at most one timer per delay, and re-arming one
 * replaces it.
 */
class ManualScheduler implements TickScheduler {
  private fns = new Map<number, { fn: () => void; ms: number }>();
  private n = 0;
  cleared = 0;
  set(fn: () => void, ms: number): unknown {
    this.n++;
    this.fns.set(this.n, { fn, ms });
    return this.n;
  }
  clear(handle: unknown): void {
    if (this.fns.delete(handle as number)) this.cleared++;
  }
  get armed(): number {
    return this.fns.size;
  }
  /** The live handles for a given delay — identity, so a test can tell a
   *  timer left running from one that was cleared and re-armed. */
  handlesAt(ms: number): number[] {
    return [...this.fns].filter(([, t]) => t.ms === ms).map(([handle]) => handle);
  }
  armedAt(ms: number): number {
    return this.handlesAt(ms).length;
  }
  /**
   * Runs everything armed, SHORTEST DELAY FIRST — a real clock reaches the
   * quiet threshold before the cadence ceiling, and firing in the order the
   * timers happened to be set would let the ceiling win a race it never wins
   * in a meeting.
   */
  fire(): void {
    const pending = [...this.fns.values()].sort((a, b) => a.ms - b.ms);
    this.fns.clear();
    for (const t of pending) t.fn();
  }
  /** Runs only the timers armed for `ms`. Returns how many ran. */
  fireAt(ms: number): number {
    const due = [...this.fns].filter(([, t]) => t.ms === ms);
    for (const [handle] of due) this.fns.delete(handle);
    for (const [, t] of due) t.fn();
    return due.length;
  }
}

/**
 * A composer's reply, as this file's stubs spell it.
 *
 * WHAT CHANGED. A composer used to answer with the whole notes section as a
 * string and the pipeline replaced the section with it. It now answers with
 * BLOCK EDITS addressed to ids in the outline it was handed. Nearly every
 * stub here only ever meant "these words go in the notes", so that one shape
 * is spelled once — a script about coalescing ticks should not read as a
 * script about block ops.
 */
function editsSaying(markdown: string): prose.BlockEdit[] {
  return [{ op: 'insert_at_end', markdown }];
}

/**
 * The words an update carries to the doc: every edit's markdown, in order.
 *
 * This is what `update.notes` used to be, and the difference is the point —
 * there is no whole-section string any more, so an assertion about "what the
 * tick wrote" has to be built from the edits rather than read off one field.
 */
function composedMarkdown(update: NotesUpdate): string {
  return update.edits.map((e) => ('markdown' in e ? e.markdown : '')).join('\n');
}

/** The text of the outline a compose was handed, one block per line — the
 *  outline-shaped answer to the question `input.previous` used to answer. */
function outlineText(input: NotesComposeInput | undefined): string {
  return (input?.outline ?? []).map((e) => e.text).join('\n');
}

/** The board this file's docs, tasks and reviews are filed under. */
let WS = '';

describe('the notes clocks', () => {
  /**
   * The two numbers that decide when a meeting's notes get written, spelled
   * out so moving either has to be a deliberate edit to this line.
   *
   * They are pinned because each is a decision rather than a tuning knob.
   * The quiet threshold is still the one that was DELIBERATELY left alone:
   * shaving it would show up as an improvement on every latency report in
   * the repo while being the one thing nobody chose. The ceiling moved once,
   * on 2026-09-10, when the measurement showed that in a real meeting nobody
   * is silent for four seconds, so the quiet tick almost never fires and
   * every note pays the ceiling in full — 87% of the wait before a note is
   * the wait before the model is even called. Bryan's call was six seconds,
   * paid for by the prompt cache the compose now takes. Either number moving
   * again should be a deliberate edit to this line rather than a diff a
   * reviewer has to notice.
   *
   * Nothing else asserts them: `doc-store-timings.test.ts` pins the DOC's
   * debounces (file poll, write-back, persist) and has never had these two
   * in it.
   */
  it('are the shipped 4s quiet threshold and 6s cadence ceiling', () => {
    expect(DEFAULT_NOTES_QUIET_MS).toBe(4_000);
    expect(DEFAULT_NOTES_CADENCE_MS).toBe(6_000);
    // The ceiling is a ceiling: quiet has to be able to fire first, or the
    // pause tick would be unreachable and every note would arrive on cadence.
    expect(DEFAULT_NOTES_QUIET_MS).toBeLessThan(DEFAULT_NOTES_CADENCE_MS);
  });

  it('are what a session with no overrides actually arms', async () => {
    // A positive control on the test above: the constants could hold the
    // right numbers while `beginNotesSession` fell back to something else.
    // Every other test in this file passes its own quietMs, so nothing else
    // here exercises the defaulting at all.
    const schedule = new ManualScheduler();
    const updates: NotesUpdate[] = [];
    const session = beginNotesSession(
      {
        composer: createStubNotesComposer(),
        schedule,
        onNotes: (u) => {
          updates.push(u);
        },
      },
      { docId: 'doc-clocks', meetingId: 'm-clocks' },
    );
    session.onTurn({ turn: 0, text: 'The sync is the slowest thing on the page.', final: true });
    // All three clocks are armed, each at the delay it ships with — and at no
    // other, which is what a moved default would look like.
    expect(schedule.armedAt(DEFAULT_NOTES_ENDPOINT_CONFIRM_MS)).toBe(1);
    expect(schedule.armedAt(DEFAULT_NOTES_QUIET_MS)).toBe(1);
    expect(schedule.armedAt(DEFAULT_NOTES_CADENCE_MS)).toBe(1);
    expect(schedule.armed).toBe(3);
    // The endpoint window is the one that fires first after a settled turn,
    // so it is the one asked. Quiet is the fallback behind it.
    expect(schedule.fireAt(DEFAULT_NOTES_ENDPOINT_CONFIRM_MS)).toBe(1);
    await session.end();
    expect(updates.map((u) => u.tick.reason)).toEqual(['pause']);
  });

  it('the endpoint window is shorter than the quiet clock it fronts', () => {
    // Otherwise it could never fire first, and the engine's own endpoint —
    // the whole reason the window exists — would never be what produced a
    // note.
    expect(DEFAULT_NOTES_ENDPOINT_CONFIRM_MS).toBe(1_000);
    expect(DEFAULT_NOTES_ENDPOINT_CONFIRM_MS).toBeLessThan(DEFAULT_NOTES_QUIET_MS);
  });
});

describe('pause ticker', () => {
  const QUIET_MS = 1000;
  const CADENCE_MS = 5000;
  /** Distinct from both, so `fireAt` can name exactly one of the three. */
  const CONFIRM_MS = 200;
  const setup = (quietMs = QUIET_MS, cadenceMs = CADENCE_MS) => {
    const schedule = new ManualScheduler();
    const ticks: NotesTick[] = [];
    const ticker = createPauseTicker({
      quietMs,
      cadenceMs,
      endpointConfirmMs: CONFIRM_MS,
      schedule,
      onTick: (t) => ticks.push(t),
    });
    return { schedule, ticks, ticker };
  };

  it('quiet after settled turns emits one tick carrying exactly those turns', () => {
    const { schedule, ticks, ticker } = setup();
    ticker.onTurn({ turn: 0, text: 'we should', final: false });
    ticker.onTurn({ turn: 0, text: 'We should measure first.', final: true });
    ticker.onTurn({ turn: 1, text: 'Agreed.', final: true });
    expect(ticks).toEqual([]); // no tick until the quiet elapses
    schedule.fire();
    expect(ticks).toEqual([
      {
        tick: 1,
        reason: 'pause',
        turns: [
          { turn: 0, text: 'We should measure first.' },
          { turn: 1, text: 'Agreed.' },
        ],
      },
    ]);
  });

  it('a partial re-arms the quiet timer: speech in progress is not a pause', () => {
    const { schedule, ticks, ticker } = setup();
    ticker.onTurn({ turn: 0, text: 'Done.', final: true });
    const clearedBefore = schedule.cleared;
    ticker.onTurn({ turn: 1, text: 'but', final: false });
    // Two clocks are withdrawn by that partial, not one: the quiet countdown
    // is replaced rather than left running from the final, and the endpoint
    // window the final opened is closed outright — somebody carried on, so
    // the engine's "they stopped" has been contradicted.
    expect(schedule.cleared).toBe(clearedBefore + 2);
    expect(schedule.armedAt(QUIET_MS)).toBe(1);
    expect(schedule.armedAt(CONFIRM_MS)).toBe(0);
    expect(ticks).toEqual([]);
    schedule.fire();
    expect(ticks.length).toBe(1);
  });

  it('a settled turn opens the endpoint window, and quiet inside it is a pause', () => {
    // The engine's endpoint detector already decided the speaker stopped.
    // The window is only long enough for the next voice to start.
    const { schedule, ticks, ticker } = setup();
    ticker.onTurn({ turn: 0, text: 'That is the whole change.', final: true });
    expect(schedule.armedAt(CONFIRM_MS)).toBe(1);
    expect(schedule.fireAt(CONFIRM_MS)).toBe(1);
    expect(ticks.map((t) => t.reason)).toEqual(['pause']);
    expect(ticks[0]?.turns).toEqual([{ turn: 0, text: 'That is the whole change.' }]);
    // And the fallback clock it fronted is gone with it, so the same words
    // cannot produce a second tick four seconds later.
    expect(schedule.armedAt(QUIET_MS)).toBe(0);
  });

  it('somebody answering inside the window falls back to the quiet clock', () => {
    const { schedule, ticks, ticker } = setup();
    ticker.onTurn({ turn: 0, text: 'Shall we ship it?', final: true });
    // The next voice starts before the window elapses. That is a handover
    // inside a conversation, not the end of the exchange.
    ticker.onTurn({ turn: 1, text: 'not until', final: false });
    expect(schedule.armedAt(CONFIRM_MS)).toBe(0);
    expect(schedule.fireAt(CONFIRM_MS)).toBe(0);
    expect(ticks).toEqual([]);
    // Four seconds of real quiet still fires, which is what the fallback is.
    expect(schedule.fireAt(QUIET_MS)).toBe(1);
    expect(ticks.map((t) => t.reason)).toEqual(['pause']);
  });

  it('quiet with no new settled turns emits nothing', () => {
    const { schedule, ticks, ticker } = setup();
    ticker.onTurn({ turn: 0, text: 'Ship it.', final: true });
    schedule.fire();
    expect(ticks.length).toBe(1);
    // More quiet, nothing new said: no empty tick.
    ticker.onTurn({ turn: 1, text: 'um', final: false });
    schedule.fire();
    expect(ticks.length).toBe(1);
  });

  it('a turn settled twice lands in the delta once', () => {
    const { schedule, ticks, ticker } = setup();
    ticker.onTurn({ turn: 0, text: 'Once.', final: true });
    ticker.onTurn({ turn: 0, text: 'Once.', final: true });
    schedule.fire();
    expect(ticks[0]?.turns).toEqual([{ turn: 0, text: 'Once.' }]);
  });

  it('end() flushes the tail delta as an end tick, and only once', () => {
    const { schedule, ticks, ticker } = setup();
    ticker.onTurn({ turn: 0, text: 'First.', final: true });
    schedule.fire();
    ticker.onTurn({ turn: 1, text: 'Last words.', final: true });
    ticker.end();
    ticker.end();
    expect(ticks.length).toBe(2);
    expect(ticks[1]).toEqual({
      tick: 2,
      reason: 'end',
      turns: [{ turn: 1, text: 'Last words.' }],
    });
    // Nothing armed survives the end.
    expect(schedule.armed).toBe(0);
  });

  it('end() carries the sentence still being spoken, flagged as unfinished', () => {
    const { ticks, ticker } = setup();
    ticker.onTurn({ turn: 0, text: 'We agreed on the smaller scope.', final: true });
    ticker.onTurn({ turn: 1, text: 'and the one thing I still want is', final: false });
    ticker.end();
    // Both: the settled sentence first, then the interrupted one after it.
    expect(ticks[0]?.turns).toEqual([
      { turn: 0, text: 'We agreed on the smaller scope.' },
      { turn: 1, text: 'and the one thing I still want is', partial: true },
    ]);
  });

  it('an unsettled turn is the ONLY thing a final tick needs to fire', () => {
    const { schedule, ticks, ticker } = setup();
    ticker.onTurn({ turn: 0, text: 'Ship it.', final: true });
    schedule.fire();
    expect(ticks.length).toBe(1);
    // Nothing has settled since, so the old ticker had nothing to flush and
    // this sentence went nowhere.
    ticker.onTurn({ turn: 1, text: 'one last thing before we', final: false });
    ticker.end();
    expect(ticks.length).toBe(2);
    expect(ticks[1]).toEqual({
      tick: 2,
      reason: 'end',
      turns: [{ turn: 1, text: 'one last thing before we', partial: true }],
    });
  });

  it('carries the LATEST partial of a turn, not every draft of it', () => {
    const { ticks, ticker } = setup();
    ticker.onTurn({ turn: 0, text: 'the thing', final: false });
    ticker.onTurn({ turn: 0, text: 'the thing I keep', final: false });
    ticker.onTurn({ turn: 0, text: 'the thing I keep meaning to', final: false });
    ticker.end();
    expect(ticks[0]?.turns).toEqual([
      { turn: 0, text: 'the thing I keep meaning to', partial: true },
    ]);
  });

  it('a turn that settled is carried as settled, never twice', () => {
    const { ticks, ticker } = setup();
    ticker.onTurn({ turn: 0, text: 'we should measure', final: false });
    ticker.onTurn({ turn: 0, text: 'We should measure first.', final: true });
    ticker.end();
    expect(ticks[0]?.turns).toEqual([{ turn: 0, text: 'We should measure first.' }]);
  });

  it('the speaker rides the unfinished sentence too', () => {
    const { ticks, ticker } = setup();
    ticker.onTurn({ turn: 0, text: 'and my worry is that', final: false, speaker: 'B' });
    ticker.end();
    expect(ticks[0]?.turns).toEqual([
      { turn: 0, text: 'and my worry is that', partial: true, speaker: 'B' },
    ]);
  });

  it('an empty partial is not a sentence, and does not manufacture a tick', () => {
    const { ticks, ticker } = setup();
    ticker.onTurn({ turn: 0, text: '   ', final: false });
    ticker.end();
    expect(ticks).toEqual([]);
  });

  it('an ordinary tick still carries settled words only', () => {
    const { schedule, ticks, ticker } = setup();
    ticker.onTurn({ turn: 0, text: 'Ship the fix.', final: true });
    ticker.onTurn({ turn: 1, text: 'but only once we have', final: false });
    schedule.fireAt(QUIET_MS);
    expect(ticks[0]?.turns).toEqual([{ turn: 0, text: 'Ship the fix.' }]);
    // And it is still available to the end tick afterwards.
    ticker.end();
    expect(ticks[1]?.turns).toEqual([{ turn: 1, text: 'but only once we have', partial: true }]);
  });

  it("carries the engine's speaker label on a settled turn", () => {
    const { schedule, ticks, ticker } = setup();
    ticker.onTurn({ turn: 0, text: 'Take it?', final: true, speaker: 'A' });
    ticker.onTurn({ turn: 1, text: 'Sure.', final: true });
    schedule.fire();
    expect(ticks[0]?.turns).toEqual([
      { turn: 0, text: 'Take it?', speaker: 'A' },
      { turn: 1, text: 'Sure.' },
    ]);
  });

  it('a revision relabels a turn still waiting to compose', () => {
    const { schedule, ticks, ticker } = setup();
    ticker.onTurn({ turn: 0, text: 'Take it?', final: true, speaker: 'A' });
    // The end-of-session pass changed its mind before the pause ever fired.
    ticker.onTurn({ turn: 0, text: 'Take it?', final: true, speaker: 'B' });
    // And can take the label away entirely, on turn 1.
    ticker.onTurn({ turn: 1, text: 'Sure.', final: true, speaker: 'C' });
    ticker.onTurn({ turn: 1, text: 'Sure.', final: true });
    schedule.fire();
    // Still one turn each — a revision revises, it never duplicates.
    expect(ticks[0]?.turns).toEqual([
      { turn: 0, text: 'Take it?', speaker: 'B' },
      { turn: 1, text: 'Sure.' },
    ]);
  });

  it('a revision of a turn already composed does not re-emit it', () => {
    const { schedule, ticks, ticker } = setup();
    ticker.onTurn({ turn: 0, text: 'Take it?', final: true, speaker: 'A' });
    schedule.fire();
    ticker.onTurn({ turn: 0, text: 'Take it?', final: true, speaker: 'B' });
    schedule.fire();
    // Those words are already in the doc under 'A'; the revision has nowhere
    // to land, and must not compose the same turn a second time.
    expect(ticks).toHaveLength(1);
    expect(ticks[0]?.turns).toEqual([{ turn: 0, text: 'Take it?', speaker: 'A' }]);
  });

  it('end() with nothing pending emits nothing', () => {
    const { ticks, ticker } = setup();
    ticker.end();
    expect(ticks).toEqual([]);
  });

  it('nobody pauses: the cadence fires while the quiet countdown is still being pushed back', () => {
    const { schedule, ticks, ticker } = setup();
    // A continuous stretch of speech: every settled sentence is followed by
    // the next one's partial, so the quiet countdown is replaced before it
    // can ever elapse. This is the meeting that produced nothing until it
    // ended.
    ticker.onTurn({ turn: 0, text: 'we should measure', final: false });
    ticker.onTurn({ turn: 0, text: 'We should measure first.', final: true });
    ticker.onTurn({ turn: 1, text: 'and then decide', final: false });
    ticker.onTurn({ turn: 1, text: 'And then decide.', final: true });
    ticker.onTurn({ turn: 2, text: 'the numbers say', final: false });
    expect(ticks).toEqual([]);
    // The quiet timer is still armed and is deliberately never fired here.
    expect(schedule.armedAt(QUIET_MS)).toBe(1);
    expect(schedule.fireAt(CADENCE_MS)).toBe(1);
    expect(ticks).toEqual([
      {
        tick: 1,
        reason: 'cadence',
        turns: [
          { turn: 0, text: 'We should measure first.' },
          { turn: 1, text: 'And then decide.' },
        ],
      },
    ]);
  });

  it('a cadence tick carries finished sentences only — the turn still being spoken waits', () => {
    const { schedule, ticks, ticker } = setup();
    ticker.onTurn({ turn: 0, text: 'Ship the fix.', final: true });
    ticker.onTurn({ turn: 1, text: 'but only once we have', final: false });
    schedule.fireAt(CADENCE_MS);
    // Turn 1 is mid-clause and unpunctuated; it is not a sentence yet.
    expect(ticks[0]?.turns).toEqual([{ turn: 0, text: 'Ship the fix.' }]);
    // It lands whole in the next tick, once the engine settles it.
    ticker.onTurn({ turn: 1, text: 'But only once we have the numbers.', final: true });
    schedule.fireAt(CADENCE_MS);
    expect(ticks[1]?.turns).toEqual([{ turn: 1, text: 'But only once we have the numbers.' }]);
  });

  it('the cadence clock runs from the first unwritten sentence and speech does not reset it', () => {
    const { schedule, ticks, ticker } = setup();
    ticker.onTurn({ turn: 0, text: 'One.', final: true });
    const [armed] = schedule.handlesAt(CADENCE_MS);
    expect(armed).toBeDefined();
    // Frames keep arriving. If any of them re-armed the cadence, the handle
    // would change and the oldest sentence's wait would restart — which is
    // the pause timer's bug, not a fix for it.
    ticker.onTurn({ turn: 1, text: 'two', final: false });
    ticker.onTurn({ turn: 1, text: 'Two.', final: true });
    ticker.onTurn({ turn: 2, text: 'three', final: false });
    expect(schedule.handlesAt(CADENCE_MS)).toEqual([armed]);
    expect(ticks).toEqual([]);
  });

  it('a pause tick disarms the cadence, and new words arm a fresh one', () => {
    const { schedule, ticks, ticker } = setup();
    ticker.onTurn({ turn: 0, text: 'Quiet after this.', final: true });
    const [first] = schedule.handlesAt(CADENCE_MS);
    schedule.fireAt(QUIET_MS);
    expect(ticks.map((t) => t.reason)).toEqual(['pause']);
    // Nothing unwritten is waiting, so no cadence tick is owed.
    expect(schedule.armedAt(CADENCE_MS)).toBe(0);
    expect(schedule.fireAt(CADENCE_MS)).toBe(0);
    expect(ticks.length).toBe(1);
    ticker.onTurn({ turn: 1, text: 'More.', final: true });
    expect(schedule.armedAt(CADENCE_MS)).toBe(1);
    expect(schedule.handlesAt(CADENCE_MS)).not.toEqual([first]);
  });

  it('a partial alone arms the ceiling: a WORD is unwritten speech', () => {
    // This is the inversion the long-turn bug needed. The ceiling used to
    // wait for a settled turn, so a person talking without stopping — one
    // turn, minutes long — had no clock running at all, and the ceiling that
    // exists to bound exactly that wait was unreachable inside it.
    const { schedule, ticker } = setup();
    ticker.onTurn({ turn: 0, text: 'still talking', final: false });
    expect(schedule.armedAt(CADENCE_MS)).toBe(1);
  });

  it('an empty partial is not a word, and arms no ceiling', () => {
    // The control on the test above: it must be the WORDS that arm it, not
    // the arrival of a frame. An engine that emits an empty keep-alive
    // partial would otherwise start a clock towards a tick with nothing in
    // it.
    const { schedule, ticker } = setup();
    ticker.onTurn({ turn: 0, text: '   ', final: false });
    expect(schedule.armedAt(CADENCE_MS)).toBe(0);
  });

  it('a ceiling reached inside one long turn writes the engine-final words', () => {
    // The whole point of arming on a word. Nothing has settled — one person
    // is still talking — but the engine has finalized the opening of what
    // they said, and those words are as unrevisable as a settled turn's.
    const { schedule, ticks, ticker } = setup();
    ticker.onTurn({ turn: 0, text: 'so the plan', final: false });
    ticker.onTurn({
      turn: 0,
      text: 'so the plan is to measure the write path first',
      final: false,
      settledText: 'so the plan is to measure',
    });
    expect(schedule.fireAt(CADENCE_MS)).toBe(1);
    expect(ticks).toEqual([
      {
        tick: 1,
        reason: 'cadence',
        turns: [{ turn: 0, text: 'so the plan is to measure', partial: true }],
      },
    ]);
  });

  it('the words a ceiling carried are not written twice when the turn settles', () => {
    const { schedule, ticks, ticker } = setup();
    ticker.onTurn({
      turn: 0,
      text: 'so the plan is to measure the write',
      final: false,
      settledText: 'so the plan is to measure',
    });
    schedule.fireAt(CADENCE_MS);
    // The formatted final re-cases and punctuates the SAME words, which is
    // why the carry is counted in words rather than characters.
    ticker.onTurn({
      turn: 0,
      text: 'So the plan is to measure the write path first.',
      final: true,
    });
    schedule.fireAt(CONFIRM_MS);
    expect(ticks[1]?.turns).toEqual([{ turn: 0, text: 'the write path first.', continued: true }]);
  });

  it('a turn whose settled words are all already carried adds no empty note', () => {
    const { schedule, ticks, ticker } = setup();
    ticker.onTurn({ turn: 0, text: 'ship it', final: false, settledText: 'ship it' });
    schedule.fireAt(CADENCE_MS);
    expect(ticks).toHaveLength(1);
    ticker.onTurn({ turn: 0, text: 'Ship it.', final: true });
    schedule.fire();
    expect(ticks).toHaveLength(1);
  });

  it('a ceiling tick without engine-final words still carries settled turns only', () => {
    // An engine that reports no per-word finality (the mock) is unchanged:
    // the sentence in progress waits for the next tick, as it always did.
    const { schedule, ticks, ticker } = setup();
    ticker.onTurn({ turn: 0, text: 'Ship the fix.', final: true });
    ticker.onTurn({ turn: 1, text: 'but only once we have', final: false });
    schedule.fireAt(CADENCE_MS);
    expect(ticks[0]?.turns).toEqual([{ turn: 0, text: 'Ship the fix.' }]);
  });

  it("one stream talking through the other no longer holds the other's words", () => {
    // Room and remote feed one ticker. The remote mic ran a single unbroken
    // turn — one person making an argument — and every partial of it re-armed
    // the quiet clock, so the room's finished sentence sat in `pending` for
    // as long as the argument lasted. Neither stream is waiting on the other
    // now: the ceiling armed on the first word, and it carries both what has
    // settled and the engine's already-final prefix of what has not.
    const { schedule, ticks, ticker } = setup();
    ticker.onTurn({ turn: 0, text: 'the', final: false, settledText: 'the' });
    ticker.onTurn({ turn: 1, text: 'That matches what I measured.', final: true });
    for (const [text, settled] of [
      ['the second thing', 'the second'],
      ['the second thing we should', 'the second thing we'],
      ['the second thing we should look at is the write', 'the second thing we should look at'],
    ] as const) {
      ticker.onTurn({ turn: 0, text, final: false, settledText: settled });
    }
    // No pause has happened and none is coming: somebody is still talking.
    expect(ticks).toEqual([]);
    expect(schedule.fireAt(CADENCE_MS)).toBe(1);
    expect(ticks[0]?.reason).toBe('cadence');
    // Settled words first, then the sentence still in progress — a tick is
    // ordered by how finished its words are, not by turn number.
    expect(ticks[0]?.turns).toEqual([
      { turn: 1, text: 'That matches what I measured.' },
      { turn: 0, text: 'the second thing we should look at', partial: true },
    ]);
  });

  it('end() leaves no cadence timer armed', () => {
    const { schedule, ticker } = setup();
    ticker.onTurn({ turn: 0, text: 'Last words.', final: true });
    expect(schedule.armedAt(CADENCE_MS)).toBe(1);
    ticker.end();
    expect(schedule.armed).toBe(0);
  });

  it('cadence ticks and pause ticks share one numbering', () => {
    const { schedule, ticks, ticker } = setup();
    ticker.onTurn({ turn: 0, text: 'One.', final: true });
    schedule.fireAt(CADENCE_MS);
    ticker.onTurn({ turn: 1, text: 'Two.', final: true });
    schedule.fireAt(QUIET_MS);
    expect(ticks.map((t) => [t.tick, t.reason])).toEqual([
      [1, 'cadence'],
      [2, 'pause'],
    ]);
  });
});

describe('stub notes composer', () => {
  const tick: NotesTick = {
    tick: 1,
    reason: 'pause',
    turns: [
      { turn: 0, text: 'The sync is the bottleneck.' },
      { turn: 1, text: 'Measure before rewriting.' },
    ],
  };
  const input: NotesComposeInput = {
    docId: 'doc-a',
    meetingId: 'm-doc-a-1',
    tick,
    outline: [],
  };

  it('is deterministic: the same input composes the same edits', async () => {
    const composer = createStubNotesComposer();
    const a = await composer.compose(input);
    const b = await composer.compose(input);
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).toContain('The sync is the bottleneck.');
  });

  it('opens a section when there is none, and writes under it once there is', async () => {
    // WHAT CHANGED, AND WHY IT IS THE SAME PROPERTY. The stub used to be
    // asserted to APPEND to `previous` — the whole notes came back each tick,
    // so "did not restate from nothing" meant the new string started with the
    // old one. There is no such string now: the second tick adds a bullet
    // under the heading the first one opened, and never re-sends what is
    // already in the doc. Naming the heading by id is what makes that
    // possible, so that is what this asserts.
    const composer = createStubNotesComposer();
    const first = await composer.compose(input);
    expect(first).toHaveLength(1);
    expect(first[0]?.op).toBe('insert_at_end');
    expect(JSON.stringify(first)).toContain('## Meeting notes');
    expect(JSON.stringify(first)).toContain('The sync is the bottleneck.');

    const second = await composer.compose({
      ...input,
      outline: [
        { id: 'h7', kind: 'heading', nodeName: 'heading', level: 2, text: 'Meeting notes' },
      ],
      notesHeadingId: 'h7',
      tick: { tick: 2, reason: 'pause', turns: [{ turn: 2, text: 'Agreed.' }] },
    });
    expect(second).toEqual([
      { op: 'insert_under_heading', headingId: 'h7', markdown: '- Agreed.' },
    ]);
    expect(JSON.stringify(second)).not.toContain('The sync is the bottleneck.');
  });
});

describe('notes session', () => {
  const ids = { docId: 'doc-b', meetingId: 'm-doc-b-1' };

  it('composes each tick in order, each seeing the doc as it then read', async () => {
    // The chain is still one-at-a-time and still ordered; what threads
    // through it is no longer the previous ANSWER but the DOC. So the second
    // compose is asserted to have seen what the first one's edit put there —
    // which is a stronger statement, because a person's edit reaches it by
    // the same route.
    const schedule = new ManualScheduler();
    const updates: NotesUpdate[] = [];
    const inputs: NotesComposeInput[] = [];
    const written: prose.OutlineEntry[] = [];
    // Resolves out of band so ordering is the chain's doing, not luck.
    const composer: NotesComposer = {
      name: 'slow-stub',
      async compose(input) {
        inputs.push(input);
        await new Promise((r) => setTimeout(r, 5));
        return editsSaying(`notes after tick ${input.tick.tick}`);
      },
    };
    const session = beginNotesSession(
      {
        composer,
        quietMs: 1000,
        schedule,
        // A copy: the input holds this array by reference, and a test that
        // handed out the live one would read LATER ticks' writes back out of
        // an earlier tick's input.
        readOutline: () => [...written],
        onNotes: (u) => {
          updates.push(u);
          for (const edit of u.edits) {
            if ('markdown' in edit)
              written.push({
                id: `b${written.length}`,
                kind: 'block',
                nodeName: 'paragraph',
                text: edit.markdown,
                author: 'meeting-notes',
              });
          }
        },
      },
      ids,
    );
    session.onTurn({ turn: 0, text: 'First.', final: true });
    schedule.fire();
    session.onTurn({ turn: 1, text: 'Second.', final: true });
    await session.end();
    expect(updates.map(composedMarkdown)).toEqual(['notes after tick 1', 'notes after tick 2']);
    expect(outlineText(inputs[0])).toBe('');
    expect(outlineText(inputs[1])).toBe('notes after tick 1');
    expect(updates[1]?.tick.reason).toBe('end');
    expect(updates.every((u) => u.docId === ids.docId && u.meetingId === ids.meetingId)).toBe(true);
  });

  it('the composer sees speakers by the names given so far, and "Speaker A" until then', async () => {
    const schedule = new ManualScheduler();
    const inputs: NotesComposeInput[] = [];
    const composer: NotesComposer = {
      name: 'capture',
      compose(input) {
        inputs.push(input);
        return Promise.resolve(editsSaying('notes'));
      },
    };
    const session = beginNotesSession(
      { composer, quietMs: 1000, schedule, onNotes: () => {} },
      ids,
    );
    session.onTurn({ turn: 0, text: 'Take it?', final: true, speaker: 'A' });
    session.onTurn({ turn: 1, text: 'Sure.', final: true, speaker: 'B' });
    session.nameSpeaker('A', 'Jordan');
    schedule.fire();
    // The compose runs on the chain's microtask; let it read the names as
    // they stand BEFORE the second one lands, so only later ticks read Sam.
    await new Promise((r) => setTimeout(r, 0));
    session.nameSpeaker('B', 'Sam');
    session.onTurn({ turn: 2, text: 'By Thursday.', final: true, speaker: 'B' });
    await session.end();
    expect(inputs.map((i) => i.tick.turns.map((t) => t.speaker))).toEqual([
      ['Jordan', 'Speaker B'],
      ['Sam'],
    ]);
  });

  it('gives the composer a two-stream voice by its name alone', async () => {
    // The server-side composer is the sixth surface AC1 names. An unnamed
    // voice still says which room it is in — that is what tells two
    // Speaker As apart — and a named one does not.
    const schedule = new ManualScheduler();
    const inputs: NotesComposeInput[] = [];
    const composer: NotesComposer = {
      name: 'capture',
      compose(input) {
        inputs.push(input);
        return Promise.resolve(editsSaying('notes'));
      },
    };
    const session = beginNotesSession(
      { composer, quietMs: 1000, schedule, onNotes: () => {} },
      ids,
    );
    session.onTurn({ turn: 0, text: 'In the room.', final: true, speaker: 'room:A' });
    session.onTurn({ turn: 1, text: 'On the call.', final: true, speaker: 'remote:B' });
    session.nameSpeaker('room:A', 'John');
    await session.end();
    expect(inputs.at(-1)?.tick.turns.map((t) => t.speaker)).toEqual(['John', 'Remote Speaker B']);
  });

  it('naming a voice tells the sink exactly what to change, in the composer’s words', async () => {
    const schedule = new ManualScheduler();
    const inputs: NotesComposeInput[] = [];
    const relabels: NotesRelabel[] = [];
    const composer: NotesComposer = {
      name: 'capture',
      compose(input) {
        inputs.push(input);
        const line = input.tick.turns.map((t) => `- ${t.speaker}: ${t.text}`).join('\n');
        return Promise.resolve(editsSaying(line));
      },
    };
    const session = beginNotesSession(
      {
        composer,
        quietMs: 1000,
        schedule,
        onNotes: () => {},
        onRelabel: (r) => relabels.push(r),
      },
      ids,
    );
    // A second voice, heard only as a partial: tags and speaker names are
    // suppressed until the session is genuinely multi-speaker (owner's call,
    // 2026-08-31), and a partial registers the voice without adding a turn.
    session.onTurn({ turn: 90, text: 'mm', final: false, speaker: 'Z' });
    session.onTurn({ turn: 0, text: 'Take it?', final: true, speaker: 'B' });
    schedule.fire();
    await new Promise((r) => setTimeout(r, 0));
    // The notes now say "Speaker B" and the doc has them.
    expect(inputs[0]?.tick.turns[0]?.speaker).toBe('Speaker B');

    session.nameSpeaker('B', 'Marisol');
    session.onTurn({ turn: 1, text: 'By Thursday.', final: true, speaker: 'B' });
    schedule.fire();
    await session.end();

    // The sink was told exactly what to change, in the words the composer
    // had written — not the raw engine label.
    expect(relabels).toEqual([
      {
        docId: ids.docId,
        meetingId: ids.meetingId,
        label: 'B',
        from: 'Speaker B',
        to: 'Marisol',
        rewriteUntagged: true,
      },
    ]);
    // WHAT CHANGED. This used to also assert that the SESSION's mirror of
    // the notes had been rewritten, so the next compose would not read the
    // placeholder back. There is no mirror: the rewrite happens in the doc,
    // and the next compose reads the doc. What is left to assert here is that
    // nothing in this module re-feeds the old words — with no doc wired the
    // next compose sees an empty outline, where it used to see its own last
    // answer. The doc-side rewrite is `meeting-notes-doc.test.ts`,
    // "applyNotesRelabel".
    expect(outlineText(inputs[1])).toBe('');
    expect(inputs[1]?.tick.turns[0]?.speaker).toBe('Marisol');
  });

  it('a rename during a compose lands after it, not under it', async () => {
    // The compose in flight read the outline before the rename and will
    // return edits written the old way. The rewrite has to be queued behind
    // it — ahead of it, the compose would put the placeholder straight back.
    const schedule = new ManualScheduler();
    const inputs: NotesComposeInput[] = [];
    const relabels: NotesRelabel[] = [];
    const order: string[] = [];
    const composer: NotesComposer = {
      name: 'slow',
      async compose(input) {
        inputs.push(input);
        await new Promise((r) => setTimeout(r, 10));
        order.push('composed');
        return editsSaying(`- ${input.tick.turns[0]?.speaker}: said it`);
      },
    };
    const session = beginNotesSession(
      {
        composer,
        quietMs: 1000,
        schedule,
        onNotes: () => {},
        onRelabel: (r) => {
          order.push('relabelled');
          relabels.push(r);
        },
      },
      ids,
    );
    // A second voice, heard only as a partial: tags and speaker names are
    // suppressed until the session is genuinely multi-speaker (owner's call,
    // 2026-08-31), and a partial registers the voice without adding a turn.
    session.onTurn({ turn: 90, text: 'mm', final: false, speaker: 'Z' });
    session.onTurn({ turn: 0, text: 'One.', final: true, speaker: 'A' });
    schedule.fire();
    // Let the chained compose actually START — a rename before that point is
    // the documented case where the name reaches the tick itself, which is a
    // different behaviour and would not test the queue at all.
    await new Promise((r) => setTimeout(r, 0));
    // Renamed while the 10ms compose is still running.
    session.nameSpeaker('A', 'Devi');
    await session.end();

    // Three, not two: turn 90 was heard only as a partial and never settled,
    // so the final pass composes it. That is the point of the final pass —
    // the sentence in progress at the stop gets a tick of its own — and it
    // lands after the relabel like everything else on the chain.
    expect(order).toEqual(['composed', 'relabelled', 'composed']);
    expect(relabels).toEqual([
      {
        docId: ids.docId,
        meetingId: ids.meetingId,
        label: 'A',
        from: 'Speaker A',
        to: 'Devi',
        rewriteUntagged: true,
      },
    ]);
    // The compose that was in flight wrote "Speaker A"; the rewrite behind
    // it corrected the memory, so a later tick starts from the name.
    expect(inputs[0]?.tick.turns[0]?.speaker).toBe('Speaker A');
    session.onTurn({ turn: 1, text: 'Two.', final: true, speaker: 'A' });
  });

  it('correcting a name already given rewrites from that name, not from the label', async () => {
    const schedule = new ManualScheduler();
    const relabels: NotesRelabel[] = [];
    const composer: NotesComposer = {
      name: 'capture',
      compose: (input) =>
        Promise.resolve(
          editsSaying(`- ${input.tick.turns[0]?.speaker}: ${input.tick.turns[0]?.text}`),
        ),
    };
    const session = beginNotesSession(
      { composer, quietMs: 1000, schedule, onNotes: () => {}, onRelabel: (r) => relabels.push(r) },
      ids,
    );
    session.onTurn({ turn: 0, text: 'Hello.', final: true, speaker: 'A' });
    session.nameSpeaker('A', 'Devi');
    schedule.fire();
    await new Promise((r) => setTimeout(r, 0));
    session.nameSpeaker('A', 'Devi Raman');
    await session.end();
    expect(relabels.map((r) => `${r.from}->${r.to}`)).toEqual([
      'Speaker A->Devi',
      'Devi->Devi Raman',
    ]);
  });

  it('narrows to tagged mentions when two voices share the name, rather than reattributing one', async () => {
    // Two people called Alex. The WORDS "Alex" in the notes do not say which
    // of them, so correcting one must not move the other's words — but an
    // inline tag carries the label, so it does say, and it still renames.
    const schedule = new ManualScheduler();
    const relabels: NotesRelabel[] = [];
    const errors: string[] = [];
    const session = beginNotesSession(
      {
        composer: {
          name: 'x',
          compose: () => Promise.resolve(editsSaying('- Alex: both of them')),
        },
        quietMs: 1000,
        schedule,
        onNotes: () => {},
        onRelabel: (r) => relabels.push(r),
        onError: (m) => errors.push(m),
      },
      ids,
    );
    session.onTurn({ turn: 0, text: 'One.', final: true, speaker: 'A' });
    session.onTurn({ turn: 1, text: 'Two.', final: true, speaker: 'B' });
    session.nameSpeaker('A', 'Alex');
    session.nameSpeaker('B', 'Alex');
    // Correcting one of the two Alexes.
    session.nameSpeaker('A', 'Sam');
    await session.end();
    // All three go out — including the correction, which the tags can carry.
    expect(relabels.map((r) => `${r.from}->${r.to}`)).toEqual([
      'Speaker A->Alex',
      'Speaker B->Alex',
      'Alex->Sam',
    ]);
    // But the correction is marked: the untagged sweep, which can only match
    // the word "Alex", is switched off for it. The first two were
    // unambiguous when made and keep it.
    expect(relabels.map((r) => r.rewriteUntagged)).toEqual([true, true, false]);
    expect(relabels[2]?.label).toBe('A');
    expect(errors.join(' ')).toContain('only tagged mentions');
  });

  it('refuses a placeholder as a name, so it can never collide with a real voice', async () => {
    // WHAT CHANGED. This used to name A "Speaker B" — B's own placeholder —
    // and assert that the ambiguity guard caught the collision. A placeholder
    // is no longer storable as a name at all (Bryan, 2026-09-09), so the
    // collision cannot arise: the first call writes nothing and the second
    // renames from the placeholder A still has.
    const schedule = new ManualScheduler();
    const relabels: NotesRelabel[] = [];
    const errors: string[] = [];
    const session = beginNotesSession(
      {
        composer: { name: 'x', compose: () => Promise.resolve(editsSaying('notes')) },
        quietMs: 1000,
        schedule,
        onNotes: () => {},
        onRelabel: (r) => relabels.push(r),
        onError: (m) => errors.push(m),
      },
      ids,
    );
    session.onTurn({ turn: 0, text: 'One.', final: true, speaker: 'A' });
    session.onTurn({ turn: 1, text: 'Two.', final: true, speaker: 'B' });
    session.nameSpeaker('A', 'Speaker B');
    session.nameSpeaker('A', 'Sam');
    await session.end();
    expect(relabels.map((r) => `${r.from}->${r.to}`)).toEqual(['Speaker A->Sam']);
    // Nothing was ambiguous, so the untagged sweep is not narrowed and
    // nothing was reported.
    expect(relabels.map((r) => r.rewriteUntagged)).toEqual([true]);
    expect(errors.join(' ')).not.toContain('only tagged mentions');
  });

  it('an unrelated named voice does not make a rename ambiguous', async () => {
    // The positive control for the two tests above: without it, a guard that
    // refused every rename would pass both of them.
    const schedule = new ManualScheduler();
    const relabels: NotesRelabel[] = [];
    const errors: string[] = [];
    const session = beginNotesSession(
      {
        composer: { name: 'x', compose: () => Promise.resolve(editsSaying('notes')) },
        quietMs: 1000,
        schedule,
        onNotes: () => {},
        onRelabel: (r) => relabels.push(r),
        onError: (m) => errors.push(m),
      },
      ids,
    );
    session.onTurn({ turn: 0, text: 'One.', final: true, speaker: 'A' });
    session.onTurn({ turn: 1, text: 'Two.', final: true, speaker: 'B' });
    session.nameSpeaker('B', 'Rin');
    session.nameSpeaker('A', 'Sam');
    await session.end();
    expect(relabels.map((r) => `${r.from}->${r.to}`)).toEqual(['Speaker B->Rin', 'Speaker A->Sam']);
    expect(errors).toEqual([]);
  });

  it('renaming a voice to what it is already called changes nothing', async () => {
    const relabels: NotesRelabel[] = [];
    const session = beginNotesSession(
      {
        composer: { name: 'x', compose: () => Promise.resolve(editsSaying('notes')) },
        quietMs: 1000,
        schedule: new ManualScheduler(),
        onNotes: () => {},
        onRelabel: (r) => relabels.push(r),
      },
      ids,
    );
    session.nameSpeaker('A', 'Speaker A');
    await session.end();
    expect(relabels).toEqual([]);
  });

  it('the stub composer writes the speaker before the words', async () => {
    const edits = await createStubNotesComposer().compose({
      docId: 'd',
      meetingId: 'm',
      tick: {
        tick: 1,
        reason: 'pause',
        turns: [
          { turn: 0, text: 'Take it?', speaker: 'Jordan' },
          { turn: 1, text: 'Sure.' },
        ],
      },
      outline: [],
    });
    expect(edits).toEqual([
      {
        op: 'insert_at_end',
        markdown: '## Meeting notes\n\n- Jordan: Take it?\n- Sure.',
      },
    ]);
  });

  it('a failed compose reports the error and carries its words into the next tick', async () => {
    const schedule = new ManualScheduler();
    const updates: NotesUpdate[] = [];
    const errors: string[] = [];
    let failures = 1;
    const composer: NotesComposer = {
      name: 'flaky-stub',
      compose(input) {
        if (failures-- > 0) return Promise.reject(new Error('composer refused'));
        return Promise.resolve(editsSaying(input.tick.turns.map((t) => t.text).join(' | ')));
      },
    };
    const session = beginNotesSession(
      {
        composer,
        quietMs: 1000,
        schedule,
        onNotes: (u) => {
          updates.push(u);
        },
        onError: (m) => errors.push(m),
      },
      ids,
    );
    session.onTurn({ turn: 0, text: 'Lost?', final: true });
    schedule.fire();
    await Promise.resolve();
    session.onTurn({ turn: 1, text: 'Found.', final: true });
    await session.end();
    // The reason, now prefixed with which meeting and which tick — a bare
    // reason names none of the meetings that might be running.
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('composer refused');
    expect(errors[0]).toContain('tick 1');
    expect(updates.length).toBe(1);
    // The failed tick's words rode the next one — nothing dropped.
    expect(composedMarkdown(updates[0]!)).toBe('Lost? | Found.');
  });

  it('words held by a failure with no later pause still compose at end()', async () => {
    const schedule = new ManualScheduler();
    const updates: NotesUpdate[] = [];
    let failures = 1;
    const composer: NotesComposer = {
      name: 'flaky-stub',
      compose(input) {
        if (failures-- > 0) return Promise.reject(new Error('composer refused'));
        return Promise.resolve(editsSaying(input.tick.turns.map((t) => t.text).join(' | ')));
      },
    };
    const session = beginNotesSession(
      {
        composer,
        quietMs: 1000,
        schedule,
        onNotes: (u) => {
          updates.push(u);
        },
      },
      ids,
    );
    session.onTurn({ turn: 0, text: 'Almost lost.', final: true });
    schedule.fire();
    await session.end();
    expect(updates.length).toBe(1);
    expect(composedMarkdown(updates[0]!)).toBe('Almost lost.');
    expect(updates[0]?.tick.reason).toBe('end');
  });

  it('hands the project context through to the composer untouched', async () => {
    const schedule = new ManualScheduler();
    const inputs: NotesComposeInput[] = [];
    const composer: NotesComposer = {
      name: 'spy-stub',
      compose(input) {
        inputs.push(input);
        return Promise.resolve(editsSaying('n'));
      },
    };
    const context = { repoRoot: '/repo', docPaths: ['docs/product/vision.md'] };
    const session = beginNotesSession(
      { composer, quietMs: 1000, schedule, context, onNotes: () => {} },
      ids,
    );
    session.onTurn({ turn: 0, text: 'Hi.', final: true });
    await session.end();
    expect(inputs[0]?.context).toEqual(context);
  });
});

describe('notes through the audio socket', () => {
  let handle: ServerHandle;
  let dataDir: string;
  const schedule = new ManualScheduler();
  const updates: NotesUpdate[] = [];
  /** What the composer was HANDED — the server resolves context per meeting. */
  const composed: NotesComposeInput[] = [];

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'cw-meeting-notes-'));
    const stub = createStubNotesComposer();
    handle = createServer({
      port: 0,
      dataDir,
      transcription: createMockTranscriptionEngine(),
      meetingNotes: {
        composer: {
          name: stub.name,
          compose(input) {
            composed.push(input);
            return stub.compose(input);
          },
        },
        quietMs: 1000,
        schedule,
        onNotes: (u) => {
          updates.push(u);
        },
      },
    });
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('a real meeting pauses into a tick and flushes the tail at stop', async () => {
    const base = `http://127.0.0.1:${handle.port}`;
    WS = await seedBoard(base);
    const path = join(dataDir, 'planning.md');
    writeFileSync(path, '# planning\n');
    const res = await fetch(`${base}/workspaces/${WS}/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docId: 'planning', sourceUrl: path, title: 'planning' }),
    });
    expect(res.status).toBe(200);

    const ws = new WebSocket(`ws://127.0.0.1:${handle.port}${meetingSocketPath(WS, 'planning')}`);
    ws.binaryType = 'arraybuffer';
    const frames: { type: string; final?: boolean; text?: string }[] = [];
    ws.addEventListener('message', (ev) => {
      frames.push(JSON.parse(ev.data as string) as (typeof frames)[number]);
    });
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', () => reject(new Error('audio socket refused')));
    });
    const waitFor = async (pred: () => boolean, what: string): Promise<void> => {
      const deadline = Date.now() + 2000;
      while (!pred()) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 10));
      }
    };

    ws.send(
      JSON.stringify({
        type: 'start',
        sampleRate: MEETING_SAMPLE_RATE,
        encoding: MEETING_AUDIO_ENCODING,
      }),
    );
    await waitFor(() => frames.some((f) => f.type === 'ready'), 'ready');
    // Seven chunks settle the mock's first turn (six words, then the settle).
    for (let i = 0; i < 7; i++) ws.send(new Uint8Array(640));
    await waitFor(() => frames.some((f) => f.type === 'transcript' && f.final), 'a settled turn');
    schedule.fire(); // the speaker goes quiet
    await waitFor(() => updates.length === 1, 'the pause tick');
    expect(updates[0]?.tick.reason).toBe('pause');
    expect(composedMarkdown(updates[0]!)).toContain('So the sync is the bottleneck.');

    // Half the second turn, then stop mid-sentence: the tail still composes.
    for (let i = 0; i < 3; i++) ws.send(new Uint8Array(640));
    ws.send(JSON.stringify({ type: 'stop' }));
    await waitFor(() => frames.some((f) => f.type === 'stopped'), 'stopped');
    await waitFor(() => updates.length === 2, 'the end tick');
    expect(updates[1]?.tick.reason).toBe('end');
    // WHAT CHANGED, AND IT IS THE POINT OF THE REBUILD. The second tick used
    // to RE-SEND the first tick's words — the whole section came back each
    // time and replaced what was there. It now sends only what this tick
    // added, addressed under the heading the first tick opened, and the
    // earlier bullet stays in the doc untouched. So the assertion inverts:
    // tick two must NOT carry tick one's words. That the earlier bullet is
    // still in the doc is the next test.
    expect(composedMarkdown(updates[1]!)).not.toContain('So the sync is the bottleneck.');
    expect(composedMarkdown(updates[1]!).length).toBeGreaterThan(0);
    ws.close();
  });

  it('the composed notes are IN the doc, as a replaceable named section', () => {
    const doc = handle.docStore.get('planning');
    expect(doc).toBeDefined();
    const md = prose.serializeFragmentToMarkdown(prose.getProseFragment(doc!.ydoc));
    // The end tick's notes replaced the pause tick's — one section, current.
    expect(md.split('## Meeting notes').length).toBe(2);
    expect(md).toContain('So the sync is the bottleneck.');
    expect(md).toContain('# planning'); // the doc's own content survived
  });

  it('the composer was handed the doc as context, not a bare transcript', () => {
    expect(composed.length).toBeGreaterThan(0);
    expect(composed[0]?.context?.docTitle).toBe('planning');
  });
});

describe('task capture riding the notes session', () => {
  const ids = { docId: 'doc-c', meetingId: 'm-doc-c-1' };

  it('runs per tick and sees the settled words', async () => {
    const schedule = new ManualScheduler();
    const captured: Array<{ docId: string; turns: string[] }> = [];
    const session = beginNotesSession(
      {
        composer: createStubNotesComposer(),
        quietMs: 1000,
        schedule,
        onNotes: () => {},
        captureIntents: (input) => {
          captured.push({ docId: input.docId, turns: input.turns.map((t) => t.text) });
          return Promise.resolve({ tasks: [], docs: [] });
        },
      },
      ids,
    );
    session.onTurn({ turn: 0, text: 'We should file a ticket for the strip.', final: true });
    schedule.fire();
    await session.end();
    expect(captured).toEqual([
      { docId: 'doc-c', turns: ['We should file a ticket for the strip.'] },
    ]);
  });

  it('hands each pass the previous tick’s words, under any name given since', async () => {
    // The boundary case: an ask spoken across two ticks. The second pass has
    // to see the first tick's speech or it is reading a pointer with nothing
    // to point at — and it must see it under the name the voice has NOW.
    const schedule = new ManualScheduler();
    const passes: Array<{ turns: string[]; prior: string[] }> = [];
    const session = beginNotesSession(
      {
        composer: createStubNotesComposer(),
        quietMs: 1000,
        schedule,
        onNotes: () => {},
        captureIntents: (input) => {
          passes.push({
            turns: input.turns.map((t) => `${t.speaker ?? '?'}: ${t.text}`),
            prior: input.priorTurns.map((t) => `${t.speaker ?? '?'}: ${t.text}`),
          });
          return Promise.resolve({ tasks: [], docs: [] });
        },
      },
      ids,
    );
    // A second voice, heard only as a partial: tags and speaker names are
    // suppressed until the session is genuinely multi-speaker (owner's call,
    // 2026-08-31), and a partial registers the voice without adding a turn.
    session.onTurn({ turn: 90, text: 'mm', final: false, speaker: 'Z' });
    session.onTurn({
      turn: 0,
      text: 'That retry loop is the real cost.',
      final: true,
      speaker: 'A',
    });
    schedule.fire();
    await Promise.resolve();
    session.nameSpeaker('A', 'Priya');
    session.onTurn({ turn: 1, text: 'File a ticket for that one.', final: true, speaker: 'A' });
    schedule.fire();
    await session.end();
    // TWO passes, not three, and the reason is the merge: the first pass is
    // still in flight when the second tick and the stop both fire, so those
    // two become one tick and one pass. That is the whole point of merging —
    // words that arrive while the composer is busy go into the NEXT compose
    // rather than into a queue of composes behind it — and the boundary this
    // test is about survives it, because the merged pass still sees the
    // first tick's line as its prior window.
    expect(passes).toHaveLength(2);
    // Nothing came before the first tick.
    expect(passes[0]?.prior).toEqual([]);
    expect(passes[0]?.turns).toEqual(['Speaker A: That retry loop is the real cost.']);
    // The second pass sees the first tick's line, mapped through the rename
    // that landed in between — raw labels are kept and mapped at use, so the
    // window never reads "Speaker A" beside "Priya" for the same voice.
    expect(passes[1]?.prior).toEqual(['Priya: That retry loop is the real cost.']);
    // And it carries both the second tick's settled words and the sentence
    // that was still in progress at the stop, in that order.
    expect(passes[1]?.turns).toEqual(['Priya: File a ticket for that one.', 'Speaker Z: mm']);
  });

  it('links reach the composer, and a capture failure costs links, not notes', async () => {
    const schedule = new ManualScheduler();
    const inputs: NotesComposeInput[] = [];
    const errors: string[] = [];
    const updates: NotesUpdate[] = [];
    const composer: NotesComposer = {
      name: 'recording-stub',
      compose(input) {
        inputs.push(input);
        return Promise.resolve(editsSaying(`notes ${input.tick.tick}`));
      },
    };
    let calls = 0;
    const session = beginNotesSession(
      {
        composer,
        quietMs: 1000,
        schedule,
        onNotes: (u) => {
          updates.push(u);
        },
        onError: (m) => errors.push(m),
        captureIntents: () => {
          calls++;
          if (calls === 1) {
            return Promise.resolve({
              tasks: [
                { title: 'Strip overlaps navbar', url: '/workspaces/w-b?task=t-9', status: 'todo' },
              ],
              docs: [
                {
                  title: 'Huddle 2026-08-24 14:05',
                  url: '/workspaces/w-b/docs/d-h',
                  when: 'last week',
                },
              ],
            });
          }
          return Promise.reject(new Error('capture refused'));
        },
      },
      ids,
    );
    session.onTurn({ turn: 0, text: 'File a ticket for the strip.', final: true });
    schedule.fire();
    await Promise.resolve();
    session.onTurn({ turn: 1, text: 'Moving on.', final: true });
    await session.end();
    // Tick 1 carried its captured link into the compose input.
    expect(inputs[0]?.taskLinks).toEqual([
      { title: 'Strip overlaps navbar', url: '/workspaces/w-b?task=t-9', status: 'todo' },
    ]);
    expect(inputs[0]?.docLinks).toEqual([
      { title: 'Huddle 2026-08-24 14:05', url: '/workspaces/w-b/docs/d-h', when: 'last week' },
    ]);
    // Tick 2's capture failed: the notes still composed, linkless, and the
    // failure was reported rather than swallowed.
    expect(inputs[1]?.taskLinks).toBeUndefined();
    expect(inputs[1]?.docLinks).toBeUndefined();
    expect(updates.map(composedMarkdown)).toEqual(['notes 1', 'notes 2']);
    expect(errors).toEqual(['capture refused']);
  });
});

describe('the composer reads the LIVE doc, not only its own last answer', () => {
  const ids = { docId: 'doc-live', meetingId: 'm-live' };

  /** An outline entry, spelled as the doc's reader hands one over. */
  const block = (id: string, text: string, author?: string): prose.OutlineEntry => ({
    id,
    kind: 'listItem',
    nodeName: 'listItem',
    text,
    ...(author !== undefined ? { author } : {}),
  });

  it('the outline is the doc as it now reads, and a person’s lines are named', async () => {
    const schedule = new ManualScheduler();
    const inputs: NotesComposeInput[] = [];
    const composer: NotesComposer = {
      name: 'capture',
      compose(input) {
        inputs.push(input);
        return Promise.resolve(editsSaying('## Meeting notes\n\n- composed'));
      },
    };
    let read = 0;
    const session = beginNotesSession(
      {
        composer,
        quietMs: 1000,
        schedule,
        // Empty before the first tick has written anything; after that, the
        // agent's bullet AND a line the person typed beside it.
        readOutline: () =>
          read++ === 0
            ? []
            : [block('b1', 'composed', 'meeting-notes'), block('b2', 'typed by hand')],
        onNotes: () => {},
      },
      ids,
    );
    session.onTurn({ turn: 0, text: 'First.', final: true });
    schedule.fire();
    session.onTurn({ turn: 1, text: 'Second.', final: true });
    await session.end();
    expect(inputs[0]?.outline).toEqual([]);
    // Tick two reads the doc: not the composer's own last answer, but what
    // the doc now holds — the person's line included, addressable by id.
    expect(inputs[1]?.outline.map((e) => e.id)).toEqual(['b1', 'b2']);
    expect(outlineText(inputs[1])).toBe('composed\ntyped by hand');

    // WHAT CHANGED, AND WHY IT IS SAFE. `humanNotes` used to be withheld on
    // tick one, because the section might still hold the LAST meeting's notes
    // and telling a from-scratch compose to reproduce them verbatim would
    // copy them into these ones. There is no such gate now and none is
    // needed: a previous meeting's bullets carry this agent's authorship, so
    // they are not somebody's lines — only actually-unowned blocks are.
    expect(inputs[0]?.humanNotes).toBeUndefined();
    expect(inputs[1]?.humanNotes).toEqual(['typed by hand']);
  });

  it('a previous meeting’s notes are not read as the person’s, on any tick', async () => {
    // The control for the removed gate: an outline that already holds the
    // last meeting's bullet, present from tick ONE, and the compose is not
    // told a person wrote it.
    const schedule = new ManualScheduler();
    const inputs: NotesComposeInput[] = [];
    const session = beginNotesSession(
      {
        composer: {
          name: 'capture',
          compose(input) {
            inputs.push(input);
            return Promise.resolve([]);
          },
        },
        quietMs: 1000,
        schedule,
        readOutline: () => [block('old', 'last meeting’s bullet', 'meeting-notes')],
        onNotes: () => {},
      },
      ids,
    );
    session.onTurn({ turn: 0, text: 'First.', final: true });
    await session.end();
    expect(inputs[0]?.outline).toHaveLength(1);
    expect(inputs[0]?.humanNotes).toBeUndefined();
  });

  it('the heading this meeting writes under is asked for per tick, with the outline', async () => {
    // Replaces the old `basedOn` assertion. The update used to carry the
    // items the compose had read so the sink could withhold a change to a
    // line that had moved underneath it; block ids do that structurally now
    // (an edit naming a vanished block is refused on its own). What is left
    // at THIS seam is that the heading id is resolved fresh each tick,
    // against the outline that tick read — so a section a person renamed is
    // still found, and a section they deleted is re-opened.
    const schedule = new ManualScheduler();
    const asked: Array<readonly string[]> = [];
    const inputs: NotesComposeInput[] = [];
    const outlines = [[block('h1', 'Meeting notes', 'meeting-notes')], [block('h2', 'Renamed')]];
    let call = 0;
    const session = beginNotesSession(
      {
        composer: {
          name: 's',
          compose(input) {
            inputs.push(input);
            return Promise.resolve(editsSaying('- n'));
          },
        },
        quietMs: 1000,
        schedule,
        readOutline: () => outlines[Math.min(call++, outlines.length - 1)]!,
        notesHeadingId: ({ outline }) => {
          asked.push(outline.map((e) => e.id));
          return outline[0]?.id;
        },
        onNotes: () => {},
      },
      ids,
    );
    session.onTurn({ turn: 0, text: 'First.', final: true });
    schedule.fire();
    session.onTurn({ turn: 1, text: 'Second.', final: true });
    await session.end();
    expect(asked).toEqual([['h1'], ['h2']]);
    expect(inputs.map((i) => i.notesHeadingId)).toEqual(['h1', 'h2']);
  });

  it('an outline that cannot be read costs the tick its awareness, never its notes', async () => {
    const schedule = new ManualScheduler();
    const updates: NotesUpdate[] = [];
    const errors: string[] = [];
    const session = beginNotesSession(
      {
        composer: { name: 's', compose: async () => editsSaying('notes') },
        quietMs: 1000,
        schedule,
        readOutline: () => {
          throw new Error('doc gone');
        },
        onNotes: (u) => {
          updates.push(u);
        },
        onError: (m) => errors.push(m),
      },
      ids,
    );
    session.onTurn({ turn: 0, text: 'First.', final: true });
    await session.end();
    expect(updates.length).toBe(1);
    expect(composedMarkdown(updates[0]!)).toBe('notes');
    expect(errors).toEqual(['doc gone']);
  });
});

describe('inline speaker tags', () => {
  const ids = { docId: 'doc-tags', meetingId: 'm-tags' };

  /** A composer that returns whatever the test hands it, and records what it
   *  was given. */
  const scripted = (replies: string[], inputs: NotesComposeInput[]): NotesComposer => ({
    name: 'scripted',
    compose(input) {
      inputs.push(input);
      return Promise.resolve(editsSaying(replies.shift() ?? '## Meeting notes'));
    },
  });

  it('hands the composer the label beside the name, so it can tag the mention', async () => {
    const schedule = new ManualScheduler();
    const inputs: NotesComposeInput[] = [];
    const session = beginNotesSession(
      { composer: scripted([], inputs), quietMs: 1000, schedule, onNotes: () => {} },
      ids,
    );
    // A second voice, heard only as a partial: tags and speaker names are
    // suppressed until the session is genuinely multi-speaker (owner's call,
    // 2026-08-31), and a partial registers the voice without adding a turn.
    session.onTurn({ turn: 90, text: 'mm', final: false, speaker: 'Z' });
    session.onTurn({ turn: 0, text: 'Move the gate.', final: true, speaker: 'B' });
    await session.end();
    expect(inputs[0]?.tick.turns[0]).toMatchObject({
      speaker: 'Speaker B',
      speakerLabel: 'B',
    });
  });

  it('a turn with no voice carries no label either', async () => {
    const schedule = new ManualScheduler();
    const inputs: NotesComposeInput[] = [];
    const session = beginNotesSession(
      { composer: scripted([], inputs), quietMs: 1000, schedule, onNotes: () => {} },
      ids,
    );
    session.onTurn({ turn: 0, text: 'Move the gate.', final: true });
    await session.end();
    expect(inputs[0]?.tick.turns[0]?.speakerLabel).toBeUndefined();
    expect(inputs[0]?.tick.turns[0]?.speaker).toBeUndefined();
  });

  it('re-renders a tag from the name map rather than trusting the model to spell it', async () => {
    const schedule = new ManualScheduler();
    const inputs: NotesComposeInput[] = [];
    const updates: NotesUpdate[] = [];
    const session = beginNotesSession(
      {
        composer: scripted(
          ['## Meeting notes\n\n- [@speaker b](speaker:B) wants the gate moved.'],
          inputs,
        ),
        quietMs: 1000,
        schedule,
        onNotes: (u) => {
          updates.push(u);
        },
      },
      ids,
    );
    // A second voice, heard only as a partial: tags and speaker names are
    // suppressed until the session is genuinely multi-speaker (owner's call,
    // 2026-08-31), and a partial registers the voice without adding a turn.
    session.onTurn({ turn: 90, text: 'mm', final: false, speaker: 'Z' });
    session.onTurn({ turn: 0, text: 'Move the gate.', final: true, speaker: 'B' });
    await session.end();
    expect(composedMarkdown(updates[0]!)).toContain(
      '[@Speaker B](speaker:B?t=0) wants the gate moved.',
    );
  });

  it('drops a tag naming a voice the meeting never carried, and says so', async () => {
    // The deterministic gate on a model-made claim. The note's words stay;
    // the attribution — the only part that was invented — goes, and so does
    // the NAME, which is the whole of what a reader would have seen.
    const schedule = new ManualScheduler();
    const inputs: NotesComposeInput[] = [];
    const updates: NotesUpdate[] = [];
    const errors: string[] = [];
    const session = beginNotesSession(
      {
        composer: scripted(
          ['## Meeting notes\n\n- [@Priya](speaker:C) volunteered to run it.'],
          inputs,
        ),
        quietMs: 1000,
        schedule,
        onNotes: (u) => {
          updates.push(u);
        },
        onError: (m) => errors.push(m),
      },
      ids,
    );
    session.onTurn({ turn: 0, text: 'Somebody should run it.', final: true, speaker: 'B' });
    await session.end();
    expect(composedMarkdown(updates[0]!)).toContain('- Volunteered to run it.');
    expect(composedMarkdown(updates[0]!)).not.toContain('Priya');
    expect(composedMarkdown(updates[0]!)).not.toContain('speaker:C');
    expect(errors.join(' ')).toContain('no such voice');
  });

  it('a tag survives normalization on every tick, not just the one that wrote it', async () => {
    // The positive control for the gate above: a tag for a voice the meeting
    // DID carry is left alone and gains its `?t=`, on the second tick as on
    // the first.
    //
    // WHAT CHANGED. This used to read the round trip off `input.previous` —
    // the composer's own last answer, held in this module. There is no such
    // memory; the words go to the doc and the next tick reads the doc. So the
    // assertion is on what each tick WROTE. The round trip through a real doc
    // is `notetaker-behaviour.test.ts`.
    const schedule = new ManualScheduler();
    const inputs: NotesComposeInput[] = [];
    const updates: NotesUpdate[] = [];
    const session = beginNotesSession(
      {
        composer: scripted(
          [
            '## Meeting notes\n\n- [@Speaker B](speaker:B) wants the gate moved.',
            '- [@Speaker B](speaker:B) wants the gate moved, by Friday.',
          ],
          inputs,
        ),
        quietMs: 1000,
        schedule,
        onNotes: (u) => {
          updates.push(u);
        },
      },
      ids,
    );
    // A second voice, heard only as a partial: tags and speaker names are
    // suppressed until the session is genuinely multi-speaker (owner's call,
    // 2026-08-31), and a partial registers the voice without adding a turn.
    session.onTurn({ turn: 90, text: 'mm', final: false, speaker: 'Z' });
    session.onTurn({ turn: 0, text: 'Move the gate.', final: true, speaker: 'B' });
    schedule.fire();
    await new Promise((r) => setTimeout(r, 0));
    session.onTurn({ turn: 1, text: 'By Friday.', final: true, speaker: 'B' });
    await session.end();
    expect(composedMarkdown(updates[0]!)).toContain('[@Speaker B](speaker:B?t=0)');
    expect(composedMarkdown(updates[1]!)).toContain('[@Speaker B](speaker:B?t=1)');
  });

  it('a rename names the label to the sink, and the next tick composes under it', async () => {
    // WHAT CHANGED. The old title was "rewrites the tags in the session
    // memory and names the label to the sink", and it asserted both halves
    // here. The memory is gone: the rewrite of words ALREADY WRITTEN is the
    // doc's, and `meeting-notes-doc.test.ts` "applyNotesRelabel" holds it —
    // including the sweep-order case (Devi → Devi Raman without "Raman
    // Raman") that used to have a copy in this file.
    //
    // What is still this module's, and is what remains here: it decides the
    // rename happened, addresses it by ENGINE LABEL with the display name it
    // had been using, and composes under the new name from the next tick on.
    const schedule = new ManualScheduler();
    const inputs: NotesComposeInput[] = [];
    const relabels: NotesRelabel[] = [];
    const session = beginNotesSession(
      {
        composer: scripted(
          ['## Meeting notes\n\n- [@Speaker B](speaker:B) wants the gate moved.', '- more'],
          inputs,
        ),
        quietMs: 1000,
        schedule,
        onNotes: () => {},
        onRelabel: (r) => relabels.push(r),
      },
      ids,
    );
    // A second voice, heard only as a partial: tags and speaker names are
    // suppressed until the session is genuinely multi-speaker (owner's call,
    // 2026-08-31), and a partial registers the voice without adding a turn.
    session.onTurn({ turn: 90, text: 'mm', final: false, speaker: 'Z' });
    session.onTurn({ turn: 0, text: 'Move the gate.', final: true, speaker: 'B' });
    schedule.fire();
    await new Promise((r) => setTimeout(r, 0));
    session.nameSpeaker('B', 'Devi');
    session.onTurn({ turn: 1, text: 'By Friday.', final: true, speaker: 'B' });
    await session.end();

    expect(relabels[0]).toMatchObject({ label: 'B', from: 'Speaker B', to: 'Devi' });
    expect(inputs[0]?.tick.turns[0]?.speaker).toBe('Speaker B');
    expect(inputs[1]?.tick.turns[0]?.speaker).toBe('Devi');
  });

  it('leaves a line the person wrote exactly as they wrote it', async () => {
    // The composer is asked to reproduce their line verbatim and the merge
    // recognises it by exact text. Normalizing a tag inside it would break
    // that match and land a second copy of their own note beside it.
    const schedule = new ManualScheduler();
    const inputs: NotesComposeInput[] = [];
    const updates: NotesUpdate[] = [];
    const mine = '[@speaker b](speaker:B) — my own wording';
    const session = beginNotesSession(
      {
        composer: scripted(
          [
            '## Meeting notes\n\n- notes',
            `## Meeting notes\n\n- ${mine}\n- [@speaker b](speaker:B) said it.`,
          ],
          inputs,
        ),
        quietMs: 1000,
        schedule,
        readOutline: () => [{ id: 'b-mine', kind: 'listItem', nodeName: 'listItem', text: mine }],
        onNotes: (u) => {
          updates.push(u);
        },
      },
      ids,
    );
    // A second voice, heard only as a partial: tags and speaker names are
    // suppressed until the session is genuinely multi-speaker (owner's call,
    // 2026-08-31), and a partial registers the voice without adding a turn.
    session.onTurn({ turn: 90, text: 'mm', final: false, speaker: 'Z' });
    session.onTurn({ turn: 0, text: 'One.', final: true, speaker: 'B' });
    schedule.fire();
    await new Promise((r) => setTimeout(r, 0));
    session.onTurn({ turn: 1, text: 'Two.', final: true, speaker: 'B' });
    await session.end();
    expect(composedMarkdown(updates[1]!)).toContain(`- ${mine}`);
    expect(composedMarkdown(updates[1]!)).toContain('- [@Speaker B](speaker:B?t=1) said it.');
  });
});

describe('a tagged meeting through the audio socket', () => {
  let handle: ServerHandle;
  let dataDir: string;
  const schedule = new ManualScheduler();
  const updates: NotesUpdate[] = [];

  /** Two voices, so a rename has something it must NOT touch. */
  const script = [
    { words: ['move', 'the', 'gate'], settled: 'Move the gate.', speaker: 'A' },
    { words: ['not', 'before', 'friday'], settled: 'Not before Friday.', speaker: 'B' },
  ];

  /** Writes one tagged bullet per new turn, the way the real composer is
   *  asked to. Everything downstream of the model is under test here; what
   *  the model would have produced is not. */
  const taggingComposer: NotesComposer = {
    name: 'tagging',
    compose(input) {
      const bullets = input.tick.turns.map(
        (t) => `- [@${t.speaker}](speaker:${t.speakerLabel}) said "${t.text}"`,
      );
      const headingId = input.notesHeadingId;
      return Promise.resolve(
        headingId === undefined
          ? editsSaying(['## Meeting notes', '', ...bullets].join('\n'))
          : [{ op: 'insert_under_heading', headingId, markdown: bullets.join('\n') }],
      );
    },
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'cw-meeting-tags-'));
    handle = createServer({
      port: 0,
      dataDir,
      transcription: createMockTranscriptionEngine(script),
      meetingNotes: {
        composer: taggingComposer,
        quietMs: 1000,
        schedule,
        onNotes: (u) => {
          updates.push(u);
        },
      },
    });
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('writes tags into the doc, and a rename moves one voice and not the other', async () => {
    const base = `http://127.0.0.1:${handle.port}`;
    WS = await seedBoard(base);
    const path = join(dataDir, 'huddle.md');
    writeFileSync(path, '# huddle\n');
    const res = await fetch(`${base}/workspaces/${WS}/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docId: 'huddle', sourceUrl: path, title: 'huddle' }),
    });
    expect(res.status).toBe(200);

    const ws = new WebSocket(`ws://127.0.0.1:${handle.port}${meetingSocketPath(WS, 'huddle')}`);
    ws.binaryType = 'arraybuffer';
    const frames: { type: string; final?: boolean; mode?: string }[] = [];
    ws.addEventListener('message', (ev) => {
      frames.push(JSON.parse(ev.data as string) as (typeof frames)[number]);
    });
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', () => reject(new Error('audio socket refused')));
    });
    const waitFor = async (pred: () => boolean, what: string): Promise<void> => {
      const deadline = Date.now() + 2000;
      while (!pred()) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 10));
      }
    };
    const docMarkdown = (): string =>
      prose.serializeFragmentToMarkdown(
        prose.getProseFragment(handle.docStore.get('huddle')!.ydoc),
      );

    // A conversation, explicitly. Since #501 diarization is opt-in per
    // capture and solo is the default, so a capture that does not ask gets
    // no speaker labels — and a note with no voice has nothing to tag.
    ws.send(
      JSON.stringify({
        type: 'start',
        sampleRate: MEETING_SAMPLE_RATE,
        encoding: MEETING_AUDIO_ENCODING,
        mode: 'conversation',
      }),
    );
    await waitFor(() => frames.some((f) => f.type === 'ready'), 'ready');
    // The mode the SERVER opened, not the one asked for: every tag below is
    // only meaningful if diarization actually reached the engine.
    expect(frames.find((f) => f.type === 'ready')?.mode).toBe('conversation');
    // Both turns settle: four chunks each (three words, then the settle).
    for (let i = 0; i < 8; i++) ws.send(new Uint8Array(640));
    await waitFor(
      () => frames.filter((f) => f.type === 'transcript' && f.final).length === 2,
      'both settled turns',
    );
    schedule.fire();
    await waitFor(() => updates.length === 1, 'the pause tick');

    // 1. The notes in the DOC carry a tag per mention, one per voice.
    const tagged = docMarkdown();
    // Each tag also carries the turn it was composed from, which is what a
    // later engine revision of who spoke has to aim at.
    expect(tagged).toContain('[@Speaker A](speaker:A?t=0) said "Move the gate."');
    expect(tagged).toContain('[@Speaker B](speaker:B?t=1) said "Not before Friday."');

    // 2. Naming a voice renames its tags where they already stand — the
    //    label, not the words, is what the rename matched on.
    ws.send(JSON.stringify({ type: 'name_speaker', speaker: 'A', name: 'Dana' }));
    await waitFor(
      () => docMarkdown().includes('[@Dana](speaker:A?t=0)'),
      'the rename to reach the tag already written',
    );
    const renamed = docMarkdown();
    // The rename moved the NAME and left the provenance exactly where it was.
    expect(renamed).toContain('[@Dana](speaker:A?t=0) said "Move the gate."');
    // 3. And the other voice is untouched: it was never this label.
    expect(renamed).toContain('[@Speaker B](speaker:B?t=1) said "Not before Friday."');
    expect(renamed).not.toContain('speaker:A) said "Not before Friday."');

    // 4. THE DISCRIMINATOR. Everything above would also pass on the old
    //    text-only rewrite, because the tag's own text spelled "Speaker A".
    //    So: call the second voice Dana as well, then correct the first to
    //    "Dana Ruiz". Now the words "Dana" name two voices, the untagged
    //    sweep is switched off, and only a rename keyed on the LABEL can
    //    reach anything at all.
    ws.send(JSON.stringify({ type: 'name_speaker', speaker: 'B', name: 'Dana' }));
    await waitFor(
      () => docMarkdown().includes('[@Dana](speaker:B?t=1)'),
      'the second voice to take the same name',
    );
    ws.send(JSON.stringify({ type: 'name_speaker', speaker: 'A', name: 'Dana Ruiz' }));
    await waitFor(
      () => docMarkdown().includes('[@Dana Ruiz](speaker:A?t=0)'),
      'the ambiguous correction to reach the tag it belongs to',
    );
    const corrected = docMarkdown();
    // The other Dana kept her tag. A text sweep for "Dana" would have taken
    // this one too — that it did not is the proof the label did the work.
    expect(corrected).toContain('[@Dana](speaker:B?t=1) said "Not before Friday."');

    ws.send(JSON.stringify({ type: 'stop' }));
    await waitFor(() => frames.some((f) => f.type === 'stopped'), 'stopped');
    ws.close();
  });
});

describe('a spoken correction riding the notes session', () => {
  const ids = { docId: 'doc-fix', meetingId: 'm-doc-fix-1' };

  it('reaches the doc BEFORE the section is read for the compose', async () => {
    // Ordering is the whole design: the note being corrected was written on
    // an earlier tick and is already in the doc, so the correction lands
    // first and this tick's compose reads the corrected words off the doc.
    // Land it after the compose instead and the composer echoes the old
    // wording back, and the merge has to fight over which one wins.
    const schedule = new ManualScheduler();
    const order: string[] = [];
    const session = beginNotesSession(
      {
        composer: {
          name: 'recording-stub',
          compose: () => {
            order.push('compose');
            return Promise.resolve(editsSaying('## Meeting notes\n\n- noted'));
          },
        },
        quietMs: 1000,
        schedule,
        onNotes: () => {
          order.push('write');
        },
        readOutline: () => {
          order.push('read');
          return [];
        },
        captureIntents: () =>
          Promise.resolve({
            tasks: [],
            docs: [],
            corrections: [{ wrong: 'Tuesday', right: 'Thursday' }],
          }),
        onCorrection: (c) => {
          order.push(`correct ${c.wrong}->${c.right}`);
          return 'revised';
        },
      },
      ids,
    );
    session.onTurn({ turn: 0, text: 'No, I said Thursday.', final: true });
    schedule.fire();
    await session.end();
    expect(order).toEqual(['correct Tuesday->Thursday', 'read', 'compose', 'write']);
  });

  it('carries the meeting’s ids so the sink knows which doc to correct', async () => {
    const schedule = new ManualScheduler();
    const seen: NotesCorrection[] = [];
    const session = beginNotesSession(
      {
        composer: createStubNotesComposer(),
        quietMs: 1000,
        schedule,
        onNotes: () => {},
        captureIntents: () =>
          Promise.resolve({
            tasks: [],
            docs: [],
            corrections: [{ wrong: 'Tuesday', right: 'Thursday' }],
          }),
        onCorrection: (c) => {
          seen.push(c);
          return 'revised';
        },
      },
      ids,
    );
    session.onTurn({ turn: 0, text: 'No, I said Thursday.', final: true });
    schedule.fire();
    await session.end();
    expect(seen).toEqual([
      { docId: 'doc-fix', meetingId: 'm-doc-fix-1', wrong: 'Tuesday', right: 'Thursday' },
    ]);
  });

  it('a sink that throws costs the correction, never the tick’s notes', async () => {
    const schedule = new ManualScheduler();
    const updates: NotesUpdate[] = [];
    const errors: string[] = [];
    const session = beginNotesSession(
      {
        composer: createStubNotesComposer(),
        quietMs: 1000,
        schedule,
        onNotes: (u) => {
          updates.push(u);
        },
        onError: (m) => errors.push(m),
        captureIntents: () =>
          Promise.resolve({
            tasks: [],
            docs: [],
            corrections: [{ wrong: 'Tuesday', right: 'Thursday' }],
          }),
        onCorrection: () => {
          throw new Error('doc write refused');
        },
      },
      ids,
    );
    session.onTurn({ turn: 0, text: 'No, I said Thursday.', final: true });
    schedule.fire();
    await session.end();
    expect(errors).toContain('doc write refused');
    expect(updates).toHaveLength(1);
    expect(composedMarkdown(updates[0]!)).toContain('No, I said Thursday.');
  });

  it('a pass that returns no corrections asks the sink nothing', async () => {
    const schedule = new ManualScheduler();
    let calls = 0;
    const session = beginNotesSession(
      {
        composer: createStubNotesComposer(),
        quietMs: 1000,
        schedule,
        onNotes: () => {},
        captureIntents: () => Promise.resolve({ tasks: [], docs: [] }),
        onCorrection: () => {
          calls++;
          return 'none';
        },
      },
      ids,
    );
    session.onTurn({ turn: 0, text: 'Ordinary speech about the gate.', final: true });
    schedule.fire();
    await session.end();
    expect(calls).toBe(0);
  });
});

describe('a late speaker correction reaches notes already written', () => {
  const ids = { docId: 'doc-late', meetingId: 'm-late' };

  /** A composer that returns whatever the test hands it, and records what it
   *  was given. */
  const scripted = (replies: string[], inputs: NotesComposeInput[]): NotesComposer => ({
    name: 'scripted',
    compose(input) {
      inputs.push(input);
      return Promise.resolve(editsSaying(replies.shift() ?? '## Meeting notes'));
    },
  });

  /** Let the compose chain drain. Every step is a microtask on one promise
   *  chain, so a macrotask turn is enough for all of them. */
  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

  it('moves a mention when the engine revises the only turn behind it', async () => {
    const schedule = new ManualScheduler();
    const inputs: NotesComposeInput[] = [];
    const corrections: NotesReattribution[] = [];
    const session = beginNotesSession(
      {
        composer: scripted(
          [
            '## Meeting notes\n\n- [@Speaker B](speaker:B) wants the gate moved.',
            '## Meeting notes\n\n- more',
          ],
          inputs,
        ),
        quietMs: 1000,
        schedule,
        onNotes: () => {},
        onReattribute: (r) => corrections.push(r),
      },
      ids,
    );
    // A second voice, heard only as a partial: tags and speaker names are
    // suppressed until the session is genuinely multi-speaker (owner's call,
    // 2026-08-31), and a partial registers the voice without adding a turn.
    session.onTurn({ turn: 90, text: 'mm', final: false, speaker: 'Z' });
    session.onTurn({ turn: 0, text: 'Move the gate.', final: true, speaker: 'B' });
    schedule.fire();
    await settle();

    // The end-of-session pass: turn 0 was C, not B. Same turn id, same
    // words, a different voice — exactly how the adapter re-emits one.
    session.onTurn({ turn: 0, text: 'Move the gate.', final: true, speaker: 'C' });
    await settle();

    expect(corrections).toHaveLength(1);
    expect([...corrections[0]!.revisions]).toEqual([[0, 'C']]);

    session.onTurn({ turn: 1, text: 'By Friday.', final: true, speaker: 'C' });
    await session.end();
    // WHAT CHANGED. This used to also assert that the SESSION's mirror of
    // the notes had been rewritten. There is no mirror: the rewrite happens
    // in the doc, off this one payload — `meeting-notes-doc.test.ts`,
    // "moves a mention whose every turn moved the same way". What this seam
    // owes is the payload and the name to write, and that it is sent ONCE.
    // The names map carries only voices somebody has NAMED; C has not been
    // named, so the doc falls back to its "Speaker C" placeholder — which is
    // why the map is asserted for what it does not claim.
    expect(corrections[0]?.names.C).toBeUndefined();
    expect(corrections).toHaveLength(1);
    // And the next tick composes under the corrected voice by itself.
    expect(inputs[1]?.tick.turns[0]?.speaker).toBe('Speaker C');
  });

  it('takes the batch as one, so a mention whose turns all moved is moved', async () => {
    // The engine sends ONE SpeakerRevision naming every turn it changed its
    // mind about, and the adapter re-emits them in a synchronous loop.
    // Applying them one at a time would move this mention on the first and
    // then find it disagreeing with itself on the second.
    const schedule = new ManualScheduler();
    const inputs: NotesComposeInput[] = [];
    const corrections: NotesReattribution[] = [];
    const session = beginNotesSession(
      {
        composer: scripted(
          [
            '## Meeting notes\n\n- [@Speaker B](speaker:B) wants the gate moved.',
            '## Meeting notes\n\n- more',
          ],
          inputs,
        ),
        quietMs: 1000,
        schedule,
        onNotes: () => {},
        onReattribute: (r) => corrections.push(r),
      },
      ids,
    );
    // A second voice, heard only as a partial: tags and speaker names are
    // suppressed until the session is genuinely multi-speaker (owner's call,
    // 2026-08-31), and a partial registers the voice without adding a turn.
    session.onTurn({ turn: 90, text: 'mm', final: false, speaker: 'Z' });
    session.onTurn({ turn: 0, text: 'Move the gate.', final: true, speaker: 'B' });
    session.onTurn({ turn: 1, text: 'Before merge.', final: true, speaker: 'B' });
    schedule.fire();
    await settle();
    expect(inputs[0]).toBeDefined();

    session.onTurn({ turn: 0, text: 'Move the gate.', final: true, speaker: 'C' });
    session.onTurn({ turn: 1, text: 'Before merge.', final: true, speaker: 'C' });
    await settle();

    session.onTurn({ turn: 2, text: 'By Friday.', final: true, speaker: 'C' });
    await session.end();
    // ONE payload naming BOTH turns — the batch taken as one. Sent as two, a
    // mention riding both turns would be moved by the first and then found
    // disagreeing with itself by the second, and the doc would mark it
    // unsure. That the doc does the right thing with each shape is
    // `meeting-notes-doc.test.ts`; that it is handed one and not two is here.
    expect(corrections).toHaveLength(1);
    expect([...corrections[0]!.revisions]).toEqual([
      [0, 'C'],
      [1, 'C'],
    ]);
  });

  it('sends a partial batch as the partial batch it is, and guesses nothing', async () => {
    // WHAT CHANGED. The old title ended "and says so", and it asserted the
    // `unsure=1` marker plus an error line — both of which are now written by
    // the doc, off this payload (`meeting-notes-doc.test.ts`, "marks a
    // mention it cannot place rather than guessing between two voices").
    // The disagreement itself is made HERE, by sending the one turn that
    // moved and not inventing a verdict for the one that did not.
    const schedule = new ManualScheduler();
    const inputs: NotesComposeInput[] = [];
    const corrections: NotesReattribution[] = [];
    const session = beginNotesSession(
      {
        composer: scripted(
          [
            '## Meeting notes\n\n- [@Speaker B](speaker:B) wants the gate moved.',
            '## Meeting notes\n\n- more',
          ],
          inputs,
        ),
        quietMs: 1000,
        schedule,
        onNotes: () => {},
        onReattribute: (r) => corrections.push(r),
      },
      ids,
    );
    // A second voice, heard only as a partial: tags and speaker names are
    // suppressed until the session is genuinely multi-speaker (owner's call,
    // 2026-08-31), and a partial registers the voice without adding a turn.
    session.onTurn({ turn: 90, text: 'mm', final: false, speaker: 'Z' });
    session.onTurn({ turn: 0, text: 'Move the gate.', final: true, speaker: 'B' });
    session.onTurn({ turn: 1, text: 'Before merge.', final: true, speaker: 'B' });
    schedule.fire();
    await settle();

    // Only ONE of the two turns behind the mention moved.
    session.onTurn({ turn: 1, text: 'Before merge.', final: true, speaker: 'C' });
    await settle();

    session.onTurn({ turn: 2, text: 'By Friday.', final: true, speaker: 'C' });
    await session.end();
    expect(corrections).toHaveLength(1);
    expect([...corrections[0]!.revisions]).toEqual([[1, 'C']]);
    expect(inputs[1]).toBeDefined();
  });

  it('a turn still waiting on a tick is not a correction at all', async () => {
    // It composes under the new label by itself; nothing in the doc is
    // wrong yet, so nothing needs rewriting.
    const schedule = new ManualScheduler();
    const inputs: NotesComposeInput[] = [];
    const corrections: NotesReattribution[] = [];
    const session = beginNotesSession(
      {
        composer: scripted(['## Meeting notes\n\n- one'], inputs),
        quietMs: 1000,
        schedule,
        onNotes: () => {},
        onReattribute: (r) => corrections.push(r),
      },
      ids,
    );
    session.onTurn({ turn: 0, text: 'Move the gate.', final: true, speaker: 'B' });
    session.onTurn({ turn: 0, text: 'Move the gate.', final: true, speaker: 'C' });
    await session.end();
    expect(corrections).toHaveLength(0);
    expect(inputs[0]?.tick.turns[0]).toMatchObject({ speakerLabel: 'C' });
  });

  it('corrects a compose that was in flight when the revision arrived', async () => {
    // That compose read the old label and will return notes written the old
    // way. The correction is queued behind it on the same chain, so it lands
    // ON those notes rather than under them.
    const schedule = new ManualScheduler();
    const inputs: NotesComposeInput[] = [];
    const order: string[] = [];
    let release: () => void = () => {};
    const thinking = new Promise<void>((resolve) => {
      release = resolve;
    });
    const composer: NotesComposer = {
      name: 'deferred',
      async compose(input) {
        inputs.push(input);
        if (inputs.length === 1) {
          await thinking;
          order.push('composed');
          return editsSaying('## Meeting notes\n\n- [@Speaker B](speaker:B) wants the gate moved.');
        }
        return editsSaying('- more');
      },
    };
    const session = beginNotesSession(
      {
        composer,
        quietMs: 1000,
        schedule,
        onNotes: () => {},
        onReattribute: () => order.push('reattributed'),
      },
      ids,
    );
    // A second voice, heard only as a partial: tags and speaker names are
    // suppressed until the session is genuinely multi-speaker (owner's call,
    // 2026-08-31), and a partial registers the voice without adding a turn.
    session.onTurn({ turn: 90, text: 'mm', final: false, speaker: 'Z' });
    session.onTurn({ turn: 0, text: 'Move the gate.', final: true, speaker: 'B' });
    schedule.fire();
    await settle();
    expect(inputs).toHaveLength(1);

    // The revision arrives while the first compose is still thinking.
    session.onTurn({ turn: 0, text: 'Move the gate.', final: true, speaker: 'C' });
    release();
    await settle();

    session.onTurn({ turn: 1, text: 'By Friday.', final: true, speaker: 'C' });
    await session.end();
    // ORDER IS THE ASSERTION, and it is the same one as before by a different
    // route: the correction is queued behind the compose that was in flight,
    // so it lands ON those words rather than under them. It used to be read
    // off the session's mirror of the notes; there is no mirror, so it is
    // read off the sequence the sinks saw.
    expect(order).toEqual(['composed', 'reattributed']);
  });

  it('re-labels a carried turn instead of correcting words nobody has read', async () => {
    // The compose FAILED, so those words are not in the doc: they are in
    // `carry`, waiting for another attempt. Rewriting mentions of them would
    // find nothing; taking the new label into the retry is the whole fix.
    const schedule = new ManualScheduler();
    const inputs: NotesComposeInput[] = [];
    const corrections: NotesReattribution[] = [];
    let first = true;
    const composer: NotesComposer = {
      name: 'fails-once',
      compose(input) {
        inputs.push(input);
        if (first) {
          first = false;
          return Promise.reject(new Error('composer down'));
        }
        return Promise.resolve(
          editsSaying('## Meeting notes\n\n- [@Speaker C](speaker:C) wants the gate.'),
        );
      },
    };
    const session = beginNotesSession(
      {
        composer,
        quietMs: 1000,
        schedule,
        onNotes: () => {},
        onReattribute: (r) => corrections.push(r),
        onError: () => {},
      },
      ids,
    );
    session.onTurn({ turn: 0, text: 'Move the gate.', final: true, speaker: 'B' });
    schedule.fire();
    await settle();

    session.onTurn({ turn: 0, text: 'Move the gate.', final: true, speaker: 'C' });
    await settle();
    await session.end();

    expect(corrections).toHaveLength(0);
    // The retry composed the carried turn under the voice the revision gave it.
    expect(inputs[1]?.tick.turns[0]).toMatchObject({ turn: 0, speakerLabel: 'C' });
  });
});

describe('session start and tick lifecycle', () => {
  const ids = { docId: 'doc-lifecycle', meetingId: 'm-lifecycle' };

  it('announces the session before any tick can fire', async () => {
    const starts: Array<{ docId: string; meetingId: string }> = [];
    const session = beginNotesSession(
      {
        composer: createStubNotesComposer(),
        quietMs: 1000,
        schedule: new ManualScheduler(),
        onNotes: () => {},
        onSessionStart: (s) => starts.push(s),
      },
      ids,
    );
    // Synchronous, at construction — the release it triggers must be done
    // before the first compose reads the ledger.
    expect(starts).toEqual([{ docId: ids.docId, meetingId: ids.meetingId }]);
    await session.end();
  });

  it('a tick announces composing when it fires and written when it lands', async () => {
    const schedule = new ManualScheduler();
    const events: Array<{ phase: string; tick: number; turns: readonly number[] }> = [];
    const session = beginNotesSession(
      {
        composer: createStubNotesComposer(),
        quietMs: 1000,
        schedule,
        onNotes: () => {},
        onTickLifecycle: (e) => events.push({ phase: e.phase, tick: e.tick, turns: e.turns }),
      },
      ids,
    );
    session.onTurn({ turn: 0, text: 'One.', final: true });
    session.onTurn({ turn: 1, text: 'Two.', final: true });
    schedule.fire();
    await session.end();
    expect(events).toEqual([
      { phase: 'composing', tick: 1, turns: [0, 1] },
      { phase: 'written', tick: 1, turns: [0, 1] },
    ]);
  });

  it('a failed compose announces failed, and the retry carries its turns', async () => {
    const schedule = new ManualScheduler();
    const events: Array<{ phase: string; turns: readonly number[] }> = [];
    let calls = 0;
    const composer: NotesComposer = {
      name: 'flaky',
      compose(input) {
        calls++;
        if (calls === 1) return Promise.reject(new Error('over capacity'));
        return Promise.resolve(editsSaying(`- ${input.tick.turns.map((t) => t.text).join(' / ')}`));
      },
    };
    const session = beginNotesSession(
      {
        composer,
        quietMs: 1000,
        schedule,
        onNotes: () => {},
        onError: () => {},
        onTickLifecycle: (e) => events.push({ phase: e.phase, turns: e.turns }),
      },
      ids,
    );
    session.onTurn({ turn: 0, text: 'One.', final: true });
    schedule.fire();
    await new Promise((r) => setTimeout(r, 0));
    session.onTurn({ turn: 1, text: 'Two.', final: true });
    schedule.fire();
    await session.end();
    expect(events).toEqual([
      { phase: 'composing', turns: [0] },
      { phase: 'failed', turns: [0] },
      { phase: 'composing', turns: [1] },
      // The retry composes the carried turn beside the new one, and says so.
      { phase: 'written', turns: [0, 1] },
    ]);
  });

  it('a doc write the store refused announces failed, and the words carry', async () => {
    // The sink used to swallow a refused write and log it, while the session
    // announced `written` on the strength of having CALLED it. The live area
    // clears a chunk on `written`, so the words left the screen at the same
    // moment they failed to reach the notes — lost from both at once.
    const schedule = new ManualScheduler();
    const events: Array<{ phase: string; turns: readonly number[] }> = [];
    const landed: NotesUpdate[] = [];
    let refuse = true;
    const session = beginNotesSession(
      {
        composer: createStubNotesComposer(),
        quietMs: 1000,
        schedule,
        onNotes: (u) => {
          if (refuse) return false;
          landed.push(u);
          return true;
        },
        onError: () => {},
        onTickLifecycle: (e) => events.push({ phase: e.phase, turns: e.turns }),
      },
      ids,
    );
    session.onTurn({ turn: 0, text: 'One.', final: true });
    schedule.fire();
    await new Promise((r) => setTimeout(r, 0));
    // Nothing was written, and the retry the refusal triggered is announced
    // as its own composing pass — a refused write costs a round trip, not a
    // whole tick.
    expect(events).toEqual([
      { phase: 'composing', turns: [0] },
      { phase: 'failed', turns: [0] },
      { phase: 'composing', turns: [0] },
      { phase: 'failed', turns: [0] },
    ]);
    expect(landed).toEqual([]);
    // The words are still in hand: let the store take them and they land.
    refuse = false;
    await session.end();
    expect(events.filter((e) => e.phase === 'written').map((e) => e.turns)).toEqual([[0]]);
    expect(landed).toHaveLength(1);
  });

  it('a tick that composed nothing announces empty, not written', async () => {
    // `written` is what takes a chunk of transcript off the live surface, so
    // firing it for a tick with no edits took the speaker's words away with
    // no note to show for them (Bryan, 2026-09-09: eleven of one meeting's
    // seventeen ticks). It is not `failed` either — the compose ran, the sink
    // was called, and nothing is carried or retried.
    const schedule = new ManualScheduler();
    const events: Array<{ phase: string; turns: readonly number[] }> = [];
    const landed: NotesUpdate[] = [];
    const silent: NotesComposer = { name: 'silent', compose: () => Promise.resolve([]) };
    const session = beginNotesSession(
      {
        composer: silent,
        quietMs: 1000,
        schedule,
        onNotes: (u) => {
          landed.push(u);
        },
        onError: () => {},
        onTickLifecycle: (e) => events.push({ phase: e.phase, turns: e.turns }),
      },
      ids,
    );
    session.onTurn({ turn: 0, text: 'Small talk.', final: true });
    schedule.fire();
    await session.end();
    expect(events).toEqual([
      { phase: 'composing', turns: [0] },
      { phase: 'empty', turns: [0] },
    ]);
    // Control: the sink really was called, so this is the successful path and
    // not a refusal wearing a different name.
    expect(landed).toHaveLength(1);
    expect(landed[0]?.edits).toEqual([]);
  });

  it('a tick that composed something still announces written', async () => {
    // The other half of the pair: the phase turns on the EDITS, so a normal
    // tick must be unaffected by the empty one above.
    const schedule = new ManualScheduler();
    const events: string[] = [];
    const session = beginNotesSession(
      {
        composer: createStubNotesComposer(),
        quietMs: 1000,
        schedule,
        onNotes: () => {},
        onTickLifecycle: (e) => events.push(e.phase),
      },
      ids,
    );
    session.onTurn({ turn: 0, text: 'Something worth a note.', final: true });
    schedule.fire();
    await session.end();
    expect(events).toEqual(['composing', 'written']);
  });

  it('a sink that reports nothing is not a refusal', async () => {
    // The contract is `void | boolean`, and every sink in the tree returns
    // nothing. Only an explicit `false` may fail a tick — otherwise the fix
    // above would report every meeting as broken.
    const schedule = new ManualScheduler();
    const events: string[] = [];
    const session = beginNotesSession(
      {
        composer: createStubNotesComposer(),
        quietMs: 1000,
        schedule,
        onNotes: () => {},
        onTickLifecycle: (e) => events.push(e.phase),
      },
      ids,
    );
    session.onTurn({ turn: 0, text: 'One.', final: true });
    schedule.fire();
    await session.end();
    expect(events).toEqual(['composing', 'written']);
  });
});

describe('the rest of a sentence the ceiling already carried', () => {
  const ids = { docId: 'doc-continued', meetingId: 'm-continued' };

  /** Drive a ceiling tick mid-turn, then settle the turn, capturing composes. */
  const runSplitTurn = async (speaker?: string) => {
    const schedule = new ManualScheduler();
    const seen: NotesComposeInput[] = [];
    const composer: NotesComposer = {
      name: 'watcher',
      compose(input) {
        seen.push(input);
        return Promise.resolve([]);
      },
    };
    const session = beginNotesSession(
      { composer, quietMs: QUIET, cadenceMs: CADENCE, schedule, onNotes: () => {} },
      ids,
    );
    const voice = speaker !== undefined ? { speaker } : {};
    if (speaker !== undefined) {
      // A SECOND voice, because the speaker-name path only switches on once
      // the meeting has heard two. With one voice a session is solo however
      // many labels it carries, and the test would run the same code as the
      // one above it while claiming to run the other.
      session.onTurn({ turn: 90, text: 'Go ahead.', final: true, speaker: 'Z' });
      schedule.fire();
      await new Promise((r) => setTimeout(r, 0));
    }
    session.onTurn({
      turn: 0,
      text: 'so the second thing we should look at is the write',
      final: false,
      settledText: 'so the second thing we should look at',
      ...voice,
    });
    schedule.fireAt(CADENCE);
    await new Promise((r) => setTimeout(r, 0));
    session.onTurn({
      turn: 0,
      text: 'So the second thing we should look at is the write path.',
      final: true,
      ...voice,
    });
    schedule.fire();
    await session.end();
    return seen;
  };
  const QUIET = 1000;
  const CADENCE = 5000;

  it('reaches the composer flagged, in a meeting with one voice', async () => {
    // The solo path rebuilds each turn field by field rather than spreading
    // it, so a flag that is not named there is silently dropped — which is
    // where this one was being lost.
    const seen = await runSplitTurn();
    const carried = seen
      .flatMap((i) => i.tick.turns)
      .find((t) => t.text.startsWith('path') || t.text.includes('path.'));
    expect(carried).toBeDefined();
    expect(carried?.continued).toBe(true);
    // Control: the FIRST half is not marked — nothing preceded it.
    const first = seen[0]?.tick.turns[0];
    expect(first?.text).toContain('so the second thing');
    expect(first?.continued).toBeUndefined();
  });

  it('reaches the composer flagged when the meeting has names on it', async () => {
    // The other mapper. This one spreads the turn, so it keeps the flag by
    // construction — which is worth a test precisely because that is an
    // accident of how it is written and the solo path proves it can be lost.
    const seen = await runSplitTurn('A');
    // Control: the speaker path really is on, or this runs the mapper above.
    expect(seen.some((i) => i.tick.turns.some((t) => t.speaker !== undefined))).toBe(true);
    const carried = seen.flatMap((i) => i.tick.turns).find((t) => t.continued === true);
    expect(carried).toBeDefined();
    expect(carried?.text).not.toContain('so the second thing');
  });
});

describe('what the timing log records about a meeting', () => {
  const ids = { docId: 'doc-timing', meetingId: 'm-timing' };

  it('measures a tick from the sentence settling to the note being in the doc', async () => {
    // The number the ticket is about, end to end, on an injected clock: real
    // elapsed time is never the assertion (a loaded machine would decide it).
    let now = 1_000;
    const schedule = new ManualScheduler();
    const timing = createNotesTimingLog();
    const composer: NotesComposer = {
      name: 'slow',
      compose(input) {
        now += 900; // the model call
        return Promise.resolve(editsSaying(`- ${input.tick.turns.length} turn(s)`));
      },
    };
    const session = beginNotesSession(
      {
        composer,
        quietMs: 1000,
        schedule,
        now: () => now,
        openTiming: () => timing,
        onNotes: () => {
          now += 20; // the doc write
        },
      },
      ids,
    );
    session.onTurn({ turn: 0, text: 'Measure the write path.', final: true });
    now += 4_000; // the pause the ticker waited out
    schedule.fire();
    await session.end();

    const rows = timing.rows();
    expect(rows).toHaveLength(1);
    const first = rows[0];
    expect(first?.reason).toBe('pause');
    expect(first?.outcome).toBe('written');
    expect(first?.composeMs).toBe(900);
    expect(first?.applyMs).toBe(20);
    expect(first?.edits).toBe(1);
    // 4,000 waiting for the clock + 900 composing + 20 writing.
    expect(first?.settledToWrittenMs).toBe(4_920);
    expect(first?.merged).toBe(1);
    // The turn numbers, so a reader can join this row to the transcript
    // beside it without the row ever carrying a word.
    expect(first?.turns).toEqual([0]);
  });

  it('names the wait behind a slow compose, and counts the ticks that merged', async () => {
    let now = 1_000;
    const schedule = new ManualScheduler();
    const timing = createNotesTimingLog();
    let release: (() => void) | null = null;
    const composer: NotesComposer = {
      name: 'held',
      compose(input) {
        if (release === null) {
          return new Promise((resolve) => {
            release = () => {
              now += 3_000;
              resolve(editsSaying('- first'));
            };
          });
        }
        return Promise.resolve(editsSaying(`- ${input.tick.turns.length} turn(s)`));
      },
    };
    const session = beginNotesSession(
      {
        composer,
        quietMs: 1000,
        schedule,
        now: () => now,
        openTiming: () => timing,
        onNotes: () => {},
      },
      ids,
    );
    session.onTurn({ turn: 0, text: 'One.', final: true });
    schedule.fire();
    await new Promise((r) => setTimeout(r, 0));
    // Two more ticks while the first compose is still out.
    session.onTurn({ turn: 1, text: 'Two.', final: true });
    schedule.fire();
    session.onTurn({ turn: 2, text: 'Three.', final: true });
    schedule.fire();
    (release as unknown as () => void)();
    await session.end();

    const rows = timing.rows();
    expect(rows.map((r) => r.merged)).toEqual([1, 2]);
    expect(rows.map((r) => r.turns)).toEqual([[0], [1, 2]]);
    // The second row's words had been waiting since the earlier of the two
    // ticks that made it, through the whole of the first compose.
    expect(rows[1]?.waitedMs).toBe(3_000);
    // Control: the tick that was never behind anything waited for nothing.
    expect(rows[0]?.waitedMs).toBe(0);
  });

  it('records a refused write as a failed tick with no latency to report', async () => {
    let now = 1_000;
    const schedule = new ManualScheduler();
    const timing = createNotesTimingLog();
    const session = beginNotesSession(
      {
        composer: createStubNotesComposer(),
        quietMs: 1000,
        schedule,
        now: () => now,
        openTiming: () => timing,
        onNotes: () => false,
        onError: () => {},
      },
      ids,
    );
    session.onTurn({ turn: 0, text: 'One.', final: true });
    now += 2_000;
    schedule.fire();
    await session.end();

    const rows = timing.rows();
    expect(rows.every((r) => r.outcome === 'failed')).toBe(true);
    expect(rows.every((r) => r.settledToWrittenMs === null)).toBe(true);
    // A meeting that wrote nothing has no latency verdict to give.
    expect(timing.summary()).toBeNull();
  });

  it('names the carried turns on the tick that finally composed them', async () => {
    // A composer that is simply down carries its words to the NEXT tick
    // rather than retrying at once, so that tick's row has to name the older
    // turn beside the new one. A row naming only the tick's own turns would
    // send a reader of this file to the wrong words in the transcript.
    const now = 1_000;
    const schedule = new ManualScheduler();
    const timing = createNotesTimingLog();
    let calls = 0;
    const composer: NotesComposer = {
      name: 'down-then-up',
      compose(input) {
        calls++;
        if (calls === 1) return Promise.reject(new Error('over capacity'));
        return Promise.resolve(editsSaying(`- ${input.tick.turns.length} turn(s)`));
      },
    };
    const session = beginNotesSession(
      {
        composer,
        quietMs: 1000,
        schedule,
        now: () => now,
        openTiming: () => timing,
        onNotes: () => {},
        onError: () => {},
      },
      ids,
    );
    session.onTurn({ turn: 0, text: 'One.', final: true });
    schedule.fire();
    await new Promise((r) => setTimeout(r, 0));
    session.onTurn({ turn: 1, text: 'Two.', final: true });
    schedule.fire();
    await session.end();

    expect(timing.rows().map((r) => [r.outcome, [...r.turns]])).toEqual([
      ['failed', [0]],
      ['written', [0, 1]],
    ]);
  });
});

describe('speaker tags only in multi-speaker sessions', () => {
  const ids = { docId: 'doc-solo', meetingId: 'm-solo' };

  it('one voice heard: the composer sees no speaker at all', async () => {
    // A `conversation` capture with one person in the room is still solo
    // (owner's call, 2026-08-31: a solo huddle stamped with the speaker's
    // own name on every note is pure noise).
    const schedule = new ManualScheduler();
    const inputs: NotesComposeInput[] = [];
    const composer: NotesComposer = {
      name: 'capture',
      compose(input) {
        inputs.push(input);
        return Promise.resolve(editsSaying('- noted'));
      },
    };
    const session = beginNotesSession(
      { composer, quietMs: 1000, schedule, onNotes: () => {} },
      ids,
    );
    session.onTurn({ turn: 0, text: 'Only me.', final: true, speaker: 'A' });
    schedule.fire();
    await session.end();
    expect(inputs[0]?.tick.turns[0]?.speaker).toBeUndefined();
    expect(inputs[0]?.tick.turns[0]?.speakerLabel).toBeUndefined();
  });

  it('a second voice turns attribution on for the ticks that follow', async () => {
    const schedule = new ManualScheduler();
    const inputs: NotesComposeInput[] = [];
    const composer: NotesComposer = {
      name: 'capture',
      compose(input) {
        inputs.push(input);
        return Promise.resolve(editsSaying('- noted'));
      },
    };
    const session = beginNotesSession(
      { composer, quietMs: 1000, schedule, onNotes: () => {} },
      ids,
    );
    session.onTurn({ turn: 0, text: 'Only me so far.', final: true, speaker: 'A' });
    schedule.fire();
    await new Promise((r) => setTimeout(r, 0));
    session.onTurn({ turn: 1, text: 'And me.', final: true, speaker: 'B' });
    schedule.fire();
    await session.end();
    expect(inputs[0]?.tick.turns[0]?.speaker).toBeUndefined();
    expect(inputs[1]?.tick.turns[0]).toMatchObject({ speaker: 'Speaker B', speakerLabel: 'B' });
  });

  it('a solo composer’s invented tag is dropped, even for a voice the meeting carried', async () => {
    const schedule = new ManualScheduler();
    const updates: NotesUpdate[] = [];
    const composer: NotesComposer = {
      name: 'inventive',
      compose() {
        return Promise.resolve(
          editsSaying('## Meeting notes\n\n- [@Speaker A](speaker:A) said it.'),
        );
      },
    };
    const session = beginNotesSession(
      {
        composer,
        quietMs: 1000,
        schedule,
        onNotes: (u) => {
          updates.push(u);
        },
        onError: () => {},
      },
      ids,
    );
    session.onTurn({ turn: 0, text: 'Said it.', final: true, speaker: 'A' });
    schedule.fire();
    await session.end();
    expect(composedMarkdown(updates[0]!)).not.toContain('speaker:A');
    // The words of the note, and no voice: a solo meeting has nobody to
    // name, so "Speaker A" in the sentence would be a person invented twice
    // over — once by the composer and once by the gate that let it stand.
    expect(composedMarkdown(updates[0]!)).toContain('Said it.');
    expect(composedMarkdown(updates[0]!)).not.toContain('Speaker A');
  });
});

/**
 * A refused compose is the quietest failure in this subsystem: the turns
 * carry into the next tick, nothing is lost, and the notes simply stop
 * growing. `bun run notes:eval` measured it at about a tenth of ticks, all
 * late in the longer meetings — and production could not see any of it,
 * because the only report was an `onError` no caller supplied.
 */
describe('a compose refused for running past the output ceiling', () => {
  const ids = { docId: 'd-refuse', meetingId: 'm-refuse' };

  const refusingSession = (
    errors: string[],
  ): ReturnType<typeof beginNotesSession> & { fire: () => void } => {
    const schedule = new ManualScheduler();
    const composer: NotesComposer = {
      name: 'refuses',
      compose(): Promise<readonly prose.BlockEdit[]> {
        return Promise.reject(
          new Error('notes compose hit max_tokens; refusing a truncated section'),
        );
      },
    };
    const session = beginNotesSession(
      {
        composer,
        quietMs: 1000,
        schedule,
        onNotes: () => {},
        onError: (message) => errors.push(message),
      },
      ids,
    );
    return Object.assign(session, { fire: () => schedule.fire() });
  };

  it('names the meeting and the tick, so a log can say which notes fell behind', async () => {
    const errors: string[] = [];
    const session = refusingSession(errors);
    session.onTurn({ turn: 0, text: 'A point worth writing down.', final: true });
    session.fire();
    await session.end();

    // The reason alone is what used to be reported, and with several meetings
    // running it names none of them.
    const first = errors[0] ?? '';
    expect(first).toContain('d-refuse');
    expect(first).toContain('m-refuse');
    expect(first).toContain('tick 1');
    expect(first).toContain('max_tokens');
  });

  it('is counted, so the meeting can say how much it lost', async () => {
    const errors: string[] = [];
    const session = refusingSession(errors);
    session.onTurn({ turn: 0, text: 'First point.', final: true });
    session.fire();
    session.onTurn({ turn: 1, text: 'Second point.', final: true });
    session.fire();
    await session.end();

    const stats = session.stats();
    expect(stats.refusedTooLong).toBeGreaterThanOrEqual(2);
    expect(stats.composeFailures).toBe(stats.refusedTooLong);
    // And the meeting says so once when it ends, rather than only per tick.
    expect(errors.some((e) => /refused as too long/.test(e))).toBe(true);
  });

  it('counts an ordinary compose failure without calling it a length refusal', async () => {
    const errors: string[] = [];
    const schedule = new ManualScheduler();
    const composer: NotesComposer = {
      name: 'breaks',
      compose: () => Promise.reject(new Error('notes compose HTTP 503')),
    };
    const session = beginNotesSession(
      {
        composer,
        quietMs: 1000,
        schedule,
        onNotes: () => {},
        onError: (message) => errors.push(message),
      },
      ids,
    );
    session.onTurn({ turn: 0, text: 'A point.', final: true });
    schedule.fire();
    await session.end();

    expect(session.stats().composeFailures).toBeGreaterThan(0);
    expect(session.stats().refusedTooLong).toBe(0);
    expect(errors.some((e) => /refused as too long/.test(e))).toBe(false);
  });
});

describe('a quota outage is visible in the meeting doc', () => {
  const ids = { docId: 'doc-quota', meetingId: 'm-quota' };

  /**
   * A doc small enough to assert on: blocks in order, and the two ops the
   * notice path uses applied to them. It is a model of the doc rather than a
   * real one because what is under test is the SEQUENCE of writes the session
   * makes — one notice, then its retraction — not how Yjs stores a paragraph.
   */
  function fakeDoc() {
    const blocks: prose.OutlineEntry[] = [
      { id: 'h1', kind: 'heading', nodeName: 'heading', level: 2, text: 'Meeting notes' },
    ];
    let n = 0;
    const apply = (edits: readonly prose.BlockEdit[]): void => {
      for (const edit of edits) {
        if (edit.op === 'delete_block') {
          const at = blocks.findIndex((b) => b.id === edit.blockId);
          if (at >= 0) blocks.splice(at, 1);
          continue;
        }
        if (!('markdown' in edit)) continue;
        blocks.push({
          id: `b${++n}`,
          kind: 'block',
          nodeName: 'paragraph',
          text: edit.markdown,
          author: 'meeting-notes',
        });
      }
    };
    return {
      blocks,
      apply,
      /** Every block whose words are the outage notice. */
      notices: () => blocks.filter((b) => b.text.startsWith(QUOTA_NOTICE_MARK)),
    };
  }

  /** A composer that refuses with whatever message the test wants, then (once
   *  `failing` is cleared) writes a bullet like any other tick. */
  function refusingComposer(state: { message: string | null }): NotesComposer {
    return {
      name: 'refusing',
      compose(input) {
        if (state.message !== null) return Promise.reject(new Error(state.message));
        return Promise.resolve([
          {
            op: 'insert_under_heading',
            headingId: 'h1',
            markdown: `- noted at tick ${input.tick.tick}`,
          } satisfies prose.BlockEdit,
        ]);
      },
    };
  }

  function sessionOver(doc: ReturnType<typeof fakeDoc>, composer: NotesComposer) {
    const schedule = new ManualScheduler();
    const updates: NotesUpdate[] = [];
    const session = beginNotesSession(
      {
        composer,
        quietMs: 1000,
        schedule,
        readOutline: () => doc.blocks.map((b) => ({ ...b })),
        notesHeadingId: () => 'h1',
        onNotes: (u) => {
          updates.push(u);
          doc.apply(u.edits);
        },
      },
      ids,
    );
    return { schedule, session, updates };
  }

  it('says so once, not once per tick, while the outage lasts', async () => {
    const doc = fakeDoc();
    const state = { message: 'notes compose HTTP 429 — out of quota' };
    const { schedule, session, updates } = sessionOver(doc, refusingComposer(state));

    session.onTurn({ turn: 0, text: 'First thing.', final: true });
    schedule.fire();
    await new Promise((r) => setTimeout(r, 0));
    session.onTurn({ turn: 1, text: 'Second thing.', final: true });
    schedule.fire();
    await session.end();

    // Two refusals; the reader is told once.
    expect(doc.notices()).toHaveLength(1);
    expect(doc.notices()[0]?.text).toBe(QUOTA_NOTICE_TEXT);
    expect(updates.filter((u) => composedMarkdown(u).startsWith(QUOTA_NOTICE_MARK))).toHaveLength(
      1,
    );
    expect(session.stats().composeFailures).toBeGreaterThan(1);
  });

  it('still says it once when the outline read cannot see the notice yet', async () => {
    // The other half of "once per outage". Above, the doc read back what was
    // written, so either guard could have held the line. Here the outline is
    // frozen at what the meeting started with — a doc read that has not caught
    // up, which is the ordinary case for a write made this same tick — so the
    // session's own memory is the only thing that can stop a second notice.
    const doc = fakeDoc();
    const frozen = doc.blocks.map((b) => ({ ...b }));
    const schedule = new ManualScheduler();
    const state = { message: 'notes compose HTTP 429 — out of quota' };
    const session = beginNotesSession(
      {
        composer: refusingComposer(state),
        quietMs: 1000,
        schedule,
        readOutline: () => frozen.map((b) => ({ ...b })),
        notesHeadingId: () => 'h1',
        onNotes: (u) => doc.apply(u.edits),
      },
      ids,
    );

    session.onTurn({ turn: 0, text: 'First thing.', final: true });
    schedule.fire();
    await new Promise((r) => setTimeout(r, 0));
    session.onTurn({ turn: 1, text: 'Second thing.', final: true });
    schedule.fire();
    await new Promise((r) => setTimeout(r, 0));
    session.onTurn({ turn: 2, text: 'Third thing.', final: true });
    await session.end();

    expect(doc.notices()).toHaveLength(1);
  });

  it('takes the notice away as soon as a tick composes again', async () => {
    const doc = fakeDoc();
    const state: { message: string | null } = { message: 'notes compose HTTP 400 — out of quota' };
    const { schedule, session } = sessionOver(doc, refusingComposer(state));

    session.onTurn({ turn: 0, text: 'During the outage.', final: true });
    schedule.fire();
    await new Promise((r) => setTimeout(r, 0));
    expect(doc.notices()).toHaveLength(1);

    state.message = null;
    session.onTurn({ turn: 1, text: 'After it.', final: true });
    await session.end();

    expect(doc.notices()).toHaveLength(0);
    // And the notes themselves landed, so this is a recovery rather than a
    // doc that lost both the notice and the note.
    expect(doc.blocks.some((b) => b.text.startsWith('- noted at tick'))).toBe(true);
  });

  it('reaches the doc from a real API refusal, end to end', async () => {
    // Every other test in this block hands the session a refusal message.
    // This one starts where the outage did: an HTTP status from the API,
    // through the composer that classifies it, to the sentence in the doc.
    const doc = fakeDoc();
    const schedule = new ManualScheduler();
    const composer = createHaikuNotesComposer({
      apiKey: 'k-test',
      fetchImpl: (async () =>
        new Response(JSON.stringify({ error: { message: 'rate limited' } }), {
          status: 429,
        })) as unknown as typeof fetch,
    });
    expect(composer).not.toBeNull();
    const session = beginNotesSession(
      {
        composer: composer as NotesComposer,
        quietMs: 1000,
        schedule,
        readOutline: () => doc.blocks.map((b) => ({ ...b })),
        notesHeadingId: () => 'h1',
        onNotes: (u) => doc.apply(u.edits),
      },
      ids,
    );
    session.onTurn({ turn: 0, text: 'Something worth noting.', final: true });
    await session.end();

    expect(doc.notices()).toHaveLength(1);
  });

  it('tells the room on the next refusal when the doc declined the notice', async () => {
    // The sink bounced the notice, so the doc says nothing. A session that
    // recorded it as written would suppress every later refusal, and the
    // meeting would run to the end with the room none the wiser.
    const doc = fakeDoc();
    const schedule = new ManualScheduler();
    const state = { message: 'notes compose HTTP 429 — out of quota' };
    let accept = false;
    const session = beginNotesSession(
      {
        composer: refusingComposer(state),
        quietMs: 1000,
        schedule,
        readOutline: () => doc.blocks.map((b) => ({ ...b })),
        notesHeadingId: () => 'h1',
        onNotes: (u) => {
          const isNotice = composedMarkdown(u).startsWith(QUOTA_NOTICE_MARK);
          if (isNotice && !accept) return false;
          doc.apply(u.edits);
          return true;
        },
      },
      ids,
    );

    session.onTurn({ turn: 0, text: 'First thing.', final: true });
    schedule.fire();
    await new Promise((r) => setTimeout(r, 0));
    expect(doc.notices()).toHaveLength(0);

    accept = true;
    session.onTurn({ turn: 1, text: 'Second thing.', final: true });
    await session.end();

    expect(doc.notices()).toHaveLength(1);
  });

  it('tries the retraction again when the doc declined the deletion', async () => {
    // A rejected delete leaves the sentence standing under fresh notes. The
    // session must keep believing the doc claims an outage until it does not.
    const doc = fakeDoc();
    const schedule = new ManualScheduler();
    const state: { message: string | null } = {
      message: 'notes compose HTTP 429 — out of quota',
    };
    let acceptDeletes = false;
    const session = beginNotesSession(
      {
        composer: refusingComposer(state),
        quietMs: 1000,
        schedule,
        readOutline: () => doc.blocks.map((b) => ({ ...b })),
        notesHeadingId: () => 'h1',
        onNotes: (u) => {
          const isDelete = u.edits.some((e) => e.op === 'delete_block');
          if (isDelete && !acceptDeletes) return false;
          doc.apply(u.edits);
          return true;
        },
      },
      ids,
    );

    session.onTurn({ turn: 0, text: 'During the outage.', final: true });
    schedule.fire();
    await new Promise((r) => setTimeout(r, 0));
    expect(doc.notices()).toHaveLength(1);

    // Quota is back, but the first retraction bounces.
    state.message = null;
    session.onTurn({ turn: 1, text: 'After it.', final: true });
    schedule.fire();
    await new Promise((r) => setTimeout(r, 0));
    expect(doc.notices()).toHaveLength(1);

    acceptDeletes = true;
    session.onTurn({ turn: 2, text: 'And more.', final: true });
    await session.end();

    expect(doc.notices()).toHaveLength(0);
  });

  it('clears a notice left by a PREVIOUS session, which this one never wrote', async () => {
    // The restart case. The outage began under a session that is gone; quota
    // came back before this one composed anything. Nothing in this session's
    // memory says a notice exists, so only reading the doc can find it.
    const doc = fakeDoc();
    doc.apply([{ op: 'insert_under_heading', headingId: 'h1', markdown: QUOTA_NOTICE_TEXT }]);
    expect(doc.notices()).toHaveLength(1);

    const state: { message: string | null } = { message: null };
    const { session } = sessionOver(doc, refusingComposer(state));
    session.onTurn({ turn: 0, text: 'A fresh meeting note.', final: true });
    await session.end();

    expect(doc.notices()).toHaveLength(0);
    expect(doc.blocks.some((b) => b.text.startsWith('- noted at tick'))).toBe(true);
  });

  it('a failure that is not quota leaves the doc alone', async () => {
    // The control for the classification: an overloaded API is one tick's bad
    // luck, the words carry, and nothing is written about it.
    const doc = fakeDoc();
    const state = { message: 'notes compose HTTP 529' };
    const { schedule, session } = sessionOver(doc, refusingComposer(state));

    session.onTurn({ turn: 0, text: 'A point.', final: true });
    schedule.fire();
    await session.end();

    expect(doc.notices()).toHaveLength(0);
    expect(session.stats().composeFailures).toBeGreaterThan(0);
  });
});
