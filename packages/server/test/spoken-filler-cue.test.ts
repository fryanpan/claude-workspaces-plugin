/**
 * The slow-answer cue (`filler-cue.ts`), on a fake clock: said only when the
 * answer is later than the threshold, never once the answer has started, and
 * never over the speaker. Driven alone and through a reply socket, with a
 * board whose answer the test releases and a voice whose chunks the test sends.
 */
import { describe, expect, it } from 'bun:test';
import type { SpokenServerMessage } from '@claude-workspaces/core/spoken-reply';
import { SpokenAnswerer, type SpokenBoard } from '../src/spoken-reply/answer.ts';
import { FILLER_CUE_AFTER_MS, FillerCue, cueFor } from '../src/spoken-reply/filler-cue.ts';
import type { GeminiLive, GeminiLiveEvents } from '../src/spoken-reply/gemini-live.ts';
import type { GateTimers } from '../src/spoken-reply/pause-gate.ts';
import { SpokenSession } from '../src/spoken-reply/session.ts';
import { SpokenTimings } from '../src/spoken-reply/timings.ts';
import type { SpokenVoice } from '../src/spoken-reply/tts.ts';
import type { TranscriptionEngine, TranscriptionOpenOpts } from '../src/transcribe.ts';
import { waitFor } from './wait-for.ts';

function fakeClock() {
  let now = 0;
  const pending = new Map<number, { at: number; fn: () => void }>();
  let next = 1;
  const timers: GateTimers = {
    set: (fn, ms) => {
      const id = next++;
      pending.set(id, { at: now + ms, fn });
      return id;
    },
    clear: (h) => void pending.delete(h as number),
  };
  return {
    timers,
    advance(ms: number) {
      now += ms;
      for (const [id, t] of [...pending]) {
        if (t.at > now) continue;
        pending.delete(id);
        t.fn();
      }
    },
  };
}

/** A voice that sends a chunk only when the test says, and ends on `end`. */
function heldVoice() {
  const said: string[] = [];
  const calls: Array<{ chunk(): void; end(): void; aborted(): boolean }> = [];
  const voice: SpokenVoice = {
    name: 'held',
    speak(text, onAudio, signal) {
      said.push(text);
      return new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve());
        calls.push({
          chunk: () => onAudio(new Uint8Array(4800)),
          end: () => resolve(),
          aborted: () => signal.aborted,
        });
      });
    },
  };
  return { voice, said, calls, last: () => calls[calls.length - 1] };
}

/** A voice that streams one chunk per point and finishes at once. */
function quickVoice() {
  const said: string[] = [];
  const voice: SpokenVoice = {
    name: 'quick',
    async speak(text, onAudio) {
      said.push(text);
      onAudio(new Uint8Array(4800));
    },
  };
  return { voice, said };
}

function cueRig(heard = 'how is it going') {
  const clock = fakeClock();
  const v = heldVoice();
  const json: SpokenServerMessage[] = [];
  let audio = 0;
  let live = true;
  const cue = new FillerCue({
    voice: v.voice,
    heard,
    live: () => live,
    sendJson: (m) => json.push(m),
    sendAudio: () => audio++,
    timers: clock.timers,
  });
  return {
    cue,
    clock,
    v,
    json,
    audio: () => audio,
    endTurn: () => {
      live = false;
    },
  };
}

describe('FillerCue', () => {
  it('says nothing when the answer is ready before the threshold', async () => {
    const r = cueRig();
    r.clock.advance(FILLER_CUE_AFTER_MS - 1);
    expect(await r.cue.ready()).toBe(false);
    r.clock.advance(10_000);
    expect(r.v.said).toEqual([]);
    expect(r.json).toEqual([]);
  });

  it('says the cue once the answer is later than the threshold, and hands the stream on', async () => {
    const r = cueRig();
    r.clock.advance(FILLER_CUE_AFTER_MS);
    expect(r.v.said).toEqual(['Checking the board.']);
    r.v.last()?.chunk();
    expect(r.json).toEqual([{ type: 'audio-start', sampleRate: 24_000 }]);
    const ready = r.cue.ready();
    r.v.last()?.chunk();
    r.v.last()?.end();
    expect(await ready).toBe(true);
    expect(r.audio()).toBe(2);
    expect(r.cue.playedMs).toBe(200);
  });

  it('drops a cue none of whose audio was sent when the answer arrives', async () => {
    const r = cueRig();
    r.clock.advance(FILLER_CUE_AFTER_MS);
    expect(await r.cue.ready()).toBe(false);
    expect(r.v.last()?.aborted()).toBe(true);
    r.v.last()?.chunk();
    expect(r.json).toEqual([]);
    expect(r.audio()).toBe(0);
  });

  it('stops mid-word when the turn ends, and closes the stream it opened', async () => {
    const r = cueRig();
    r.clock.advance(FILLER_CUE_AFTER_MS);
    r.v.last()?.chunk();
    r.endTurn();
    r.v.last()?.chunk();
    expect(r.audio()).toBe(1);
    r.cue.cancel();
    r.cue.cancel();
    expect(r.json.map((m) => m.type)).toEqual(['audio-start', 'audio-end']);
    expect(await r.cue.ready()).toBe(false);
  });

  it('is never armed for a turn with nothing heard', () => {
    const r = cueRig('  ');
    r.clock.advance(10_000);
    expect(r.v.said).toEqual([]);
  });

  it('names the part of the board the answer is read from', () => {
    expect(cueFor('go through my reviews')).toBe('Checking your reviews.');
    expect(cueFor('how is the goal going')).toBe('Checking the goals.');
    expect(cueFor('what tasks are open')).toBe('Checking the tasks.');
    expect(cueFor('give me a status update')).toBe('Checking the board.');
  });
});

/** A board whose answer arrives when the test releases it. */
function slowBoard() {
  const waiting: Array<() => void> = [];
  const board: SpokenBoard = {
    handle: (_ws, req) =>
      new Promise((resolve) =>
        waiting.push(() =>
          resolve({ ok: true, route: 'fast-path', ack: `Answer to ${req.transcript}.` }),
        ),
      ),
    goalStatus: () => undefined,
    goals: () => [],
  };
  return { board, release: () => waiting.shift()?.(), pending: () => waiting.length };
}

function fakeListener() {
  const opened: TranscriptionOpenOpts[] = [];
  const engine: TranscriptionEngine = {
    name: 'fake',
    async open(opts) {
      opened.push(opts);
      return { send: () => {}, close: async () => {} };
    },
  };
  return {
    engine,
    opened,
    turn: (text: string) => opened.at(-1)?.onTurn({ turn: 0, text, final: true }),
  };
}

function socketRig(gemini: GeminiLive | null = null) {
  const clock = fakeClock();
  const b = slowBoard();
  const l = fakeListener();
  const v = quickVoice();
  const json: SpokenServerMessage[] = [];
  const logs: string[] = [];
  const session = new SpokenSession({
    engines: { listener: l.engine, voices: { 1: v.voice, 2: null }, gemini },
    answerer: new SpokenAnswerer(b.board, 'w1'),
    timings: new SpokenTimings(undefined, (line) => logs.push(line)),
    provenActor: { id: 'known-alice', name: 'Alice' },
    readOnly: false,
    parseContext: () => undefined,
    sendJson: (m) => json.push(m),
    sendAudio: () => {},
    timers: clock.timers,
  });
  const send = (m: unknown) => session.onText(JSON.stringify(m));
  /** Ask a question in hold mode and wait until the board is asked. */
  const ask = async (text: string) => {
    const before = l.opened.length;
    send({ type: 'start', setup: 1, mode: 'hold' });
    await waitFor(() => l.opened.length > before);
    l.turn(text);
    send({ type: 'end' });
    await waitFor(() => b.pending() > 0);
  };
  return { clock, b, v, json, logs, send, ask, types: () => json.map((m) => m.type) };
}

describe('the cue on a reply socket, setup 1', () => {
  it('a late answer is said after the cue, in one audio stream', async () => {
    const r = socketRig();
    await r.ask('give me a status update');
    r.clock.advance(FILLER_CUE_AFTER_MS);
    await waitFor(() => r.v.said.length === 1);
    r.b.release();
    await waitFor(() => r.types().includes('audio-end'));
    expect(r.v.said).toEqual(['Checking the board.', 'Answer to give me a status update.']);
    expect(r.types().filter((t) => t === 'audio-start')).toHaveLength(1);
    expect(r.types().slice(r.types().indexOf('turn-end'))).toEqual([
      'turn-end',
      'working',
      'audio-start',
      'reply',
      'audio-end',
    ]);
    r.send({ type: 'timing', delayMs: 1400 });
    expect(r.logs.at(-1)).toContain('cue=100ms');
  });

  it('an answer inside the threshold is said with no cue, and none follows it', async () => {
    const r = socketRig();
    await r.ask('give me a status update');
    r.clock.advance(FILLER_CUE_AFTER_MS - 1);
    r.b.release();
    await waitFor(() => r.types().includes('audio-end'));
    r.clock.advance(10_000);
    expect(r.v.said).toEqual(['Answer to give me a status update.']);
    r.send({ type: 'timing', delayMs: 900 });
    expect(r.logs.at(-1)).not.toContain('cue=');
  });

  it('a cut-in during the cue closes its stream, and the answer opens its own', async () => {
    const r = socketRig();
    await r.ask('give me a status update');
    r.clock.advance(FILLER_CUE_AFTER_MS);
    await waitFor(() => r.v.said.length === 1);
    r.send({ type: 'stop' });
    r.b.release();
    await waitFor(() => r.types().filter((t) => t === 'audio-end').length === 2);
    expect(r.types().slice(r.types().indexOf('turn-end'))).toEqual([
      'turn-end',
      'working',
      'audio-start',
      'audio-end',
      'reply',
      'audio-start',
      'audio-end',
    ]);
  });

  it('no cue once the speaker starts a new question', async () => {
    const r = socketRig();
    await r.ask('give me a status update');
    r.send({ type: 'start', setup: 1, mode: 'hold' });
    r.clock.advance(10_000);
    expect(r.v.said).toEqual([]);
  });
});

describe('the cue on a reply socket, setup 3', () => {
  it('Gemini continues the stream the cue opened', async () => {
    let events: GeminiLiveEvents | null = null;
    const answered: unknown[] = [];
    const gemini: GeminiLive = {
      name: 'fake-gemini',
      async open(o) {
        events = o.events;
        return {
          sendAudio: () => {},
          activityStart: () => {},
          activityEnd: () => {},
          endStream: () => {},
          sendText: () => {},
          answerTool: (_id, response) => answered.push(response),
          close: () => {},
        };
      },
    };
    const r = socketRig(gemini);
    r.send({ type: 'start', setup: 3, mode: 'tap' });
    await waitFor(() => events !== null);
    const ev = events as unknown as GeminiLiveEvents;
    ev.onInputText('give me a status update');
    ev.onToolCall('call-1', 'give me a status update');
    await waitFor(() => r.b.pending() > 0);
    r.clock.advance(FILLER_CUE_AFTER_MS);
    await waitFor(() => r.v.said.length === 1);
    r.b.release();
    await waitFor(() => answered.length === 1);
    ev.onAudio(new Uint8Array(4800));
    ev.onTurnComplete();
    expect(r.v.said).toEqual(['Checking the board.']);
    expect(r.types().filter((t) => t === 'audio-start')).toHaveLength(1);
    expect(r.types().at(-1)).toBe('audio-end');
  });
});
