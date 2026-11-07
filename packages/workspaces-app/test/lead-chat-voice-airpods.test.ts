/**
 * The lead chat's voice with a Bluetooth headset's microphone: AirPods on an
 * iPhone run the mic at 16 or 24 kHz while the context the tap made runs at
 * the output's 48 kHz.
 *
 * Driven through the real capture path — `createLeadVoice`, its default
 * `startSpokenCapture`, core's `createAudioPump` — over a fake browser audio
 * stack that models what the phone reported: a context that says `running`
 * at 48000 Hz and a microphone that delivers nothing to it. Here that is
 * modelled as WebKit's stream source on a context at another rate rendering
 * with no input. Also modelled, as an assumption: a context made after the
 * tap starts once the page is capturing the microphone, as WebKit lets a
 * capturing page play. The case where it does not is the third one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SPEECH_RMS, frameRms } from '../src/board/spoken-reply-audio.ts';
import {
  type LeadVoice,
  NO_SOUND,
  TAP_TO_LISTEN,
  createLeadVoice,
} from '../src/lead-chat/lead-chat-voice.ts';
import { fakeVoice } from './lead-chat-voice-fakes.ts';

const ME = { id: 'known-bryan', name: 'Bryan', kind: 'known' };

let inTap = false;
let micLive = false;
/** Whether a context made after the tap may start while the mic is open. */
let capturingMayPlay = true;

/** A 440 Hz tone at a level well above speech. */
function tone(n: number, rate: number, from: number): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = 0.3 * Math.sin((2 * Math.PI * 440 * (from + i)) / rate);
  return out;
}

class FakeWorkletNode {
  port: { onmessage: ((ev: { data: unknown }) => void) | null } = { onmessage: null };
  disconnect(): void {}
}

class FakeSource {
  target: FakeWorkletNode | null = null;
  constructor(readonly rate: number | undefined) {}
  connect(n: FakeWorkletNode): void {
    this.target = n;
  }
  disconnect(): void {}
}

class FakeContext {
  static made: FakeContext[] = [];
  state = 'suspended';
  readonly sampleRate: number;
  readonly madeInTap = inTap;
  sources: FakeSource[] = [];
  audioWorklet = { addModule: async () => {} };
  private rendered = 0;
  private empty = 0;
  constructor(o?: { sampleRate?: number }) {
    this.sampleRate = o?.sampleRate ?? 48_000;
    FakeContext.made.push(this);
  }
  resume(): Promise<void> {
    if (this.state !== 'closed' && (inTap || (micLive && capturingMayPlay))) this.state = 'running';
    return Promise.resolve();
  }
  close(): Promise<void> {
    this.state = 'closed';
    return Promise.resolve();
  }
  createMediaStreamSource(stream: MediaStream): FakeSource {
    const s = new FakeSource(stream.getAudioTracks()[0]?.getSettings().sampleRate);
    this.sources.push(s);
    return s;
  }
  /** One render quantum. A source at another rate gives the worklet no
   *  input, which it counts (`WORKLET_SOURCE`). */
  render(): void {
    if (this.state !== 'running') return;
    for (const s of this.sources) {
      const data =
        s.rate === this.sampleRate ? tone(128, this.sampleRate, this.rendered) : ++this.empty;
      s.target?.port.onmessage?.({ data });
    }
    this.rendered += 128;
  }
}

const renderAll = (quanta: number): void => {
  for (let i = 0; i < quanta; i++) for (const c of FakeContext.made) c.render();
};

/** The AirPods microphone, as getUserMedia hands it over. */
function headsetStream(rate: number): MediaStream {
  const track = {
    kind: 'audio',
    label: 'Riverbend’s AirPods',
    getSettings: () => ({ sampleRate: rate, channelCount: 1, deviceId: 'default' }),
    stop: () => {
      micLive = false;
    },
  };
  return { getAudioTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream;
}

const saved: Record<string, unknown> = {};
let micRate = 24_000;
let voice: LeadVoice | null = null;
beforeEach(() => {
  FakeContext.made = [];
  micLive = false;
  capturingMayPlay = true;
  micRate = 24_000;
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
    value: {
      getUserMedia: async () => {
        micLive = true;
        return headsetStream(micRate);
      },
    },
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

function tapVoice(reports: Error[]) {
  const fake = fakeVoice();
  // The real capture path, not the fake microphone.
  const seams = { ...fake.seams };
  seams.startCapture = undefined;
  voice = createLeadVoice({
    ...seams,
    report: (e) => reports.push(e),
    workspaceId: 'w-harbor',
    author: ME,
    getContext: () => ({ surface: 'board' }),
    agent: () => 'harborlight-lead',
    onChange: () => {},
  });
  inTap = true;
  try {
    voice.start();
  } finally {
    inTap = false;
  }
  return { fake, voice };
}

const sentFrames = (fake: ReturnType<typeof fakeVoice>): Int16Array[] =>
  fake.socket().sent.filter((d): d is Int16Array => d instanceof Int16Array);

describe('the lead chat voice with a headset mic at another rate', () => {
  /** A refresh with voice on: the page starts the mic with no tap, then the
   *  reader taps once, as the chat asks. */
  function carriedVoice(reports: Error[]) {
    const fake = fakeVoice();
    const seams = { ...fake.seams };
    seams.startCapture = undefined;
    voice = createLeadVoice({
      ...seams,
      report: (e) => reports.push(e),
      workspaceId: 'w-harbor',
      author: ME,
      getContext: () => ({ surface: 'board' }),
      agent: () => 'harborlight-lead',
      onChange: () => {},
    });
    voice.start({ gesture: false });
    return { fake, voice };
  }
  const tapPage = (v: LeadVoice): void => {
    inTap = true;
    try {
      v.wake();
    } finally {
      inTap = false;
    }
  };

  it('after a refresh, the tap starts a context at the mic’s rate and the sound reaches the listener', async () => {
    vi.useFakeTimers();
    capturingMayPlay = false;
    const reports: Error[] = [];
    const { fake, voice } = carriedVoice(reports);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(voice.state().notice).toBe(TAP_TO_LISTEN);
    tapPage(voice);
    await vi.advanceTimersByTimeAsync(0);
    fake.socket().open();
    renderAll(60);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(reports).toEqual([]);
    expect(voice.state().phase).toBe('listening');
    expect(sentFrames(fake).length).toBeGreaterThan(0);
    expect(FakeContext.made.some((c) => c.sampleRate === 24_000 && c.state === 'running')).toBe(
      true,
    );
  });

  it('after a refresh on a context that runs at the wrong rate, asks for the tap instead of stopping', async () => {
    vi.useFakeTimers();
    capturingMayPlay = false;
    const reports: Error[] = [];
    const { fake, voice } = carriedVoice(reports);
    await vi.advanceTimersByTimeAsync(0);
    // The context made on load runs once the page captures, but later than
    // the try at a context at the mic's rate, which was let go.
    await vi.advanceTimersByTimeAsync(550);
    capturingMayPlay = true;
    for (const c of FakeContext.made) void c.resume();
    await vi.advanceTimersByTimeAsync(5_500);
    expect(voice.state()).toMatchObject({ phase: 'listening', notice: TAP_TO_LISTEN });
    expect(reports).toEqual([]);
    tapPage(voice);
    await vi.advanceTimersByTimeAsync(0);
    fake.socket().open();
    renderAll(60);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(voice.state()).toMatchObject({ phase: 'listening', notice: '' });
    expect(sentFrames(fake).length).toBeGreaterThan(0);
  });

  it('sends the headset’s sound to the listener when the mic runs at 24 kHz and the tap’s context at 48 kHz', async () => {
    vi.useFakeTimers();
    const reports: Error[] = [];
    const { fake, voice } = tapVoice(reports);
    await vi.advanceTimersByTimeAsync(0);
    fake.socket().open();
    renderAll(60);
    await vi.advanceTimersByTimeAsync(6_000);
    const frames = sentFrames(fake);
    expect(frames.length).toBeGreaterThan(0);
    expect(Math.max(...frames.map(frameRms))).toBeGreaterThan(SPEECH_RMS);
    expect(voice.state().phase).toBe('listening');
    expect(reports).toEqual([]);
    // The graph ran on a context at the mic's rate; the tap's was let go.
    const tapCtx = FakeContext.made.find((c) => c.madeInTap);
    expect(tapCtx?.state).toBe('closed');
    expect(FakeContext.made.some((c) => c.sampleRate === 24_000 && c.state === 'running')).toBe(
      true,
    );
  });

  it('keeps the tap’s context when the mic already runs at its rate', async () => {
    vi.useFakeTimers();
    micRate = 48_000;
    const reports: Error[] = [];
    const { fake } = tapVoice(reports);
    await vi.advanceTimersByTimeAsync(0);
    fake.socket().open();
    renderAll(60);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(sentFrames(fake).length).toBeGreaterThan(0);
    expect(FakeContext.made).toHaveLength(1);
    expect(FakeContext.made[0]?.madeInTap).toBe(true);
    expect(FakeContext.made[0]?.state).toBe('running');
  });

  it('says what the track and the context were when the mic still sends nothing, and never the device’s name', async () => {
    vi.useFakeTimers();
    // The worst case: a context made after the tap never starts, so the
    // tap's 48 kHz one is kept and the headset delivers it nothing.
    capturingMayPlay = false;
    const reports: Error[] = [];
    const { voice } = tapVoice(reports);
    await vi.advanceTimersByTimeAsync(600);
    renderAll(150);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(voice.state()).toMatchObject({ phase: 'off', notice: NO_SOUND });
    expect(reports).toHaveLength(1);
    const msg = reports[0]?.message ?? '';
    expect(msg).toContain('context running at 48000 Hz');
    expect(msg).toContain('track 24000 Hz, 1 ch, default device');
    expect(msg).toContain('0 blocks, 150 renders without input');
    expect(msg).toContain('worklet, processor not heard from');
    expect(msg).toContain('started in a tap');
    expect(msg).not.toContain('Riverbend');
  });
});
