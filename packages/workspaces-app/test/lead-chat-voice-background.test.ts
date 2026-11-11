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
 * that renders as Chrome does: a running graph keeps handing its processor a
 * block every render quantum, and a source whose track ended or is muted
 * hands it zeros (measured 10 Nov: 388 blocks in the second after
 * `track.stop()`, all but the 9 already buffered zero). So a block is not
 * sound; only a block with a sample in it is.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlaybackContext } from '../src/board/spoken-reply-audio.ts';
import {
  type LeadVoice,
  NO_SOUND,
  TAP_TO_LISTEN,
  createLeadVoice,
} from '../src/lead-chat/lead-chat-voice.ts';
import { fakeVoice } from './lead-chat-voice-fakes.ts';

let inTap = false;
/** Whether a suspend and resume brings a stopped clock back. */
let kickHeals = true;
/** Sources made from now on render zeros from a live track: the reopened
 *  iPhone mic that holds the device and delivers nothing. */
let deafSources = false;

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
  readonly deaf = deafSources;
  constructor(readonly track: FakeTrack | undefined) {}
  connect(n: FakeWorkletNode): void {
    this.target = n;
  }
  disconnect(): void {
    this.target = null;
  }
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
      const delivers = s.track?.readyState === 'live' && !s.track.muted && !s.deaf;
      // A room's noise floor from a live mic; zeros from anything else.
      s.target?.port.onmessage?.({ data: new Float32Array(128).fill(delivers ? 0.02 : 0) });
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
  deafSources = false;
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

/** Voice turned on in a tap, the mic sending. */
async function listening(reports: Error[]) {
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
  /** Frames sent up that carry sound; a dead source's zeros go up too. */
  const frames = (): number =>
    fake.socket().sent.filter((d) => d instanceof Int16Array && d.some((v) => v !== 0)).length;
  return { fake, voice, tap, speaker, frames, mic: FakeContext.made[0] as FakeContext };
}

/** ...and the page then hidden. */
async function listeningThenHidden(reports: Error[]) {
  const on = await listening(reports);
  setVisible('hidden');
  return on;
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

  // Bryan, 10 Nov, iPhone: back from the background, a question reached the
  // lead as "Uh, Dr." The graph came back late in the check's first second,
  // just as he started talking, and the check suspended and resumed it in
  // the middle of his sentence.
  it('leaves alone a mic that starts sending late in the first second back, as the reader talks', async () => {
    const reports: Error[] = [];
    const { voice, mic, fake, frames } = await listeningThenHidden(reports);
    // The graph's clock stands still for most of the first second back.
    mic.still = true;
    setVisible('visible');
    await vi.advanceTimersByTimeAsync(950);
    mic.still = false;
    const before = frames();
    await renderFor(3_000);
    expect(mic.kicks).toBe(0);
    expect(tracks).toHaveLength(1);
    expect(FakeContext.made).toHaveLength(1);
    // Every 50 ms of the sentence went up: 3s of rendering, no gap.
    expect(frames() - before).toBeGreaterThanOrEqual(58);
    expect(voice.state()).toMatchObject({ phase: 'listening', notice: '' });
    expect(fake.socket().closed).toBe(false);
    expect(reports).toHaveLength(0);
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

/** 100 ms of the lead's voice at 24 kHz. */
const said = (): ArrayBuffer => new Int16Array(2_400).fill(1200).buffer;

/** A graph that keeps rendering while `ms` pass, as a running one does. */
async function renderFor(ms: number): Promise<void> {
  for (let t = 0; t < ms; t += 100) {
    renderAll(38);
    await vi.advanceTimersByTimeAsync(100);
  }
}

describe('the lead chat mic, when its graph renders only silence', () => {
  // Bryan, 10 Nov, iPhone: "listening", the mic light on, no words ever shown.
  it('reopens a muted track whose graph still renders blocks, back from the background', async () => {
    const reports: Error[] = [];
    const { voice, frames } = await listeningThenHidden(reports);
    (tracks[0] as FakeTrack).muted = true;
    setVisible('visible');
    await renderFor(1_500);
    expect(tracks).toHaveLength(2);
    const before = frames();
    renderAll(100);
    expect(frames()).toBeGreaterThan(before);
    expect(voice.state()).toMatchObject({ phase: 'listening', notice: '' });
    expect(reports).toHaveLength(0);
  });

  it('asks for one tap when the mic taken back after an answer renders only zeros, and that tap rebuilds it', async () => {
    const reports: Error[] = [];
    const { voice, fake, tap, mic, frames } = await listening(reports);
    const ws = fake.socket();
    ws.serve({ type: 'turn-end', text: 'is the ferry running' });
    ws.serve({ type: 'reply', spoken: 'It is.', detail: [], asking: false, route: 'agent' });
    ws.serve({ type: 'audio-start', sampleRate: 24_000 });
    ws.onmessage?.({ data: said() });
    // The track the next question takes holds the device and delivers nothing.
    deafSources = true;
    ws.serve({ type: 'audio-end' });
    await vi.advanceTimersByTimeAsync(500);
    expect(voice.state().phase).toBe('listening');
    expect(tracks).toHaveLength(2);
    expect(tracks[1]?.readyState).toBe('live');
    // The buffered tail of the released track carries sound into the first
    // window, so the check looks once more before it acts.
    await renderFor(3_500);
    // A suspend and resume first, then the tap.
    expect(mic.kicks).toBe(1);
    expect(voice.state()).toMatchObject({ phase: 'listening', notice: TAP_TO_LISTEN });
    expect(reports.filter((e) => e.name === 'LeadVoiceStopped')).toHaveLength(0);
    deafSources = false;
    tap(() => expect(voice.wake()).toBe(true));
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeContext.made.at(-1)).not.toBe(mic);
    const before = frames();
    renderAll(100);
    expect(frames()).toBeGreaterThan(before);
    expect(voice.state()).toMatchObject({ phase: 'listening', notice: '' });
  });

  it('stops and says so when the mic it opened renders only zeros', async () => {
    const reports: Error[] = [];
    deafSources = true;
    const { voice } = await listening(reports);
    await renderFor(6_000);
    expect(voice.state()).toMatchObject({ phase: 'off', notice: NO_SOUND });
    expect(reports.map((e) => e.name)).toContain('LeadVoiceStopped');
  });
});
