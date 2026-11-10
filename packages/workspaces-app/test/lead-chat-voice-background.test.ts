/**
 * The lead chat's voice when iOS puts the page in the background and the
 * reader comes back. Bryan, 9 Nov: "Mic is not sending sound … when I
 * background the web page and come back, something gets messed up."
 *
 * In the background iOS can end or mute the microphone's track, leave an
 * audio context `interrupted`, or leave one `running` with its clock
 * stopped. On return the mic resumes what it can, reopens a track that
 * ended, and asks for one tap when nothing else brings it back
 * (`LeadMic.recheck`). The speakers' context is woken too.
 *
 * Driven through the real capture path — `createLeadVoice`, its default
 * `startSpokenCapture`, core's `createAudioPump` — over a fake audio stack
 * whose sources deliver only from a live, unmuted track.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlaybackContext } from '../src/board/spoken-reply-audio.ts';
import {
  type LeadVoice,
  TAP_TO_LISTEN,
  createLeadVoice,
} from '../src/lead-chat/lead-chat-voice.ts';
import { fakeVoice } from './lead-chat-voice-fakes.ts';

let inTap = false;
/** Whether a suspend and resume brings a stopped clock back. */
let kickHeals = true;

interface FakeTrack {
  readyState: 'live' | 'ended';
  muted: boolean;
  stop(): void;
  getSettings(): MediaTrackSettings;
}
const tracks: FakeTrack[] = [];

class FakeWorkletNode {
  port: { onmessage: ((ev: { data: unknown }) => void) | null } = { onmessage: null };
  disconnect(): void {}
}

class FakeSource {
  target: FakeWorkletNode | null = null;
  constructor(readonly track: FakeTrack | undefined) {}
  connect(n: FakeWorkletNode): void {
    this.target = n;
  }
  disconnect(): void {}
}

class FakeContext {
  static made: FakeContext[] = [];
  state = 'suspended';
  readonly sampleRate = 48_000;
  readonly madeInTap = inTap;
  still = false;
  kicks = 0;
  resumes = 0;
  sources: FakeSource[] = [];
  audioWorklet = { addModule: async () => {} };
  private rendered = 0;
  constructor() {
    FakeContext.made.push(this);
  }
  get currentTime(): number {
    return this.rendered / this.sampleRate;
  }
  resume(): Promise<void> {
    this.resumes++;
    if (this.state === 'closed') return Promise.resolve();
    if (this.state === 'suspended' && this.kicks > 0 && kickHeals) this.still = false;
    this.state = 'running';
    return Promise.resolve();
  }
  suspend(): Promise<void> {
    this.kicks++;
    this.state = 'suspended';
    return Promise.resolve();
  }
  close(): Promise<void> {
    this.state = 'closed';
    return Promise.resolve();
  }
  createMediaStreamSource(stream: MediaStream): FakeSource {
    const s = new FakeSource(stream.getAudioTracks()[0] as unknown as FakeTrack | undefined);
    this.sources.push(s);
    return s;
  }
  render(): void {
    if (this.state !== 'running' || this.still) return;
    for (const s of this.sources) {
      const delivers = s.track?.readyState === 'live' && !s.track.muted;
      if (delivers) s.target?.port.onmessage?.({ data: new Float32Array(128) });
    }
    this.rendered += 128;
  }
}

const renderAll = (quanta: number): void => {
  for (let i = 0; i < quanta; i++) for (const c of FakeContext.made) c.render();
};

function micStream(): MediaStream {
  const track: FakeTrack = {
    readyState: 'live',
    muted: false,
    stop: () => {
      track.readyState = 'ended';
    },
    getSettings: () => ({ sampleRate: 48_000, channelCount: 1, deviceId: 'abc' }),
  };
  tracks.push(track);
  return { getAudioTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream;
}

let visibility: DocumentVisibilityState = 'visible';
const setVisible = (v: DocumentVisibilityState): void => {
  visibility = v;
  document.dispatchEvent(new Event('visibilitychange'));
};

const saved: Record<string, unknown> = {};
let voice: LeadVoice | null = null;
beforeEach(() => {
  FakeContext.made = [];
  tracks.length = 0;
  kickHeals = true;
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibility,
  });
  const w = window as unknown as Record<string, unknown>;
  for (const k of ['AudioContext', 'AudioWorkletNode']) saved[k] = w[k];
  w.AudioContext = FakeContext;
  w.AudioWorkletNode = FakeWorkletNode;
  (globalThis as Record<string, unknown>).AudioWorkletNode = FakeWorkletNode;
  saved.createObjectURL = URL.createObjectURL;
  saved.revokeObjectURL = URL.revokeObjectURL;
  URL.createObjectURL = () => 'blob:meeting-pcm';
  URL.revokeObjectURL = () => {};
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: async () => micStream() },
  });
});
afterEach(() => {
  voice?.destroy();
  voice = null;
  const w = window as unknown as Record<string, unknown>;
  w.AudioContext = saved.AudioContext;
  w.AudioWorkletNode = saved.AudioWorkletNode;
  (globalThis as Record<string, unknown>).AudioWorkletNode = saved.AudioWorkletNode;
  URL.createObjectURL = saved.createObjectURL as typeof URL.createObjectURL;
  URL.revokeObjectURL = saved.revokeObjectURL as typeof URL.revokeObjectURL;
  Reflect.deleteProperty(document, 'visibilityState');
  vi.useRealTimers();
});

/** The speakers' context, as the player sees it. */
function speakers() {
  const ctx = {
    sampleRate: 48_000,
    currentTime: 1,
    state: 'running',
    resumes: 0,
    resume: async () => {
      ctx.resumes++;
      ctx.state = 'running';
    },
    destination: {},
    createBuffer: () => ({ copyToChannel: () => {} }),
    createBufferSource: () => ({ connect: () => {}, start: () => {}, stop: () => {} }),
  };
  return ctx;
}

/** Voice turned on in a tap, the mic sending, and the page then hidden. */
async function listeningThenHidden(reports: Error[]) {
  vi.useFakeTimers();
  const fake = fakeVoice();
  const seams = { ...fake.seams };
  seams.startCapture = undefined;
  const speaker = speakers();
  voice = createLeadVoice({
    ...seams,
    playbackContext: () => speaker as unknown as PlaybackContext,
    report: (e) => reports.push(e),
    workspaceId: 'w-harbor',
    author: { id: 'known-bryan', name: 'Bryan', kind: 'known' },
    getContext: () => ({ surface: 'board' }),
    agent: () => 'harborlight-lead',
    onChange: () => {},
  });
  const tap = (f: () => unknown): void => {
    inTap = true;
    try {
      f();
    } finally {
      inTap = false;
    }
  };
  tap(() => voice?.start());
  await vi.advanceTimersByTimeAsync(0);
  fake.socket().open();
  renderAll(100);
  await vi.advanceTimersByTimeAsync(1_500);
  setVisible('hidden');
  const frames = (): number => fake.socket().sent.filter((d) => d instanceof Int16Array).length;
  return { fake, voice, tap, speaker, frames, mic: FakeContext.made[0] as FakeContext };
}

describe('the lead chat mic, back from the background', () => {
  it('reopens the mic when iOS ended its track while the page was hidden', async () => {
    const reports: Error[] = [];
    const { voice, frames } = await listeningThenHidden(reports);
    (tracks[0] as FakeTrack).readyState = 'ended';
    setVisible('visible');
    await vi.advanceTimersByTimeAsync(1_500);
    expect(tracks).toHaveLength(2);
    expect(tracks[1]?.readyState).toBe('live');
    const before = frames();
    renderAll(100);
    expect(frames()).toBeGreaterThan(before);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(voice.state()).toMatchObject({ phase: 'listening', notice: '' });
    expect(reports).toHaveLength(0);
  });

  it('reopens a track that came back muted', async () => {
    const reports: Error[] = [];
    const { frames } = await listeningThenHidden(reports);
    (tracks[0] as FakeTrack).muted = true;
    setVisible('visible');
    await vi.advanceTimersByTimeAsync(1_500);
    expect(tracks).toHaveLength(2);
    const before = frames();
    renderAll(100);
    expect(frames()).toBeGreaterThan(before);
  });

  it('resumes a context iOS left interrupted, without reopening the mic', async () => {
    const reports: Error[] = [];
    const { voice, mic, frames } = await listeningThenHidden(reports);
    mic.state = 'interrupted';
    setVisible('visible');
    await vi.advanceTimersByTimeAsync(0);
    expect(mic.state).toBe('running');
    const before = frames();
    renderAll(100);
    expect(frames()).toBeGreaterThan(before);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(tracks).toHaveLength(1);
    expect(voice.state()).toMatchObject({ phase: 'listening', notice: '' });
    expect(reports).toHaveLength(0);
  });

  it('asks for one tap when nothing brings the mic back, and that tap rebuilds it', async () => {
    const reports: Error[] = [];
    kickHeals = false;
    const { voice, mic, tap, frames } = await listeningThenHidden(reports);
    mic.still = true;
    setVisible('visible');
    await vi.advanceTimersByTimeAsync(1_500);
    // A suspend and resume first; the clock still does not move.
    expect(mic.kicks).toBe(1);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(voice.state()).toMatchObject({ phase: 'listening', notice: TAP_TO_LISTEN });
    expect(reports).toHaveLength(0);
    tap(() => expect(voice.wake()).toBe(true));
    await vi.advanceTimersByTimeAsync(0);
    const fresh = FakeContext.made.at(-1);
    expect(fresh).not.toBe(mic);
    expect(fresh?.madeInTap).toBe(true);
    const before = frames();
    renderAll(100);
    expect(frames()).toBeGreaterThan(before);
    expect(voice.state()).toMatchObject({ phase: 'listening', notice: '' });
  });

  it('does nothing while the page is hidden again, and checks afresh when it returns', async () => {
    const reports: Error[] = [];
    const { voice, frames } = await listeningThenHidden(reports);
    (tracks[0] as FakeTrack).readyState = 'ended';
    setVisible('visible');
    // Swiped away again before the check ran.
    setVisible('hidden');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(tracks).toHaveLength(1);
    setVisible('visible');
    await vi.advanceTimersByTimeAsync(1_500);
    expect(tracks).toHaveLength(2);
    const before = frames();
    renderAll(100);
    expect(frames()).toBeGreaterThan(before);
    expect(voice.state()).toMatchObject({ phase: 'listening', notice: '' });
    expect(reports).toHaveLength(0);
  });

  it('wakes the speakers’ context iOS left interrupted', async () => {
    const reports: Error[] = [];
    const { speaker } = await listeningThenHidden(reports);
    speaker.state = 'interrupted';
    const resumes = speaker.resumes;
    setVisible('visible');
    expect(speaker.resumes).toBe(resumes + 1);
    expect(speaker.state).toBe('running');
  });

  it('changes nothing when the mic still sends after the page comes back', async () => {
    const reports: Error[] = [];
    const { mic } = await listeningThenHidden(reports);
    setVisible('visible');
    renderAll(100);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mic.kicks).toBe(0);
    expect(tracks).toHaveLength(1);
    expect(FakeContext.made).toHaveLength(1);
    expect(reports).toHaveLength(0);
  });
});
