/**
 * The lead chat's voice: the converse socket, aimed at the lead. A question
 * names the lead in `start` and streams the mic behind it; while the lead
 * works and speaks no frame goes up; once the answer has been said the next
 * question listens by itself on the same open mic.
 * The socket and the microphone are fakes.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  type LeadVoice,
  type LeadVoiceState,
  NO_VOICE,
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

  it('says so, and opens nothing, when the server has no listener for the lead', async () => {
    const { voice, sockets, mic } = make([3, 4]);
    voice.start();
    await settle();
    expect(voice.state()).toMatchObject({ phase: 'off', notice: NO_VOICE });
    expect(sockets).toHaveLength(0);
    expect(mic.starts).toBe(0);
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
