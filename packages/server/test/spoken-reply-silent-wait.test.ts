/**
 * A request the lead took is not acknowledged aloud: no "On it." (Bryan,
 * 2026-10-31). The page is told `working`, and the lead's answer is the only
 * speech for it. Driven through a reply socket on a fake clock with a board
 * whose answer the test releases, and through setup 4's custom-LLM answer.
 * The slow-answer cue (`filler-cue.ts`) is unchanged and has its own test.
 */
import { describe, expect, it } from 'bun:test';
import type { SpokenServerMessage } from '@claude-workspaces/core/spoken-reply';
import { AgentCallbacks } from '../src/spoken-reply/agent-llm.ts';
import { AgentTurns } from '../src/spoken-reply/agent-turns.ts';
import { SpokenAnswerer, type SpokenBoard } from '../src/spoken-reply/answer.ts';
import { createElevenLabsAgent } from '../src/spoken-reply/elevenlabs-agent.ts';
import { FILLER_CUE_AFTER_MS } from '../src/spoken-reply/filler-cue.ts';
import type { GateTimers } from '../src/spoken-reply/pause-gate.ts';
import { SpokenSession } from '../src/spoken-reply/session.ts';
import { SpokenTimings } from '../src/spoken-reply/timings.ts';
import type { SpokenVoice } from '../src/spoken-reply/tts.ts';
import type { TranscriptionEngine, TranscriptionOpenOpts } from '../src/transcribe.ts';
import type { VoiceHandleResult } from '../src/voice.ts';
import { waitFor } from './wait-for.ts';

const ACTOR = { id: 'known-alice', name: 'Alice', kind: 'known' };

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

/** A board whose answer arrives when the test releases it. */
function slowBoard(result: (transcript: string) => VoiceHandleResult) {
  const waiting: Array<() => void> = [];
  const board: SpokenBoard = {
    handle: (_ws, req) =>
      new Promise((resolve) => waiting.push(() => resolve(result(req.transcript)))),
    goalStatus: () => undefined,
    goals: () => [],
  };
  return { board, release: () => waiting.shift()?.(), pending: () => waiting.length };
}

function rig(result: (transcript: string) => VoiceHandleResult) {
  const clock = fakeClock();
  const b = slowBoard(result);
  const opened: TranscriptionOpenOpts[] = [];
  const listener: TranscriptionEngine = {
    name: 'fake',
    async open(opts) {
      opened.push(opts);
      return { send: () => {}, close: async () => {} };
    },
  };
  const said: string[] = [];
  const voice: SpokenVoice = {
    name: 'recorded',
    async speak(text, onAudio) {
      said.push(text);
      onAudio(new Uint8Array(480));
    },
  };
  const json: SpokenServerMessage[] = [];
  const session = new SpokenSession({
    engines: { listener, voices: { 1: voice, 2: null }, gemini: null },
    answerer: new SpokenAnswerer(b.board, 'w1'),
    timings: new SpokenTimings(undefined, () => {}),
    provenActor: { id: 'known-alice', name: 'Alice' },
    readOnly: false,
    parseContext: () => undefined,
    sendJson: (m) => json.push(m),
    sendAudio: () => {},
    timers: clock.timers,
  });
  const send = (m: unknown) => session.onText(JSON.stringify(m));
  const ask = async (text: string) => {
    send({ type: 'start', setup: 1, mode: 'hold' });
    await waitFor(() => opened.length > 0);
    opened.at(-1)?.onTurn({ turn: 0, text, final: true });
    send({ type: 'end' });
    await waitFor(() => b.pending() > 0);
  };
  return { clock, b, said, json, ask, types: () => json.map((m) => m.type) };
}

describe('a hand-off to the lead on a reply socket', () => {
  it('a request the lead took: the page is told working, and nothing is said', async () => {
    const r = rig(() => ({ ok: true, route: 'agent', ack: 'Heard: "x". On it.', queueId: 'q-1' }));
    await r.ask('go research ferry fares to Riverbend');
    // Routed inside the cue's threshold, so the cue never fires either.
    r.clock.advance(FILLER_CUE_AFTER_MS - 1);
    expect(r.types()).toContain('working');
    r.b.release();
    await waitFor(() => r.types().includes('reply'));
    r.clock.advance(FILLER_CUE_AFTER_MS * 10);
    const reply = r.json.find((m) => m.type === 'reply');
    expect(reply).toMatchObject({ spoken: '', route: 'agent' });
    expect(r.said).toEqual([]);
    expect(r.types()).not.toContain('audio-start');
  });
});

describe('setup 4', () => {
  it('a request the lead took hands ElevenLabs nothing to say', async () => {
    class Spy extends AgentCallbacks {
      tokens: string[] = [];
      override mint(answer: (question: string) => Promise<string>): string {
        const t = super.mint(answer);
        this.tokens.push(t);
        return t;
      }
    }
    const callbacks = new Spy();
    const agent = createElevenLabsAgent({
      apiKey: 'placeholder-key',
      agentId: 'agent_fixture01',
      socketFactory: (args) => {
        queueMicrotask(() => args.onOpen());
        return { send: () => {}, close: () => {} };
      },
    });
    const board: SpokenBoard = {
      handle: async () => ({ ok: true, route: 'agent', ack: 'On it.', queueId: 'q-4' }),
      goalStatus: () => undefined,
      goals: () => [],
    };
    const answerer = new SpokenAnswerer(board, 'w1');
    const json: SpokenServerMessage[] = [];
    const turns = new AgentTurns({
      agent,
      callbacks,
      answer: (t) => answerer.answer(t, ACTOR, undefined),
      sendJson: (m) => json.push(m),
      sendAudio: () => {},
    });
    turns.start();
    await waitFor(() => callbacks.tokens.length === 1);
    const spoken = await callbacks.answer(callbacks.tokens[0] ?? '', 'go research ferry fares');
    expect(spoken).toBe('');
    expect(json.find((m) => m.type === 'reply')).toMatchObject({ spoken: '', route: 'agent' });
    turns.close();
  });
});
