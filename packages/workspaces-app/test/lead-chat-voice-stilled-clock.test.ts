import type { AudioPump } from '@claude-workspaces/core';
/**
 * The lead chat's microphone on a context that says `running` and does not
 * render: Bryan's iPhone after a refresh reported "context running at
 * 48000 Hz … processor made … clock 0 s". WebKit bugs 263627 and 276687
 * describe the same state (a running context whose clock stands still once
 * another page's audio lets go) and report suspend-then-resume as what
 * brings the clock back.
 *
 * Driven through the real capture path — `createLeadVoice`, its default
 * `startSpokenCapture`, core's `createAudioPump` — over a fake audio stack
 * whose clock moves only when it renders. Also here: the capture's own
 * release and retake of the track, which the lead chat uses while it speaks.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startSpokenCapture } from '../src/board/spoken-reply-audio.ts';
import {
  type LeadVoice,
  NO_SOUND,
  TAP_TO_LISTEN,
  createLeadVoice,
} from '../src/lead-chat/lead-chat-voice.ts';
import { fakeVoice } from './lead-chat-voice-fakes.ts';

let inTap = false;
/** Whether a suspend and resume brings a stilled clock back. */
let kickHeals = true;
/** Whether a context made from now on starts with its clock stilled. */
let madeStill = true;

class FakeWorkletNode {
  port: { onmessage: ((ev: { data: unknown }) => void) | null } = { onmessage: null };
  disconnect(): void {}
}

class FakeSource {
  target: FakeWorkletNode | null = null;
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
  still = madeStill;
  kicks = 0;
  sources: FakeSource[] = [];
  audioWorklet = { addModule: async () => {} };
  private rendered = 0;
  constructor() {
    FakeContext.made.push(this);
  }
  get currentTime(): number {
    return this.rendered / this.sampleRate;
  }
  /** The state the phone reported: running at once, whatever renders. */
  resume(): Promise<void> {
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
  createMediaStreamSource(): FakeSource {
    const s = new FakeSource();
    this.sources.push(s);
    return s;
  }
  render(): void {
    if (this.state !== 'running' || this.still) return;
    for (const s of this.sources) s.target?.port.onmessage?.({ data: new Float32Array(128) });
    this.rendered += 128;
  }
}

const renderAll = (quanta: number): void => {
  for (let i = 0; i < quanta; i++) for (const c of FakeContext.made) c.render();
};

function micStream(): MediaStream {
  const track = {
    kind: 'audio',
    label: 'Harborlight iPhone Microphone',
    readyState: 'live',
    getSettings: () => ({ sampleRate: 48_000, channelCount: 1, deviceId: 'abc' }),
    stop: () => {},
  };
  return { getAudioTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream;
}

const saved: Record<string, unknown> = {};
let voice: LeadVoice | null = null;
beforeEach(() => {
  FakeContext.made = [];
  kickHeals = true;
  madeStill = true;
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
  vi.useRealTimers();
});

function tapped(reports: Error[]) {
  const fake = fakeVoice();
  const seams = { ...fake.seams };
  seams.startCapture = undefined;
  voice = createLeadVoice({
    ...seams,
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
  return { fake, voice, tap };
}

const sentFrames = (fake: ReturnType<typeof fakeVoice>): number =>
  fake.socket().sent.filter((d) => d instanceof Int16Array).length;

describe('the lead chat mic on a running context whose clock stands still', () => {
  it('suspends and resumes that context, and the mic is heard after', async () => {
    vi.useFakeTimers();
    const reports: Error[] = [];
    const { fake, voice } = tapped(reports);
    await vi.advanceTimersByTimeAsync(500);
    fake.socket().open();
    renderAll(100);
    expect(sentFrames(fake)).toBe(0);
    await vi.advanceTimersByTimeAsync(600);
    expect(FakeContext.made[0]?.kicks).toBe(1);
    renderAll(100);
    expect(sentFrames(fake)).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(voice.state()).toMatchObject({ phase: 'listening', notice: '' });
    expect(reports).toHaveLength(0);
  });

  it('asks for one tap instead of stopping when the clock stays still, and that tap rebuilds it', async () => {
    vi.useFakeTimers();
    kickHeals = false;
    const reports: Error[] = [];
    const { fake, voice, tap } = tapped(reports);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(voice.state()).toMatchObject({ phase: 'listening', notice: TAP_TO_LISTEN });
    expect(reports).toHaveLength(0);
    madeStill = false;
    tap(() => expect(voice.wake()).toBe(true));
    await vi.advanceTimersByTimeAsync(0);
    const fresh = FakeContext.made.at(-1);
    expect(FakeContext.made).toHaveLength(2);
    expect(fresh?.madeInTap).toBe(true);
    expect(FakeContext.made[0]?.state).toBe('closed');
    fake.socket().open();
    renderAll(100);
    expect(sentFrames(fake)).toBeGreaterThan(0);
    expect(voice.state()).toMatchObject({ phase: 'listening', notice: '' });
  });

  it('reports the stilled clock when the rebuilt capture stays silent too', async () => {
    vi.useFakeTimers();
    kickHeals = false;
    const reports: Error[] = [];
    const { voice, tap } = tapped(reports);
    await vi.advanceTimersByTimeAsync(6_000);
    tap(() => voice.wake());
    await vi.advanceTimersByTimeAsync(6_000);
    expect(voice.state()).toMatchObject({ phase: 'off', notice: NO_SOUND });
    expect(reports).toHaveLength(1);
    const msg = reports[0]?.message ?? '';
    expect(msg).toContain('clock 0 s');
    expect(msg).toContain('clock stood still, suspended and resumed');
    expect(msg).toContain('reopened in a tap');
    expect(msg).not.toContain('Harborlight');
  });

  it('leaves a context whose clock moves alone', async () => {
    vi.useFakeTimers();
    madeStill = false;
    const reports: Error[] = [];
    const { voice } = tapped(reports);
    await vi.advanceTimersByTimeAsync(500);
    renderAll(100);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(FakeContext.made[0]?.kicks).toBe(0);
    expect(FakeContext.made).toHaveLength(1);
    expect(voice.state()).toMatchObject({ phase: 'listening', notice: '' });
    expect(reports).toHaveLength(0);
  });
});

describe('a spoken capture letting go of its track', () => {
  /** A pump that records the streams fed to it. */
  function recordingPump() {
    const fed: MediaStream[] = [];
    const pump: AudioPump = {
      sampleRate: 48_000,
      onBlock: null,
      stop: () => {},
      replaceStream: (s) => void fed.push(s),
    };
    return { pump, fed };
  }
  function track() {
    const t = { stopped: false, stop: () => void (t.stopped = true) };
    return t;
  }
  function stream(t: ReturnType<typeof track>): MediaStream {
    return { getAudioTracks: () => [t], getTracks: () => [t] } as unknown as MediaStream;
  }

  it('stops the track on pause, and feeds a newly opened one into the same graph', async () => {
    const { pump, fed } = recordingPump();
    const tracks = [track(), track()];
    let opened = 0;
    const r = await startSpokenCapture({
      onFrame: () => {},
      getMedia: async () => stream(tracks[opened++] ?? track()),
      createPump: async () => pump,
    });
    if (!r.ok) throw new Error(r.message);
    r.capture.pause?.();
    expect(tracks[0]?.stopped).toBe(true);
    expect(await r.capture.unpause?.()).toBe(true);
    expect(opened).toBe(2);
    expect(fed).toHaveLength(1);
    expect(tracks[1]?.stopped).toBe(false);
  });

  it('drops the track an open returned after a later pause overtook it', async () => {
    const { pump, fed } = recordingPump();
    const tracks = [track(), track()];
    let opened = 0;
    let release: () => void = () => {};
    const r = await startSpokenCapture({
      onFrame: () => {},
      getMedia: (async () => {
        const t = tracks[opened++] ?? track();
        if (opened === 2) await new Promise<void>((done) => (release = done));
        return stream(t);
      }) as (c: MediaStreamConstraints) => Promise<MediaStream>,
      createPump: async () => pump,
    });
    if (!r.ok) throw new Error(r.message);
    r.capture.pause?.();
    const reopening = r.capture.unpause?.();
    r.capture.pause?.();
    release();
    expect(await reopening).toBe(false);
    expect(tracks[1]?.stopped).toBe(true);
    expect(fed).toHaveLength(0);
  });
});
