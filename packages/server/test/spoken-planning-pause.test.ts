/**
 * The planning voice asks only at a pause, never mid-sentence: a recorded
 * turn trace (`fixtures/planning-pause-trace.json`) played through a
 * spoken-reply session on a plan, on a fake clock, and the question looked
 * for after every frame. Fake listener and voice; nothing reaches a vendor.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SpokenServerMessage } from '@claude-workspaces/core/spoken-reply';
import {
  FINISHED_PAUSE_MS,
  type GateTimers,
  PauseGate,
  UNFINISHED_PAUSE_MS,
  midSentence,
} from '../src/spoken-reply/pause-gate.ts';
import {
  SPOKEN_PLANNING_TUNING,
  SPOKEN_TAP_TUNING,
  SpokenSession,
} from '../src/spoken-reply/session.ts';
import { SpokenTimings } from '../src/spoken-reply/timings.ts';
import type { SpokenVoice } from '../src/spoken-reply/tts.ts';
import type { TranscriptionEngine, TranscriptionOpenOpts } from '../src/transcribe.ts';
import { parseVoiceContext } from '../src/voice.ts';
import { DOC_ID, type Fixture, planFixture } from './interview-fixture.ts';
import { waitFor } from './wait-for.ts';

interface Frame {
  atMs: number;
  turn: number;
  text: string;
  final: boolean;
}
interface Trace {
  pauseAfterMs: number;
  frames: Frame[];
}
const TRACES = (
  JSON.parse(
    readFileSync(join(import.meta.dir, 'fixtures', 'planning-pause-trace.json'), 'utf8'),
  ) as { traces: Record<string, Trace> }
).traces;

function trace(name: string): Trace {
  const t = TRACES[name];
  if (!t) throw new Error(`no trace ${name}`);
  return t;
}

/** A clock that moves only when told to. */
function fakeClock() {
  let now = 0;
  let next = 0;
  const due = new Map<number, { at: number; fn: () => void }>();
  const timers: GateTimers = {
    set: (fn, ms) => {
      const id = ++next;
      due.set(id, { at: now + ms, fn });
      return id;
    },
    clear: (h) => void due.delete(h as number),
  };
  const advanceTo = (t: number) => {
    for (;;) {
      const first = [...due.entries()]
        .filter(([, d]) => d.at <= t)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!first) break;
      due.delete(first[0]);
      now = first[1].at;
      first[1].fn();
    }
    now = t;
  };
  return { timers, advanceTo, pending: () => due.size };
}

/** A voice that says nothing aloud. */
const MUTE: SpokenVoice = { name: 'mute', async speak() {} };

let fx: Fixture | null = null;
afterEach(() => {
  fx?.stop();
  fx = null;
});

async function planningSession() {
  fx = await planFixture();
  const clock = fakeClock();
  const opened: TranscriptionOpenOpts[] = [];
  // The session closes the listener the moment it ends the turn, before any
  // await, so the count is exact at every frame.
  let closed = 0;
  const listener: TranscriptionEngine = {
    name: 'fake',
    async open(o) {
      opened.push(o);
      return {
        send: () => {},
        close: async () => {
          closed++;
        },
      };
    },
  };
  const json: SpokenServerMessage[] = [];
  const s = new SpokenSession({
    engines: { listener, voices: { 1: MUTE, 2: null }, gemini: null },
    answerer: fx.answerer,
    timings: new SpokenTimings(undefined, () => {}),
    provenActor: { id: 'known-alice', name: 'Alice' },
    readOnly: false,
    parseContext: parseVoiceContext,
    sendJson: (m) => json.push(m),
    sendAudio: () => {},
    timers: clock.timers,
  });
  s.onText(
    JSON.stringify({
      type: 'start',
      setup: 1,
      mode: 'tap',
      context: { surface: 'doc', docId: DOC_ID },
    }),
  );
  await waitFor(() => opened.length === 1, { describe: 'listener opened' });
  // The gate decides on a plan, so the listener waits as long as it can.
  expect(opened[0]?.tuning).toEqual(SPOKEN_PLANNING_TUNING);
  const onTurn = opened[0]?.onTurn;
  if (!onTurn) throw new Error('no listener');
  const replies = () => json.filter((m) => m.type === 'reply');
  const ended = () => json.filter((m) => m.type === 'turn-end');
  return { clock, onTurn, replies, ended, json, closed: () => closed };
}

describe('the planning voice asks only at a pause', () => {
  for (const name of ['breath-mid-sentence', 'two-sentences']) {
    it(`${name}: no question while the speaker is mid-sentence, one at the pause`, async () => {
      const t = trace(name);
      const h = await planningSession();
      const played = t.frames.filter((f) => f.atMs <= t.pauseAfterMs);
      for (const f of played) {
        h.clock.advanceTo(f.atMs);
        // Nothing has ended the turn before this frame arrives.
        expect(h.closed()).toBe(0);
        expect(h.replies()).toEqual([]);
        h.onTurn({ turn: f.turn, text: f.text, final: f.final });
      }
      // The listener's end of utterance after a finished sentence is the pause.
      await waitFor(() => h.replies().length === 1, { describe: 'question at the pause' });
      const words = played.filter((f) => f.final).map((f) => f.text);
      expect(h.ended()).toEqual([{ type: 'turn-end', text: words.join(' ') }]);
      expect(h.replies()[0]).toMatchObject({
        spoken: 'What goes under Goals?',
        asking: true,
        route: 'interview',
      });
    });
  }

  it('off a plan, the end of speech still ends the turn at once', async () => {
    fx = await planFixture({ onBoard: false });
    const opened: TranscriptionOpenOpts[] = [];
    const json: SpokenServerMessage[] = [];
    const s = new SpokenSession({
      engines: {
        listener: {
          name: 'fake',
          async open(o) {
            opened.push(o);
            return { send: () => {}, close: async () => {} };
          },
        },
        voices: { 1: MUTE, 2: null },
        gemini: null,
      },
      answerer: fx.answerer,
      timings: new SpokenTimings(undefined, () => {}),
      provenActor: null,
      readOnly: false,
      parseContext: parseVoiceContext,
      sendJson: (m) => json.push(m),
      sendAudio: () => {},
      timers: fakeClock().timers,
    });
    s.onText(
      JSON.stringify({ type: 'start', setup: 1, mode: 'tap', context: { surface: 'board' } }),
    );
    await waitFor(() => opened.length === 1, { describe: 'listener opened' });
    expect(opened[0]?.tuning).toEqual(SPOKEN_TAP_TUNING);
    opened[0]?.onTurn({ turn: 0, text: 'give me a status update', final: true });
    await waitFor(() => json.some((m) => m.type === 'reply'), { describe: 'routed reply' });
  });

  // Bryan, 3 Nov: "The voice is stopping often after I say one thing." A
  // thinking pause of a second and a half no longer ends a board question;
  // two seconds of quiet does, at the listener and at the gate alike.
  it('off a plan, a pause of 1.5s mid-thought does not end the question; 2s does', async () => {
    fx = await planFixture({ onBoard: false });
    const clock = fakeClock();
    const opened: TranscriptionOpenOpts[] = [];
    const json: SpokenServerMessage[] = [];
    // Ending the question closes the listener before any await.
    let closed = 0;
    const s = new SpokenSession({
      engines: {
        listener: {
          name: 'fake',
          async open(o) {
            opened.push(o);
            return {
              send: () => {},
              close: async () => {
                closed++;
              },
            };
          },
        },
        voices: { 1: MUTE, 2: null },
        gemini: null,
      },
      answerer: fx.answerer,
      timings: new SpokenTimings(undefined, () => {}),
      provenActor: null,
      readOnly: false,
      parseContext: parseVoiceContext,
      sendJson: (m) => json.push(m),
      sendAudio: () => {},
      timers: clock.timers,
    });
    s.onText(
      JSON.stringify({ type: 'start', setup: 1, mode: 'tap', context: { surface: 'board' } }),
    );
    await waitFor(() => opened.length === 1, { describe: 'listener opened' });
    expect(opened[0]?.tuning).toEqual({ max_endpoint_delay_ms: 2000 });
    const ended = () => json.filter((m) => m.type === 'turn-end');
    // A sentence that sounds finished, still a partial: the listener has not
    // called its end of speech yet.
    opened[0]?.onTurn({ turn: 0, text: 'give me a status update', final: false });
    clock.advanceTo(1500);
    clock.advanceTo(1999);
    expect(closed).toBe(0);
    clock.advanceTo(2000);
    expect(closed).toBe(1);
    await waitFor(() => ended().length === 1, { describe: 'question ended at 2s' });
  });
});

describe('midSentence', () => {
  it('reads a turn that stops on a joining word or mark as unfinished', () => {
    for (const t of [
      'starts at Harborlight and',
      'the deck goes to the',
      'we wait because',
      'first Riverbend,',
      'um',
      'the ramps —',
    ]) {
      expect(midSentence(t)).toBe(true);
    }
    for (const t of ['We ship the deck first.', 'then Riverbend in May.', 'Is that right?', '']) {
      expect(midSentence(t)).toBe(false);
    }
  });
});

describe('PauseGate', () => {
  function gate(timing?: { finishedMs: number; unfinishedMs: number }) {
    const clock = fakeClock();
    let paused = 0;
    const g = new PauseGate(() => paused++, clock.timers, timing);
    return { g, clock, paused: () => paused };
  }

  it('waits 3s of silence after a dash or an ellipsis, endpoint or not', () => {
    for (const [text, final] of [
      ['The berth opens in spring and I noticed that there’s—', false],
      ['The berth opens in spring and I noticed that there’s—', true],
      ['We could move the office…', false],
    ] as const) {
      const h = gate();
      h.g.heard(text, final);
      h.clock.advanceTo(UNFINISHED_PAUSE_MS - 1);
      expect(h.paused()).toBe(0);
      h.clock.advanceTo(UNFINISHED_PAUSE_MS);
      expect(h.paused()).toBe(1);
    }
  });

  it('calls a pause 1.5s after a finished sentence the listener has not ended', () => {
    const h = gate();
    h.g.heard('We ship the deck first.', false);
    h.clock.advanceTo(FINISHED_PAUSE_MS - 1);
    expect(h.paused()).toBe(0);
    h.clock.advanceTo(FINISHED_PAUSE_MS);
    expect(h.paused()).toBe(1);
    // Its final turn, arriving late, is the same words: no second pause.
    h.g.heard('We ship the deck first.', true);
    expect(h.paused()).toBe(1);
  });

  it('the listener’s end of utterance, when it comes first, is the pause', () => {
    const h = gate();
    h.g.heard('We ship the deck first.', false);
    h.clock.advanceTo(400);
    h.g.heard('We ship the deck first.', true);
    expect(h.paused()).toBe(1);
    h.clock.advanceTo(10_000);
    expect(h.paused()).toBe(1);
  });

  it('silence runs from the last new words', () => {
    const h = gate();
    h.g.heard('the rollout starts at Harborlight and', false);
    h.clock.advanceTo(2000);
    // A final repeating the same words is not news: the window holds.
    h.g.heard('the rollout starts at Harborlight and', true);
    h.clock.advanceTo(2900);
    h.g.heard('the rollout starts at Harborlight and then', false);
    h.clock.advanceTo(2900 + UNFINISHED_PAUSE_MS - 1);
    expect(h.paused()).toBe(0);
    h.clock.advanceTo(2900 + UNFINISHED_PAUSE_MS);
    expect(h.paused()).toBe(1);
  });

  it('takes the page’s own setting for either wait', () => {
    const h = gate({ finishedMs: 2500, unfinishedMs: 6000 });
    h.g.heard('We ship the deck first.', false);
    h.clock.advanceTo(FINISHED_PAUSE_MS);
    expect(h.paused()).toBe(0);
    h.clock.advanceTo(2500);
    expect(h.paused()).toBe(1);
    h.g.heard('We ship the deck first. Then the', false);
    h.clock.advanceTo(2500 + UNFINISHED_PAUSE_MS);
    expect(h.paused()).toBe(1);
    h.clock.advanceTo(2500 + 6000);
    expect(h.paused()).toBe(2);
  });
});
