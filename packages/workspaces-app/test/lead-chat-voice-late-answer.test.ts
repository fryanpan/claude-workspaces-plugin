/**
 * The lead's answer arrives minutes after the question, by which time voice
 * may have stopped by itself or its socket may have dropped. It is still said
 * on the page the speaker has open, unless they pressed stop themselves.
 * The socket, the microphone and the speakers are fakes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlaybackContext } from '../src/board/spoken-reply-audio.ts';
import {
  type LeadVoice,
  OWED_RETRIES,
  OWED_RETRY_MS,
  createLeadVoice,
} from '../src/lead-chat/lead-chat-voice.ts';
import { type FakeSocket, fakeVoice } from './lead-chat-voice-fakes.ts';

/** A context that counts what it was asked to play. */
function speakers() {
  const played = { sounds: 0 };
  const context = {
    sampleRate: 24_000,
    currentTime: 0,
    state: 'running',
    resume: async () => {},
    destination: {},
    createBuffer: () => ({ copyToChannel: () => {} }),
    createBufferSource: () => ({
      connect: () => {},
      start: () => void played.sounds++,
      stop: () => {},
    }),
  } as unknown as PlaybackContext;
  return { played, context };
}

const ANSWER = 'The Riverbend ferry runs at noon.';
const reply = { detail: [], asking: false };
const sound = new Int16Array(800).fill(1200).buffer;

/** The server saying the lead's answer on this socket. */
function say(ws: FakeSocket): void {
  ws.serve({ type: 'reply', spoken: ANSWER, ...reply, route: 'lead-answer' });
  ws.serve({ type: 'audio-start', sampleRate: 24_000 });
  ws.onmessage?.({ data: sound });
  ws.serve({ type: 'audio-end' });
}

describe('a late answer from the lead', () => {
  let voice: LeadVoice | null = null;
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    voice?.destroy();
    voice = null;
    vi.useRealTimers();
  });

  /** Voice on, one question asked, and the lead took it to work on. */
  async function asked() {
    const fake = fakeVoice();
    const { played, context } = speakers();
    voice = createLeadVoice({
      ...fake.seams,
      playbackContext: () => context,
      workspaceId: 'w-harbor',
      author: { id: 'known-first-person', name: 'Alice', kind: 'known' },
      getContext: () => ({ surface: 'board' }),
      agent: () => 'house-lead',
      onChange: () => {},
    });
    voice.start();
    await vi.advanceTimersByTimeAsync(0);
    const ws = fake.socket();
    ws.open();
    ws.serve({ type: 'turn-end', text: 'is the ferry running' });
    ws.serve({ type: 'reply', spoken: '', ...reply, route: 'agent' });
    await vi.advanceTimersByTimeAsync(0);
    return { fake, ws, played, voice };
  }

  it('is said on an open socket while voice is still on, five minutes later', async () => {
    const { ws, played } = await asked();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    say(ws);
    expect(played.sounds).toBe(1);
  });

  it('is said after voice stopped by itself, on the socket it kept', async () => {
    const { ws, played, voice } = await asked();
    ws.serve({ type: 'error', message: 'The listener went away.' });
    expect(voice.state().phase).toBe('off');
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    say(ws);
    expect(played.sounds).toBe(1);
  });

  it('reopens a dropped socket, with the mic off, and says it there', async () => {
    const { fake, ws, played, voice } = await asked();
    const micStarts = fake.mic.starts;
    ws.onclose?.();
    expect(voice.state().phase).toBe('off');
    await vi.advanceTimersByTimeAsync(OWED_RETRY_MS);
    const next = fake.socket();
    expect(next).not.toBe(ws);
    next.open();
    say(next);
    expect(played.sounds).toBe(1);
    expect(fake.mic.starts).toBe(micStarts);
    expect(next.messages().filter((m) => m.type === 'start')).toHaveLength(0);
  });

  it('gives up on reopening after a bounded number of tries', async () => {
    const { fake, ws } = await asked();
    ws.onclose?.();
    for (let i = 0; i < OWED_RETRIES + 2; i++) {
      await vi.advanceTimersByTimeAsync(OWED_RETRY_MS);
      fake.socket().onclose?.();
    }
    expect(fake.sockets).toHaveLength(1 + OWED_RETRIES);
  });

  it('stays silent after the reader pressed stop, and reopens nothing', async () => {
    const { fake, ws, played, voice } = await asked();
    voice.stop();
    say(ws);
    expect(played.sounds).toBe(0);
    ws.onclose?.();
    await vi.advanceTimersByTimeAsync(OWED_RETRY_MS * 2);
    expect(fake.sockets).toHaveLength(1);
  });

  it('a page that is leaving reopens nothing: the next page collects it', async () => {
    const { fake, ws } = await asked();
    window.dispatchEvent(new Event('pagehide'));
    ws.onclose?.();
    await vi.advanceTimersByTimeAsync(OWED_RETRY_MS * 2);
    expect(fake.sockets).toHaveLength(1);
  });

  it('with nothing owed, a dropped socket stays closed', async () => {
    const { fake, ws } = await asked();
    say(ws);
    ws.onclose?.();
    await vi.advanceTimersByTimeAsync(OWED_RETRY_MS * 2);
    expect(fake.sockets).toHaveLength(1);
  });
});
