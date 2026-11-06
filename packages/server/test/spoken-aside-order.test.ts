/**
 * Answers said unasked on one socket, in the order they came: none cuts off
 * another, none is lost to the speaker talking, and a page asking to listen
 * does not stop one. Fake engines; nothing reaches a vendor.
 */
import { describe, expect, it } from 'bun:test';
import type { SpokenServerMessage } from '@claude-workspaces/core/spoken-reply';
import { SpokenAnswerer, type SpokenBoard, shapedAnswer } from '../src/spoken-reply/answer.ts';
import { LEAD_ANSWER_ROUTE } from '../src/spoken-reply/lead-answer.ts';
import { SpokenSession } from '../src/spoken-reply/session.ts';
import { SpokenTimings } from '../src/spoken-reply/timings.ts';
import type { SpokenVoice } from '../src/spoken-reply/tts.ts';
import type { TranscriptionEngine, TranscriptionOpenOpts } from '../src/transcribe.ts';
import { waitFor } from './wait-for.ts';

const BOARD: SpokenBoard = {
  async handle() {
    return { ok: true, route: 'fast-path', ack: 'Saltmarsh has three open tasks.' };
  },
  goalStatus: () => undefined,
  goals: () => [],
};

function rig() {
  const opened: TranscriptionOpenOpts[] = [];
  const listener: TranscriptionEngine = {
    name: 'fake',
    async open(o) {
      opened.push(o);
      return { send: () => {}, close: async () => {} };
    },
  };
  const said: string[] = [];
  const finishers: Array<() => void> = [];
  let aborted = 0;
  const voice: SpokenVoice = {
    name: 'fake',
    speak(text, onAudio, signal) {
      said.push(text);
      onAudio(new Uint8Array([1, 0]));
      return new Promise<void>((resolve) => {
        finishers.push(resolve);
        signal.addEventListener('abort', () => {
          aborted++;
          resolve();
        });
      });
    },
  };
  const json: SpokenServerMessage[] = [];
  const session = new SpokenSession({
    engines: { listener, voices: { 1: voice, 2: null }, gemini: null },
    answerer: new SpokenAnswerer(BOARD, 'w1'),
    timings: new SpokenTimings(undefined, () => {}),
    provenActor: { id: 'known-alice', name: 'Alice' },
    readOnly: false,
    parseContext: () => undefined,
    sendJson: (m) => json.push(m),
    sendAudio: () => {},
  });
  const send = (m: unknown): void => session.onText(JSON.stringify(m));
  const lead = (words: string): void =>
    session.sayLead('q', shapedAnswer(words, LEAD_ANSWER_ROUTE));
  /** The voice sends its last chunk of what it is saying now. */
  const finishSaying = (): void => finishers.shift()?.();
  const start = (): void => send({ type: 'start', setup: 1, mode: 'tap' });
  const hear = (text: string, final: boolean): void =>
    opened.at(-1)?.onTurn({ turn: 0, text, final });
  return {
    opened,
    said,
    json,
    send,
    lead,
    finishSaying,
    start,
    hear,
    get aborted() {
      return aborted;
    },
  };
}

describe('asides on one socket', () => {
  it('says four back to back in order, cutting none off', async () => {
    const r = rig();
    r.start();
    await waitFor(() => r.opened.length === 1, { describe: 'listening' });
    for (const n of [1, 2, 3, 4]) r.lead(`Answer ${n}.`);
    // Every answer is in the chat at once; the voice has the first.
    expect(r.json.filter((m) => m.type === 'reply')).toHaveLength(4);
    expect(r.said).toEqual(['Answer 1.']);
    for (const n of [2, 3, 4]) {
      r.finishSaying();
      await waitFor(() => r.said.length === n, { describe: `answer ${n} said` });
    }
    expect(r.said).toEqual(['Answer 1.', 'Answer 2.', 'Answer 3.', 'Answer 4.']);
    expect(r.aborted).toBe(0);
  });

  it('holds an answer while the speaker talks and says it after their question', async () => {
    const r = rig();
    r.start();
    await waitFor(() => r.opened.length === 1, { describe: 'listening' });
    r.hear('and while you are', false);
    r.lead('Answer 1.');
    expect(r.said).toEqual([]);
    r.hear('and while you are at it, what is open?', true);
    await waitFor(() => r.said.length === 1, { describe: 'the question answered' });
    expect(r.said[0]).toContain('Saltmarsh');
    r.finishSaying();
    await waitFor(() => r.said.length === 2, { describe: 'the held answer said' });
    expect(r.said[1]).toBe('Answer 1.');
    expect(r.aborted).toBe(0);
  });

  it('a start that crosses an answer leaves it playing, and listens after the last', async () => {
    const r = rig();
    r.start();
    await waitFor(() => r.opened.length === 1, { describe: 'listening' });
    r.lead('Answer 1.');
    r.lead('Answer 2.');
    r.start();
    r.finishSaying();
    await waitFor(() => r.said.length === 2, { describe: 'the second answer said' });
    expect(r.aborted).toBe(0);
    expect(r.opened).toHaveLength(1);
    r.finishSaying();
    await waitFor(() => r.opened.length === 2, { describe: 'listening again' });
    expect(r.said).toEqual(['Answer 1.', 'Answer 2.']);
  });

  it('a stop cuts the answer off, drops the rest, and the next start listens', async () => {
    const r = rig();
    r.start();
    await waitFor(() => r.opened.length === 1, { describe: 'listening' });
    r.lead('Answer 1.');
    r.lead('Answer 2.');
    r.send({ type: 'stop' });
    expect(r.aborted).toBe(1);
    r.start();
    await waitFor(() => r.opened.length === 2, { describe: 'listening again' });
    expect(r.said).toEqual(['Answer 1.']);
  });
});
