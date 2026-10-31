/**
 * A tapped question to a board's lead ends at the end of a thought, not at
 * the listener's first end of speech: a filler or an unfinished clause keeps
 * the request open, and the words after the pause join it. A finished
 * sentence still goes the moment the listener ends it. Fake listener, fake
 * clock, and a line that records what the lead was handed.
 */
import { describe, expect, it } from 'bun:test';
import type { SpokenServerMessage } from '@claude-workspaces/core/spoken-reply';
import {
  AgentConversation,
  type AgentLine,
  type AgentVoiceFrame,
} from '../src/spoken-reply/agent-conversation.ts';
import { SpokenAnswerer, type SpokenBoard } from '../src/spoken-reply/answer.ts';
import { UNFINISHED_PAUSE_MS, unfinishedAsk } from '../src/spoken-reply/pause-gate.ts';
import { SPOKEN_TAP_TUNING, SpokenSession } from '../src/spoken-reply/session.ts';
import { SpokenTimings } from '../src/spoken-reply/timings.ts';
import type { SpokenVoice } from '../src/spoken-reply/tts.ts';
import type { TranscriptionOpenOpts } from '../src/transcribe.ts';
import { fakeClock } from './meeting-session-harness.ts';
import { waitFor } from './wait-for.ts';

const LEAD = 'riverbend-lead';
const MUTE: SpokenVoice = { name: 'mute', async speak() {} };
const BOARD: SpokenBoard = {
  async handle() {
    return { ok: true, route: 'fast-path', ack: 'The board answered.' };
  },
  goalStatus: () => undefined,
  goals: () => [],
};

async function leadSession() {
  const clock = fakeClock();
  const frames: AgentVoiceFrame[] = [];
  const line: AgentLine = {
    attached: (_ws, id) => (id === LEAD ? { name: 'Riverbend lead' } : undefined),
    deliver: (f) => {
      frames.push(f);
      return 1;
    },
  };
  let n = 0;
  const conversation = new AgentConversation(line, 'w1', () => `id-${++n}`);
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
    answerer: new SpokenAnswerer(BOARD, 'w1', undefined, undefined, conversation),
    timings: new SpokenTimings(undefined, () => {}),
    provenActor: { id: 'known-alice', name: 'Alice' },
    readOnly: false,
    parseContext: () => undefined,
    sendJson: (m) => json.push(m),
    sendAudio: () => {},
    timers: clock.timers,
  });
  s.onText(JSON.stringify({ type: 'start', setup: 1, mode: 'tap', agent: LEAD }));
  await waitFor(() => opened.length === 1, { describe: 'listener opened' });
  const o = opened[0];
  if (!o) throw new Error('no listener');
  const say = (text: string, final: boolean) => o.onTurn({ turn: 0, text, final });
  const ended = () => json.filter((m) => m.type === 'turn-end');
  return { clock, frames, say, ended, tuning: o.tuning };
}

describe('a tapped request to the lead', () => {
  it('keeps the listener’s quickest end of speech', async () => {
    const h = await leadSession();
    expect(h.tuning).toEqual(SPOKEN_TAP_TUNING);
  });

  it('a filler pause mid-sentence does not send it: the lead gets the whole sentence once', async () => {
    const h = await leadSession();
    h.say('Hey, can you', false);
    h.say('Hey, can you, uh.', true);
    // A 1.5s thinking pause, then the rest of the sentence.
    h.clock.advanceTo(1500);
    expect(h.ended()).toEqual([]);
    h.say('look at the review for Harborlight', false);
    h.clock.advanceTo(1800);
    h.say('look at the review for Harborlight.', true);
    await waitFor(() => h.frames.length === 1, { describe: 'one request reached the lead' });
    expect(h.frames[0]?.transcript).toBe('Hey, can you, uh. look at the review for Harborlight.');
    h.clock.advanceTo(20_000);
    expect(h.frames).toHaveLength(1);
  });

  it('an opener the listener ended on is held for the rest of the request', async () => {
    const h = await leadSession();
    h.say('Hey, in the review.', true);
    h.clock.advanceTo(2000);
    expect(h.ended()).toEqual([]);
    h.say('move Saltmarsh up a row.', true);
    await waitFor(() => h.frames.length === 1, { describe: 'one request reached the lead' });
    expect(h.frames[0]?.transcript).toBe('Hey, in the review. move Saltmarsh up a row.');
  });

  it('a finished sentence goes at the listener’s end of speech, with no wait', async () => {
    const h = await leadSession();
    h.say('Where are we on the Harborlight deck?', true);
    // The fake clock never moves: no timer stands between the endpoint and the lead.
    await waitFor(() => h.frames.length === 1, { describe: 'sent at the endpoint' });
    expect(h.clock.now()).toBe(0);
    expect(h.frames[0]?.transcript).toBe('Where are we on the Harborlight deck?');
  });

  it('a speaker who trails off and stops is still heard, after the unfinished wait', async () => {
    const h = await leadSession();
    h.say('Can you check the, um.', true);
    h.clock.advanceTo(UNFINISHED_PAUSE_MS - 1);
    expect(h.frames).toEqual([]);
    h.clock.advanceTo(UNFINISHED_PAUSE_MS);
    await waitFor(() => h.frames.length === 1, { describe: 'sent after the wait' });
    expect(h.frames[0]?.transcript).toBe('Can you check the, um.');
  });
});

describe('unfinishedAsk', () => {
  it('reads a filler, a dangling word, a bare "can you" or a lone opener as not yet a request', () => {
    for (const t of [
      'Hey, can you, uh.',
      'Hey, can you',
      'Could you',
      'Hey, in the review.',
      'Okay so.',
      'Look at the',
      'Um.',
    ]) {
      expect(unfinishedAsk(t)).toBe(true);
    }
  });

  it('reads a finished request, or any question, as done', () => {
    for (const t of [
      'Where are we on the Harborlight deck?',
      'Hey, what is blocking Riverbend?',
      'Merge the Saltmarsh PR.',
      'Hey, merge the Saltmarsh PR now please.',
      'Thank you.',
      '',
    ]) {
      expect(unfinishedAsk(t)).toBe(false);
    }
  });
});
