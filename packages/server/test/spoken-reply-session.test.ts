/**
 * One reply panel's socket, driven with fake engines: a listener whose turns
 * the test emits, a voice that streams what the test tells it to, and a
 * Gemini whose events the test fires. Nothing reaches a vendor.
 */
import { describe, expect, it } from 'bun:test';
import type { SpokenServerMessage } from '@claude-workspaces/core/spoken-reply';
import { isUnprovenActor } from '../src/review-items/answer-proof.ts';
import { SpokenAnswerer, type SpokenBoard } from '../src/spoken-reply/answer.ts';
import type {
  GeminiLive,
  GeminiLiveEvents,
  GeminiLiveSession,
} from '../src/spoken-reply/gemini-live.ts';
import {
  SPOKEN_TAP_TUNING,
  type SpokenEngines,
  SpokenSession,
  availableSetups,
} from '../src/spoken-reply/session.ts';
import { SpokenTimings } from '../src/spoken-reply/timings.ts';
import type { SpokenVoice } from '../src/spoken-reply/tts.ts';
import type { TranscriptionEngine, TranscriptionOpenOpts } from '../src/transcribe.ts';
import type { VoiceActor } from '../src/voice-action.ts';
import { waitFor } from './wait-for.ts';

const BOARD: SpokenBoard = {
  async handle(_ws, req) {
    return {
      ok: true,
      route: 'fast-path',
      ack: `Heard: "${req.transcript}". Harborlight: 3 open. In progress: “a”. Waiting on you: 1 — “b”.`,
    };
  },
  goalStatus: () => undefined,
  goals: () => [],
};

/** `stuckClose`: the flush never answers, as a slow Soniox round trip. */
function fakeListener(opts: { stuckClose?: boolean } = {}) {
  const opened: TranscriptionOpenOpts[] = [];
  const audio: number[] = [];
  let closes = 0;
  const engine: TranscriptionEngine = {
    name: 'fake',
    async open(o) {
      opened.push(o);
      return {
        send: (pcm) => audio.push(pcm.length),
        close: () => {
          closes++;
          return opts.stuckClose ? new Promise<void>(() => {}) : Promise.resolve();
        },
      };
    },
  };
  return {
    engine,
    opened,
    audio,
    get closes() {
      return closes;
    },
    turn: (text: string, final: boolean) =>
      opened[opened.length - 1]?.onTurn({ turn: 0, text, final }),
  };
}

function fakeVoice(chunks = 2) {
  const said: string[] = [];
  let aborted = 0;
  let release: (() => void) | null = null;
  const voice: SpokenVoice = {
    name: 'fake',
    speak(text, onAudio, signal) {
      said.push(text);
      return new Promise<void>((resolve) => {
        onAudio(new Uint8Array([1, 0]));
        const end = (): void => {
          for (let i = 1; i < chunks; i++) onAudio(new Uint8Array([2, 0]));
          resolve();
        };
        release = end;
        signal.addEventListener('abort', () => {
          aborted++;
          resolve();
        });
      });
    },
  };
  return {
    voice,
    said,
    get aborted() {
      return aborted;
    },
    finish: () => release?.(),
  };
}

function harness(engines: Partial<SpokenEngines>, opts: { readOnly?: boolean } = {}) {
  const json: SpokenServerMessage[] = [];
  const audio: number[] = [];
  const logs: string[] = [];
  const full: SpokenEngines = {
    listener: null,
    voices: { 1: null, 2: null },
    gemini: null,
    ...engines,
  };
  const session = new SpokenSession({
    engines: full,
    answerer: new SpokenAnswerer(BOARD, 'w1'),
    timings: new SpokenTimings(undefined, (l) => logs.push(l)),
    provenActor: { id: 'known-alice', name: 'Alice' },
    readOnly: opts.readOnly === true,
    parseContext: () => undefined,
    sendJson: (m) => json.push(m),
    sendAudio: (pcm) => audio.push(pcm.length),
  });
  const types = () => json.map((m) => m.type);
  const send = (m: unknown) => session.onText(JSON.stringify(m));
  return { session, json, audio, logs, types, send };
}

describe('availableSetups', () => {
  it('each setup needs its own engines', () => {
    const v = fakeVoice().voice;
    const l = fakeListener().engine;
    expect(availableSetups({ listener: null, voices: { 1: v, 2: v }, gemini: null })).toEqual([]);
    expect(availableSetups({ listener: l, voices: { 1: v, 2: null }, gemini: null })).toEqual([1]);
    expect(
      availableSetups({ listener: l, voices: { 1: v, 2: v }, gemini: {} as GeminiLive }),
    ).toEqual([1, 2, 3]);
  });
});

describe('SpokenSession, setups 1 and 2', () => {
  it('hold: hears, answers when released, speaks the first two sentences', async () => {
    const l = fakeListener();
    const v = fakeVoice();
    const h = harness({ listener: l.engine, voices: { 1: v.voice, 2: null } });
    h.session.open();
    expect(h.json[0]).toEqual({ type: 'ready', setups: [1], timings: {} });
    h.send({ type: 'start', setup: 1, mode: 'hold' });
    // Audio said before the listener opens is held, then sent.
    h.session.onAudio(new Uint8Array(1600));
    await waitFor(() => l.opened.length === 1 && l.audio.length === 1, { describe: 'buffer sent' });
    expect(l.opened[0]?.tuning).toEqual(SPOKEN_TAP_TUNING);
    expect(l.opened[0]?.sampleRate).toBe(16000);
    l.turn('Claude, give me a', false);
    l.turn('Claude, give me a status update.', true);
    // Hold mode: a final turn does not end the question; release does.
    expect(h.types()).toEqual(['ready', 'heard', 'heard']);
    h.send({ type: 'end' });
    await waitFor(() => v.said.length === 1, { describe: 'voice spoke' });
    v.finish();
    // Point by point: the second sentence is said once the first is.
    await waitFor(() => v.said.length === 2, { describe: 'second point' });
    expect(v.said).toEqual(['Harborlight: 3 open.', 'Waiting on you: 1 — “b”.']);
    v.finish();
    await waitFor(() => h.types().includes('audio-end'), { describe: 'audio-end' });
    expect(h.types()).toEqual([
      'ready',
      'heard',
      'heard',
      'turn-end',
      'working',
      'reply',
      'audio-start',
      'note',
      'audio-end',
    ]);
    const reply = h.json.find((m) => m.type === 'reply');
    expect(reply).toMatchObject({
      detail: ['In progress: “a”.'],
      asking: false,
      route: 'fast-path',
    });
    expect(h.audio).toEqual([2, 2, 2, 2]);
    expect(l.closes).toBe(1);
  });

  it('tap: the end of speech, at most 500 ms after the last word, sends the question on without waiting for the flush', async () => {
    const l = fakeListener({ stuckClose: true });
    const v = fakeVoice();
    const h = harness({ listener: l.engine, voices: { 1: v.voice, 2: null } });
    h.send({ type: 'start', setup: 1, mode: 'tap' });
    await waitFor(() => l.opened.length === 1);
    expect(l.opened[0]?.tuning).toEqual({ max_endpoint_delay_ms: 500 });
    l.turn('where are we', true);
    // The flush never answers, and the question still reaches the answerer.
    await waitFor(() => h.types().includes('working'), { describe: 'sent to the answerer' });
    const t = h.types();
    expect(t.slice(t.indexOf('turn-end'), t.indexOf('turn-end') + 2)).toEqual([
      'turn-end',
      'working',
    ]);
    expect(l.closes).toBe(1);
    await waitFor(() => v.said.length === 1, { describe: 'voice spoke' });
    expect(h.json.find((m) => m.type === 'turn-end')).toEqual({
      type: 'turn-end',
      text: 'where are we',
    });
  });

  it('stop cuts the voice off and nothing more of it is sent', async () => {
    const l = fakeListener();
    const v = fakeVoice(3);
    const h = harness({ listener: l.engine, voices: { 1: v.voice, 2: null } });
    h.send({ type: 'start', setup: 1, mode: 'tap' });
    await waitFor(() => l.opened.length === 1);
    l.turn('where are we', true);
    await waitFor(() => v.said.length === 1);
    h.send({ type: 'stop' });
    await waitFor(() => h.types().includes('audio-end'), { describe: 'audio-end after stop' });
    expect(v.aborted).toBe(1);
    v.finish();
    expect(h.audio).toEqual([2]);
  });

  it('a new start while speaking stops the old answer', async () => {
    const l = fakeListener();
    const v = fakeVoice();
    const h = harness({ listener: l.engine, voices: { 1: v.voice, 2: null } });
    h.send({ type: 'start', setup: 1, mode: 'tap' });
    await waitFor(() => l.opened.length === 1);
    l.turn('where are we', true);
    await waitFor(() => v.said.length === 1);
    h.send({ type: 'start', setup: 1, mode: 'hold' });
    expect(v.aborted).toBe(1);
    await waitFor(() => l.opened.length === 2);
  });

  it('a tapped choice is answered and spoken as if it had been said', async () => {
    const l = fakeListener();
    const v = fakeVoice();
    const h = harness({ listener: l.engine, voices: { 1: v.voice, 2: null } });
    h.send({ type: 'start', setup: 1, mode: 'tap' });
    await waitFor(() => l.opened.length === 1);
    h.send({ type: 'say', text: 'where are we' });
    await waitFor(() => v.said.length === 1, { describe: 'voice spoke the choice' });
    expect(h.json.find((m) => m.type === 'turn-end')).toEqual({
      type: 'turn-end',
      text: 'where are we',
    });
    expect(l.closes).toBe(1);
  });

  it('a held setup is named in ready and refused with its line; setup 1 still runs', async () => {
    const l = fakeListener();
    const v = fakeVoice();
    const line = 'Setup 2 waits on turning off ElevenLabs training.';
    const h = harness({ listener: l.engine, voices: { 1: v.voice, 2: null }, held: { '2': line } });
    h.session.open();
    expect(h.json[0]).toEqual({ type: 'ready', setups: [1], held: { '2': line }, timings: {} });
    h.send({ type: 'start', setup: 2, mode: 'hold' });
    expect(h.json[1]).toEqual({ type: 'error', message: line });
    expect(l.opened.length).toBe(0);
    h.send({ type: 'start', setup: 1, mode: 'hold' });
    await waitFor(() => l.opened.length === 1, { describe: 'setup 1 listens' });
  });

  it('an unconfigured setup 4 says what it lacks and opens nothing', () => {
    const line = 'Setup 4 is not set up on this server yet: it needs the elevenlabs-agent-id card.';
    const h = harness({ held: { '4': line } });
    h.session.open();
    expect(h.json[0]).toEqual({ type: 'ready', setups: [], held: { '4': line }, timings: {} });
    h.send({ type: 'start', setup: 4, mode: 'tap' });
    h.session.onAudio(new Uint8Array(4));
    h.send({ type: 'end' });
    expect(h.json.slice(1)).toEqual([{ type: 'error', message: line }]);
  });

  it('a setup this server cannot run, and a read-only socket, are refused', () => {
    const h = harness({});
    h.send({ type: 'start', setup: 2, mode: 'hold' });
    expect(h.json[0]).toEqual({ type: 'error', message: 'Setup 2 is not set up on this server.' });
    const ro = harness({}, { readOnly: true });
    ro.send({ type: 'start', setup: 1, mode: 'hold' });
    expect(ro.json[0]).toEqual({ type: 'error', message: 'Sign in to use the mic.' });
  });

  it('a timing is logged against the setup and the summary comes back', async () => {
    const l = fakeListener();
    const v = fakeVoice();
    const h = harness({ listener: l.engine, voices: { 1: null, 2: v.voice } });
    h.send({ type: 'start', setup: 2, mode: 'hold' });
    h.send({ type: 'timing', delayMs: 812, endpointMs: 300, replyMs: 12, audioMs: 500 });
    expect(h.logs).toEqual([
      '[spoken-reply] setup=2 delay=812ms endpoint=300ms reply=12ms audio=500ms',
    ]);
    expect(h.json.at(-1)).toEqual({
      type: 'timings',
      summary: { '2': { n: 1, medianMs: 812, p90Ms: 812, lastMs: 812 } },
    });
  });

  it('each noted point’s lead rides the same log line, early as negative', () => {
    const h = harness({});
    h.send({ type: 'timing', delayMs: 700, noteLeadMs: [-150, -42.4] });
    expect(h.logs).toEqual(['[spoken-reply] setup=1 delay=700ms note-lead=-150,-42ms']);
    // A lead past the bound is not a measurement: the timing is kept without it.
    h.send({ type: 'timing', delayMs: 700, noteLeadMs: [-150, 500_000] });
    expect(h.logs.at(-1)).toBe('[spoken-reply] setup=1 delay=700ms');
  });
});

describe('SpokenSession, setup 3', () => {
  function fakeGemini() {
    const sent: string[] = [];
    let events: GeminiLiveEvents | null = null;
    const opens: boolean[] = [];
    const live: GeminiLive = {
      name: 'fake-gemini',
      async open({ manual, events: e }) {
        opens.push(manual);
        events = e;
        const s: GeminiLiveSession = {
          sendAudio: () => sent.push('audio'),
          activityStart: () => sent.push('activityStart'),
          activityEnd: () => sent.push('activityEnd'),
          endStream: () => sent.push('endStream'),
          sendText: (t) => sent.push(`text:${t}`),
          answerTool: (id, r) => sent.push(`tool:${id}:${String(r.spoken)}`),
          close: () => sent.push('close'),
        };
        return s;
      },
    };
    return {
      live,
      sent,
      opens,
      get events() {
        if (!events) throw new Error('not open');
        return events;
      },
    };
  }

  it('tap with Soniox beside it: words show as said, and its end of speech asks the board before Gemini does', async () => {
    const g = fakeGemini();
    const l = fakeListener();
    const h = harness({ gemini: g.live, listener: l.engine });
    h.send({ type: 'start', setup: 3, mode: 'tap' });
    await waitFor(() => l.opened.length === 1 && g.opens.length === 1, { describe: 'both open' });
    expect(l.opened[0]?.tuning).toEqual({ max_endpoint_delay_ms: 500 });
    h.session.onAudio(new Uint8Array(1600));
    await waitFor(() => l.audio.length === 1 && g.sent.includes('audio'), {
      describe: 'both hear',
    });
    l.turn('give me a', false);
    expect(h.json.at(-1)).toEqual({ type: 'heard', text: 'give me a' });
    // Gemini's late transcript is not shown over Soniox's.
    g.events.onInputText('give me a status update');
    expect(h.types().filter((t) => t === 'heard')).toHaveLength(1);
    l.turn('give me a status update', true);
    await waitFor(() => h.types().includes('working'), { describe: 'sent to the board' });
    expect(h.types().slice(-2)).toEqual(['turn-end', 'working']);
    // Soniox's end of speech is Gemini's too: its turn is bracketed.
    expect(g.opens).toEqual([true]);
    await waitFor(() => g.sent.includes('activityEnd'), { describe: 'Gemini turn ended' });
    expect(g.sent.filter((x) => x === 'activityStart')).toHaveLength(1);
    g.events.onToolCall('c1', 'status update');
    await waitFor(() => g.sent.some((s) => s.startsWith('tool:')), { describe: 'tool answered' });
    expect(g.sent.at(-1)).toBe('tool:c1:Harborlight: 3 open. Waiting on you: 1 — “b”.');
    // One question, asked once.
    expect(h.types().filter((t) => t === 'turn-end' || t === 'working' || t === 'reply')).toEqual([
      'turn-end',
      'working',
      'reply',
    ]);
  });

  it('hold: brackets the turn, answers the tool call from the board, forwards the voice', async () => {
    const g = fakeGemini();
    const h = harness({ gemini: g.live });
    h.send({ type: 'start', setup: 3, mode: 'hold' });
    h.session.onAudio(new Uint8Array(1600));
    await waitFor(() => g.sent.includes('audio'), { describe: 'buffered audio sent' });
    expect(g.sent.slice(0, 2)).toEqual(['activityStart', 'audio']);
    h.send({ type: 'end' });
    await waitFor(() => g.sent.includes('activityEnd'));
    g.events.onInputText('give me a status update');
    g.events.onToolCall('c1', 'give me a status update');
    await waitFor(() => g.sent.some((s) => s.startsWith('tool:')), { describe: 'tool answered' });
    expect(g.sent.at(-1)).toBe('tool:c1:Harborlight: 3 open. Waiting on you: 1 — “b”.');
    g.events.onAudio(new Uint8Array(4));
    g.events.onAudio(new Uint8Array(4));
    g.events.onTurnComplete();
    expect(h.types()).toEqual([
      'heard',
      'turn-end',
      'working',
      'reply',
      'note',
      'audio-start',
      'audio-end',
    ]);
    expect(h.audio).toEqual([4, 4]);
  });

  it('one Gemini session per socket; a second question reuses it', async () => {
    const g = fakeGemini();
    const h = harness({ gemini: g.live });
    h.send({ type: 'start', setup: 3, mode: 'tap' });
    await waitFor(() => g.opens.length === 1);
    h.send({ type: 'end' });
    await waitFor(() => g.sent.includes('endStream'));
    h.send({ type: 'start', setup: 3, mode: 'tap' });
    expect(g.opens).toEqual([false]);
  });

  it('stop drops the rest of the model’s audio', async () => {
    const g = fakeGemini();
    const h = harness({ gemini: g.live });
    h.send({ type: 'start', setup: 3, mode: 'tap' });
    await waitFor(() => g.opens.length === 1);
    g.events.onAudio(new Uint8Array(4));
    h.send({ type: 'stop' });
    g.events.onAudio(new Uint8Array(4));
    expect(h.audio).toEqual([4]);
    expect(h.types()).toEqual(['audio-start', 'audio-end']);
  });
});

/** A socket whose upgrade proved `provenActor`, recording what the board heard. */
function hearingSession(provenActor: VoiceActor | null) {
  const heard: VoiceActor[] = [];
  const board: SpokenBoard = {
    ...BOARD,
    async handle(ws, req) {
      heard.push(req.actor as VoiceActor);
      return BOARD.handle(ws, req);
    },
  };
  const session = new SpokenSession({
    engines: {
      listener: fakeListener().engine,
      voices: { 1: fakeVoice().voice, 2: null },
      gemini: null,
    },
    answerer: new SpokenAnswerer(board, 'w1'),
    timings: new SpokenTimings(undefined, () => {}),
    provenActor,
    readOnly: false,
    parseContext: () => undefined,
    sendJson: () => {},
    sendAudio: () => {},
  });
  const say = async (text: string): Promise<VoiceActor | undefined> => {
    const n = heard.length;
    session.onText(JSON.stringify({ type: 'say', text }));
    await waitFor(() => heard.length > n, { describe: 'the say reached the board' });
    return heard[n];
  };
  return { session, say };
}

describe('SpokenSession, the actor an answer is recorded for', () => {
  const OWNER_CLAIM = { id: 'known-bryan', name: 'Bryan', kind: 'person' };

  it('a say before any start frame reaches the board as an unproven actor', async () => {
    // The actor before `start` was a shared, unmarked object whose kind reads as a person's.
    const s = hearingSession(null);
    expect(isUnprovenActor((await s.say('Ship today.')) as VoiceActor)).toBe(true);
  });

  it("a start frame's author is a claim: marked unproven when the upgrade proved nobody", async () => {
    const s = hearingSession(null);
    s.session.onText(
      JSON.stringify({ type: 'start', setup: 1, mode: 'hold', author: OWNER_CLAIM }),
    );
    const actor = await s.say('Ship today.');
    expect(actor?.id).toBe('known-bryan');
    expect(isUnprovenActor(actor as VoiceActor)).toBe(true);
  });

  it("POSITIVE CONTROL: the upgrade's proven actor is used unmarked, whatever the frame claims", async () => {
    const s = hearingSession({ id: 'known-alice', name: 'Alice' });
    s.session.onText(
      JSON.stringify({ type: 'start', setup: 1, mode: 'hold', author: OWNER_CLAIM }),
    );
    const actor = await s.say('Ship today.');
    expect(actor?.id).toBe('known-alice');
    expect(isUnprovenActor(actor as VoiceActor)).toBe(false);
  });
});
