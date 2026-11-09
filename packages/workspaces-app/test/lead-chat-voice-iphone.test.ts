/**
 * The lead chat's voice on an iPhone: what Bryan heard after the 24 kHz join
 * fix ("Was still crackling last night") and what a refresh did to the mic.
 *
 * - While an echo-cancelled microphone track is live, iOS 26.2 and later
 *   crackle every sound the page plays (WebKit bug 326286), so the track is
 *   let go while an answer is said and taken back for the next question.
 * - Each spoken answer sends one playback line on the path a stop is
 *   reported on, so the next try on the phone names what playback met.
 * - A page that goes for good lets go of its audio at `pagehide`.
 *
 * The socket, the microphone and the speakers are fakes.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlaybackContext } from '../src/board/spoken-reply-audio.ts';
import { PLAYBACK_REPORTS } from '../src/lead-chat/lead-chat-voice-io.ts';
import { type LeadVoice, createLeadVoice } from '../src/lead-chat/lead-chat-voice.ts';
import { type FakeSocket, fakeVoice } from './lead-chat-voice-fakes.ts';

/** Speakers at the phone's 48 kHz, with the latencies Safari reports. */
function speakers() {
  const ctx = {
    sampleRate: 48_000,
    currentTime: 2,
    state: 'running',
    baseLatency: 0.005,
    outputLatency: 0.04,
    closed: false,
    resume: async () => {},
    close: async () => {
      ctx.closed = true;
    },
    destination: {},
    createBuffer: () => ({ copyToChannel: () => {} }),
    createBufferSource: () => ({ connect: () => {}, start: () => {}, stop: () => {} }),
  };
  return ctx;
}

/** 100 ms of the voice at 24 kHz. */
const sound = (): ArrayBuffer => new Int16Array(2_400).fill(1200).buffer;

let voice: LeadVoice | null = null;
afterEach(() => {
  voice?.destroy();
  voice = null;
  vi.useRealTimers();
});

async function asking() {
  vi.useFakeTimers();
  const fake = fakeVoice();
  const ctx = speakers();
  const reports: Error[] = [];
  voice = createLeadVoice({
    ...fake.seams,
    playbackContext: () => ctx as unknown as PlaybackContext,
    report: (e) => reports.push(e),
    workspaceId: 'w-harbor',
    author: { id: 'known-alice', name: 'Alice', kind: 'known' },
    getContext: () => ({ surface: 'board' }),
    agent: () => 'harborlight-lead',
    onChange: () => {},
  });
  voice.start();
  await vi.advanceTimersByTimeAsync(0);
  const ws = fake.socket();
  ws.open();
  return { fake, ws, ctx, reports, voice };
}

/** The server answering the question just asked, aloud. */
async function answer(ws: FakeSocket, chunks = 3): Promise<void> {
  ws.serve({ type: 'turn-end', text: 'is the ferry running' });
  ws.serve({ type: 'reply', spoken: 'It is.', detail: [], asking: false, route: 'agent' });
  ws.serve({ type: 'audio-start', sampleRate: 24_000 });
  for (let i = 0; i < chunks; i++) ws.onmessage?.({ data: sound() });
  ws.serve({ type: 'audio-end' });
  await vi.advanceTimersByTimeAsync(2_000);
}

describe('the lead chat voice, while an answer is said on an iPhone', () => {
  it('lets go of the mic’s track while it speaks, and takes it back for the next question', async () => {
    const { fake, ws, voice } = await asking();
    ws.serve({ type: 'turn-end', text: 'is the ferry running' });
    ws.serve({ type: 'reply', spoken: 'It is.', detail: [], asking: false, route: 'agent' });
    ws.serve({ type: 'audio-start', sampleRate: 24_000 });
    expect(voice.state().phase).toBe('speaking');
    expect([fake.mic.pauses, fake.mic.unpauses]).toEqual([1, 0]);
    ws.serve({ type: 'audio-end' });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(voice.state().phase).toBe('listening');
    expect([fake.mic.pauses, fake.mic.unpauses]).toEqual([1, 1]);
    // The graph stayed: no second capture, nothing stopped.
    expect([fake.mic.starts, fake.mic.stops]).toEqual([1, 0]);
    fake.speak();
    expect(ws.frames()).toBe(1);
  });

  it('stops and says so when the mic will not open again after the answer', async () => {
    const { fake, ws, voice, reports } = await asking();
    fake.mic.reopens = false;
    await answer(ws);
    expect(voice.state()).toMatchObject({
      phase: 'off',
      notice: 'The microphone could not be opened again.',
    });
    expect(reports.map((e) => e.name)).toContain('LeadVoiceStopped');
  });
});

describe('the playback report', () => {
  it('sends one line per spoken answer: rate, latencies, underruns, least margin and the mic', async () => {
    const { ws, reports } = await asking();
    await answer(ws);
    const lines = reports.filter((e) => e.name === 'LeadVoicePlayback');
    expect(lines).toHaveLength(1);
    const line = lines[0]?.message ?? '';
    expect(line).toContain('context running at 48000 Hz');
    expect(line).toContain('base latency 5 ms, output latency 40 ms');
    expect(line).toContain('3 chunks, 0 underruns');
    // The clock held still, so two chunks of 100 ms were queued ahead of the
    // third: the least margin is the first chunk's, plus its headroom.
    expect(line).toContain('least ahead 130 ms');
    expect(line).toContain('mic released while it played');
  });

  it('counts the chunks that arrived after the queue ran dry', async () => {
    const { ws, ctx, reports } = await asking();
    ws.serve({ type: 'turn-end', text: 'is the ferry running' });
    ws.serve({ type: 'reply', spoken: 'It is.', detail: [], asking: false, route: 'agent' });
    ws.serve({ type: 'audio-start', sampleRate: 24_000 });
    ws.onmessage?.({ data: sound() });
    ctx.currentTime += 1;
    ws.onmessage?.({ data: sound() });
    ws.serve({ type: 'audio-end' });
    await vi.advanceTimersByTimeAsync(2_000);
    const line = reports.find((e) => e.name === 'LeadVoicePlayback')?.message ?? '';
    expect(line).toContain('2 chunks, 1 underruns');
    expect(line).toContain('lead 60 ms');
  });

  it(`sends at most ${PLAYBACK_REPORTS} from one page`, async () => {
    const { ws, reports } = await asking();
    for (let i = 0; i < PLAYBACK_REPORTS + 2; i++) await answer(ws);
    expect(reports.filter((e) => e.name === 'LeadVoicePlayback')).toHaveLength(PLAYBACK_REPORTS);
  });
});

describe('the lead chat voice, as the page goes', () => {
  const hide = (persisted: boolean): void => {
    const ev = new Event('pagehide');
    Object.defineProperty(ev, 'persisted', { value: persisted });
    window.dispatchEvent(ev);
  };

  it('lets go of the mic and closes the speakers’ context when the page goes for good', async () => {
    const { fake, ctx } = await asking();
    hide(false);
    expect(fake.mic.stops).toBe(1);
    expect(ctx.closed).toBe(true);
  });

  it('keeps both when the page is only put in the back-forward cache', async () => {
    const { fake, ctx } = await asking();
    hide(true);
    expect(fake.mic.stops).toBe(0);
    expect(ctx.closed).toBe(false);
  });
});
