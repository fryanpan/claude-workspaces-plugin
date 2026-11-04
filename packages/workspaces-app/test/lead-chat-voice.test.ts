/**
 * The lead chat's voice: the converse socket, aimed at the lead. A question
 * names the lead in `start` and streams the mic behind it; once the lead
 * takes the question, or its answer has been said, the next question listens
 * by itself on the same open mic, and no frame goes up while an answer is
 * said.
 * The socket and the microphone are fakes.
 */
import type { SpokenServerMessage } from '@claude-workspaces/core/spoken-reply';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type LeadVoice,
  type LeadVoiceState,
  NO_VOICE,
  WORKING_MS,
  createLeadVoice,
} from '../src/lead-chat/lead-chat-voice.ts';
import { fakeVoice, settle } from './lead-chat-voice-fakes.ts';

const ME = { id: 'known-bryan', name: 'Bryan', kind: 'known' };

let voice: LeadVoice | null = null;
afterEach(() => {
  voice?.destroy();
  voice = null;
});

function make(setups?: Array<1 | 2 | 3 | 4>) {
  const fake = fakeVoice(setups ? { setups } : {});
  const seen: LeadVoiceState[] = [];
  voice = createLeadVoice({
    ...fake.seams,
    workspaceId: 'w-harbor',
    author: ME,
    getContext: () => ({ surface: 'board' }),
    agent: () => 'harborlight-lead',
    onChange: (s) => seen.push(s),
  });
  return { ...fake, seen, voice };
}

describe('the lead chat voice', () => {
  it('names the lead in start and streams the mic behind it, on the converse socket', async () => {
    const { voice, socket, mic, speak } = make();
    voice.start();
    await settle();
    const ws = socket();
    expect(ws.url).toMatch(/\/workspaces\/w-harbor\/voice\/converse$/);
    expect(mic.starts).toBe(1);
    speak();
    ws.open();
    expect(ws.messages()[0]).toMatchObject({
      type: 'start',
      setup: 1,
      mode: 'tap',
      agent: 'harborlight-lead',
      author: ME,
      context: { surface: 'board' },
    });
    expect(ws.frames()).toBe(1);
    expect(voice.state().phase).toBe('listening');
  });

  it('shows what is heard, then working, speaking, and listens again once said', async () => {
    const { voice, socket, mic, speak } = make();
    voice.start();
    await settle();
    const ws = socket();
    ws.open();
    ws.serve({ type: 'heard', text: 'read me the' });
    expect(voice.state()).toMatchObject({ phase: 'listening', heard: 'read me the' });
    ws.serve({ type: 'turn-end', text: 'read me the next one' });
    expect(voice.state().phase).toBe('working');
    // The mic stays open, but nothing it hears goes up while the lead answers.
    speak();
    expect(ws.frames()).toBe(0);
    ws.serve({
      type: 'reply',
      spoken: 'The ferry task.',
      detail: [],
      asking: false,
      route: 'agent',
    });
    ws.serve({ type: 'audio-start', sampleRate: 24_000 });
    expect(voice.state().phase).toBe('speaking');
    ws.serve({ type: 'audio-end' });
    await settle();
    await settle();
    expect(voice.state().phase).toBe('listening');
    expect(ws.messages().filter((m) => m.type === 'start')).toHaveLength(2);
    speak();
    expect(ws.frames()).toBe(1);
    expect([mic.starts, mic.stops]).toEqual([1, 0]);
  });

  // Bryan, 3 Nov: "when the agent starts thinking I can no longer record
  // anything". The next question listens while the lead works on this one.
  it('listens again while the lead works, and holds the mic back while its answer is said', async () => {
    const { voice, socket, speak } = make();
    voice.start();
    await settle();
    const ws = socket();
    ws.open();
    ws.serve({ type: 'turn-end', text: 'what is next' });
    // The router hands it to the lead and says nothing yet.
    ws.serve({ type: 'reply', spoken: '', detail: [], asking: false, route: 'agent' });
    await settle();
    expect(voice.state().phase).toBe('listening');
    expect(ws.messages().filter((m) => m.type === 'start')).toHaveLength(2);
    // What is said while the lead thinks goes up, as the next question.
    speak();
    expect(ws.frames()).toBe(1);
    // The lead's answer arrives, and is said; the mic hears the speaker and
    // sends none of it back.
    ws.serve({
      type: 'reply',
      spoken: 'The ferry task.',
      detail: [],
      asking: false,
      route: 'lead-answer',
    });
    ws.serve({ type: 'audio-start', sampleRate: 24_000 });
    expect(voice.state().phase).toBe('speaking');
    speak();
    expect(ws.frames()).toBe(1);
    ws.serve({ type: 'audio-end' });
    await settle();
    await settle();
    expect(voice.state().phase).toBe('listening');
    expect(ws.messages().filter((m) => m.type === 'start')).toHaveLength(3);
    speak();
    expect(ws.frames()).toBe(2);
  });

  it('a stop while the lead works keeps the socket, so its answer still lands', async () => {
    const { voice, socket } = make();
    voice.start();
    await settle();
    const ws = socket();
    ws.open();
    ws.serve({ type: 'turn-end', text: 'what is next' });
    ws.serve({ type: 'reply', spoken: '', detail: [], asking: false, route: 'agent' });
    await settle();
    voice.stop();
    expect(ws.closed).toBe(false);
    expect(ws.messages().at(-1)).toEqual({ type: 'stop' });
    // Answered while voice was off: the next stop while listening has
    // nothing to wait for, and lets the socket go.
    ws.serve({ type: 'reply', spoken: 'Done.', detail: [], asking: false, route: 'lead-answer' });
    voice.start();
    await settle();
    voice.stop();
    expect(ws.closed).toBe(true);
  });

  const cases: Array<[string, SpokenServerMessage[]]> = [
    ['no reply', []],
    [
      'a reply whose voice never starts',
      [{ type: 'reply', spoken: 'Three open.', detail: [], asking: false, route: 'brief' }],
    ],
  ];
  for (const [name, after] of cases) {
    it(`listens again by itself when working ends in ${name}`, async () => {
      vi.useFakeTimers();
      try {
        const { voice, socket, speak } = make();
        voice.start();
        await vi.advanceTimersByTimeAsync(0);
        const ws = socket();
        ws.open();
        speak();
        ws.serve({ type: 'turn-end', text: 'give me a status update' });
        for (const m of after) ws.serve(m);
        await vi.advanceTimersByTimeAsync(WORKING_MS - 1);
        expect(voice.state().phase).toBe('working');
        await vi.advanceTimersByTimeAsync(1);
        expect(voice.state().phase).toBe('listening');
        expect(ws.messages().filter((m) => m.type === 'start')).toHaveLength(2);
      } finally {
        vi.useRealTimers();
      }
    });
  }

  it('a stop while listening drops the question with its socket', async () => {
    const { voice, socket, mic } = make();
    voice.start();
    await settle();
    voice.stop();
    expect(socket().closed).toBe(true);
    expect(mic.stops).toBe(1);
    expect(voice.state().phase).toBe('off');
  });

  it('a stop once the question is asked keeps the socket, so the answer still lands', async () => {
    const { voice, socket } = make();
    voice.start();
    await settle();
    const ws = socket();
    ws.open();
    ws.serve({ type: 'turn-end', text: 'what is next' });
    voice.stop();
    expect(ws.closed).toBe(false);
    expect(ws.messages().at(-1)).toEqual({ type: 'stop' });
    // The answer's voice is not played into a stopped chat.
    ws.serve({ type: 'audio-start', sampleRate: 24_000 });
    expect(voice.state().phase).toBe('off');
  });

  it('says so, opens no socket and lets the mic go, when the server has no listener for the lead', async () => {
    const { voice, sockets, mic } = make([3, 4]);
    voice.start();
    await settle();
    expect(voice.state()).toMatchObject({ phase: 'off', notice: NO_VOICE });
    expect(sockets).toHaveLength(0);
    // The mic is asked for inside the tap, before the setups are known
    // (lead-chat-voice-gesture.test.ts), so it is released rather than unopened.
    expect(mic.stops).toBe(mic.starts);
  });

  it('stops on the server’s error and shows its line', async () => {
    const { voice, socket } = make();
    voice.start();
    await settle();
    socket().open();
    socket().serve({ type: 'error', message: 'Sign in to use the mic.' });
    expect(voice.state()).toMatchObject({ phase: 'off', notice: 'Sign in to use the mic.' });
  });
});

describe('the lead chat voice, as its page unloads', () => {
  const live = async () => {
    const fake = fakeVoice();
    const reports: Error[] = [];
    voice = createLeadVoice({
      ...fake.seams,
      report: (e) => reports.push(e),
      workspaceId: 'w-harbor',
      author: ME,
      getContext: () => ({ surface: 'board' }),
      agent: () => 'harborlight-lead',
      onChange: () => {},
    });
    voice.start();
    await settle();
    const ws = fake.socket();
    ws.open();
    return { voice, ws, reports };
  };

  it('a socket closed by a move to another page is not a stop, and nothing is reported', async () => {
    const { voice, ws, reports } = await live();
    window.dispatchEvent(new Event('pagehide'));
    ws.onclose?.();
    expect(voice.state()).toMatchObject({ phase: 'listening', notice: '' });
    expect(reports).toHaveLength(0);
    window.dispatchEvent(new Event('pageshow'));
  });

  it('a socket that closes while the page stays is a stop, said and reported', async () => {
    const { voice, ws, reports } = await live();
    ws.onclose?.();
    expect(voice.state()).toMatchObject({
      phase: 'off',
      notice: 'The connection closed. Tap the mic to try again.',
    });
    expect(reports.map((e) => e.message)).toEqual([expect.stringContaining('connection closed')]);
  });

  it('back from the back-forward cache with the socket gone, voice is off, quietly', async () => {
    const { voice, ws, reports } = await live();
    window.dispatchEvent(new Event('pagehide'));
    ws.onclose?.();
    window.dispatchEvent(new Event('pageshow'));
    expect(voice.state().phase).toBe('off');
    expect(reports).toHaveLength(0);
  });
});
