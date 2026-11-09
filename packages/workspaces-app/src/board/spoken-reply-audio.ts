/**
 * The spoken reply's two ends of audio: the microphone as the meeting
 * capture's wire format going up, and the reply's PCM coming back.
 *
 * Both ends also stamp the moments the delay is measured between, because
 * only the page hears both: the last capture frame loud enough to be speech,
 * and the moment the first audible sample of the reply actually plays — not
 * when it arrived, since a buffer scheduled behind another plays later.
 */
import {
  type AudioPumpFactory,
  MEETING_FRAME_SAMPLES,
  MEETING_SAMPLE_RATE,
  chunkPcm16,
  createAudioPump,
  createResampler,
  floatToPcm16,
  trackFacts,
} from '@claude-workspaces/core';

/** A frame at or above this RMS (of full scale) counts as speech. With the
 *  browser's gain control on, a quiet room sits well under it. */
export const SPEECH_RMS = 0.015;

/** A reply sample at or above this magnitude counts as the first word. */
const AUDIBLE_SAMPLE = 0.01;

export function frameRms(pcm: Int16Array): number {
  if (pcm.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) {
    const s = (pcm[i] ?? 0) / 0x8000;
    sum += s * s;
  }
  return Math.sqrt(sum / pcm.length);
}

/** Index of the first audible sample, or -1. */
export function firstAudible(samples: Float32Array): number {
  for (let i = 0; i < samples.length; i++) {
    if (Math.abs(samples[i] ?? 0) >= AUDIBLE_SAMPLE) return i;
  }
  return -1;
}

/** Little-endian PCM16 bytes to floats; an odd trailing byte is dropped. */
export function pcm16ToFloat(bytes: Uint8Array): Float32Array<ArrayBuffer> {
  const n = bytes.length >> 1;
  const view = new DataView(bytes.buffer, bytes.byteOffset, n * 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = view.getInt16(i * 2, true) / 0x8000;
  return out;
}

export interface SpokenCapture {
  stop(): void;
  /** One line for an error report (`AudioPump.diag`). */
  diag?(): string;
  /** The mic's rate when the graph runs at another, which on iOS delivers
   *  no audio (`graphContext`); otherwise null. */
  offRate?(): number | null;
  /** The graph's clock in seconds (`AudioPump.clock`). */
  clock?(): number;
  /** Suspend and resume the graph's context (`AudioPump.kick`). */
  kick?(): Promise<void>;
  /** Release the microphone's track and keep the graph. While an echo-
   *  cancelled track is live, iOS 26.2+ crackles every sound the page plays
   *  (WebKit bug 326286), so the lead chat lets go of it while it speaks. */
  pause?(): void;
  /** Open the microphone again into the same graph. False if it would not
   *  open, or this capture cannot reopen in place. */
  unpause?(): Promise<boolean>;
}

export interface SpokenCaptureOpts {
  /** One 50 ms frame, and whether it was loud enough to be speech. */
  onFrame(pcm: Int16Array, speech: boolean): void;
  /** Made inside the press that asked for it — see `createAudioPump`. */
  context?: AudioContext;
  getMedia?: (c: MediaStreamConstraints) => Promise<MediaStream>;
  createPump?: AudioPumpFactory;
}

export type SpokenCaptureStart =
  | { ok: true; capture: SpokenCapture }
  | { ok: false; message: string };

function refusal(err: unknown): string {
  const name = (err as { name?: string } | null)?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'The microphone is blocked for this page. Allow it in the browser’s site settings.';
  }
  if (name === 'NotFoundError') return 'No microphone was found.';
  return 'The microphone could not be opened.';
}

const MIC_CONSTRAINTS: MediaStreamConstraints = {
  audio: {
    channelCount: 1,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  },
};

export async function startSpokenCapture(opts: SpokenCaptureOpts): Promise<SpokenCaptureStart> {
  const release = (): void => void opts.context?.close().catch(() => {});
  const getMedia =
    opts.getMedia ?? ((c: MediaStreamConstraints) => navigator.mediaDevices.getUserMedia(c));
  let stream: MediaStream;
  try {
    stream = await getMedia(MIC_CONSTRAINTS);
  } catch (err) {
    release();
    return { ok: false, message: refusal(err) };
  }
  let pump: Awaited<ReturnType<AudioPumpFactory>>;
  try {
    pump = await (opts.createPump ?? createAudioPump)(stream, opts.context);
  } catch (err) {
    for (const t of stream.getTracks()) t.stop();
    release();
    return { ok: false, message: refusal(err) };
  }
  const resample = createResampler(pump.sampleRate, MEETING_SAMPLE_RATE);
  let paused = false;
  /** Counts pauses, so an open that a later pause overtook is dropped. */
  let pauses = 0;
  let stopped = false;
  let pending: Int16Array = new Int16Array(0);
  pump.onBlock = (block) => {
    const step = chunkPcm16(pending, floatToPcm16(resample(block)), MEETING_FRAME_SAMPLES);
    pending = step.rest;
    for (const frame of step.frames) opts.onFrame(frame, frameRms(frame) >= SPEECH_RMS);
  };
  return {
    ok: true,
    capture: {
      diag: () => pump.diag?.() ?? '',
      offRate: () => {
        const mic = trackFacts(stream).sampleRate;
        return mic && mic !== pump.sampleRate ? mic : null;
      },
      ...(pump.clock ? { clock: () => pump.clock?.() ?? 0 } : {}),
      ...(pump.kick ? { kick: () => pump.kick?.() ?? Promise.resolve() } : {}),
      pause() {
        paused = true;
        pauses++;
        for (const t of stream.getTracks()) t.stop();
      },
      async unpause() {
        if (!paused) return true;
        if (stopped || !pump.replaceStream) return false;
        const mine = pauses;
        let next: MediaStream;
        try {
          next = await getMedia(MIC_CONSTRAINTS);
        } catch {
          return false;
        }
        // Stopped, or paused again, while the device was opening.
        if (stopped || mine !== pauses) {
          for (const t of next.getTracks()) t.stop();
          return false;
        }
        paused = false;
        stream = next;
        pump.replaceStream(next);
        return true;
      },
      stop() {
        stopped = true;
        pump.onBlock = null;
        pump.stop();
        // The track holds the device: without this the recording light stays on.
        for (const t of stream.getTracks()) t.stop();
      },
    },
  };
}

/** The slice of an AudioContext the player uses — a fake in tests. */
export interface PlaybackContext {
  readonly sampleRate: number;
  readonly currentTime: number;
  readonly state: string;
  resume(): Promise<void>;
  createBuffer(channels: number, length: number, sampleRate: number): AudioBuffer;
  createBufferSource(): AudioBufferSourceNode;
  readonly destination: AudioNode;
  /** Read for the playback report; absent in older Safari. */
  readonly baseLatency?: number;
  readonly outputLatency?: number;
  close?(): Promise<void>;
}

/** What one spoken answer's playback met, for the report a voice sends. */
export interface PlaybackFacts {
  sampleRate: number;
  state: string;
  baseLatency: number | null;
  outputLatency: number | null;
  /** Buffers since `begin`. */
  chunks: number;
  /** Chunks that arrived after the queue had run dry. */
  underruns: number;
  /** The least time left queued when a chunk arrived, in ms; null before
   *  the second chunk. */
  leastAheadMs: number | null;
  /** The headroom the player now schedules a fresh start with, in ms. */
  leadMs: number;
}

export interface SpokenPlayer {
  /** Resume inside a press: Safari plays only from a context a gesture woke. */
  wake(): void;
  begin(sampleRate: number): void;
  push(bytes: Uint8Array): void;
  /** No more audio is coming; `onDone` fires once what was queued has played. */
  finish(onDone: () => void): void;
  /** Silence now, and drop everything queued (and every unmet `mark`). */
  stop(): void;
  /**
   * Call `onStart` with the play time of the first audible sample pushed
   * after this call, on the `performance.now()` clock — a time that may
   * still be ahead, since audio is queued behind what is playing. How a
   * point's note is timed to the point's first word.
   */
  mark(onStart: (audibleAt: number) => void): void;
  playing(): boolean;
  /** What this answer's playback met so far (`PlaybackFacts`). */
  facts(): PlaybackFacts | null;
  /** Stop, and close the context, so the page holds no audio session. */
  release(): void;
}

export interface SpokenPlayerOpts {
  context: () => PlaybackContext | null;
  /** The first audible sample's play time, on the `performance.now()` clock. */
  onFirstWord(at: number): void;
  now?: () => number;
}

/** A little headroom so the first buffer is not scheduled in the past. */
const LEAD_S = 0.03;
/** The most the headroom grows to after the queue runs dry. */
const MAX_LEAD_S = 0.24;
/** Less than this left queued counts as dry: a buffer started that close to
 *  the clock may begin late and lose its first samples. */
const DRY_S = 0.01;

/** How long a chunk that follows a gap takes to rise from silence. */
const RAMP_S = 0.004;

/**
 * The player resamples to the context's rate itself, and schedules every
 * buffer on a whole frame. A browser given a buffer at the voice's 24 kHz
 * resamples each buffer alone and holds its last sample, which clicks at
 * every join: 0.16 of full scale on a voice with a 5 kHz partial, measured in
 * Chromium (`spoken-player-joins-browser.test.ts`). `createResampler` carries
 * its phase across chunks, so the chunks' sizes leave no mark.
 */
function rampUp(samples: Float32Array, frames: number): void {
  const n = Math.min(frames, samples.length);
  for (let i = 0; i < n; i++) samples[i] = (samples[i] ?? 0) * (i / n);
}

export function createSpokenPlayer(opts: SpokenPlayerOpts): SpokenPlayer {
  const now = opts.now ?? (() => performance.now());
  let rate = 24_000;
  let ctx: PlaybackContext | null = null;
  /** The next free frame on the context's clock. */
  let playFrame = 0;
  /** This reply's resampler, built once the context's rate is known. */
  let resample: ((block: Float32Array) => Float32Array) | null = null;
  /** A byte left over when a chunk ended halfway through a sample. */
  let oddByte: Uint8Array | null = null;
  let sources: AudioBufferSourceNode[] = [];
  let heardFirst = false;
  let doneTimer: ReturnType<typeof setTimeout> | null = null;
  let active = false;
  let marks: Array<(audibleAt: number) => void> = [];
  /** Headroom for a fresh start: doubles each time the queue runs dry, so a
   *  network that delivers late stops leaving a gap at every chunk. */
  let lead = LEAD_S;
  let chunks = 0;
  let underruns = 0;
  let leastAhead = Number.POSITIVE_INFINITY;

  const clearDone = (): void => {
    if (doneTimer) clearTimeout(doneTimer);
    doneTimer = null;
  };

  /** Whole samples only: a voice's chunk may end halfway through one. */
  const withoutOddByte = (bytes: Uint8Array): Uint8Array => {
    let all = bytes;
    if (oddByte) {
      all = new Uint8Array(oddByte.length + bytes.length);
      all.set(oddByte);
      all.set(bytes, oddByte.length);
      oddByte = null;
    }
    if (all.length % 2 === 0) return all;
    oddByte = all.slice(-1);
    return all.subarray(0, -1);
  };

  const player: SpokenPlayer = {
    wake() {
      ctx = ctx ?? opts.context();
      if (ctx && ctx.state !== 'running') void ctx.resume().catch(() => {});
    },
    begin(sampleRate) {
      clearDone();
      rate = sampleRate;
      ctx = ctx ?? opts.context();
      // iOS marks a context woken by the tap `interrupted` once the mic takes
      // the audio session; while the page captures it may run again.
      if (ctx && ctx.state !== 'running') void ctx.resume().catch(() => {});
      // `playFrame` stays: a reply that follows one still playing starts after it.
      resample = null;
      oddByte = null;
      heardFirst = false;
      active = true;
      chunks = 0;
      underruns = 0;
      leastAhead = Number.POSITIVE_INFINITY;
    },
    push(bytes) {
      if (!active || !ctx) return;
      const whole = withoutOddByte(bytes);
      if (whole.length === 0) return;
      const sampleRate = ctx.sampleRate;
      const continuing = resample !== null;
      resample ??= createResampler(rate, sampleRate);
      const samples = new Float32Array(resample(pcm16ToFloat(whole)));
      if (samples.length === 0) return;
      chunks++;
      let startFrame = playFrame;
      if (continuing) {
        const ahead = playFrame / sampleRate - ctx.currentTime;
        leastAhead = Math.min(leastAhead, ahead);
        if (ahead < DRY_S) {
          underruns++;
          lead = Math.min(MAX_LEAD_S, lead * 2);
          startFrame = Math.round((ctx.currentTime + lead) * sampleRate);
          rampUp(samples, RAMP_S * sampleRate);
        }
      } else {
        startFrame = Math.max(playFrame, Math.round((ctx.currentTime + lead) * sampleRate));
      }
      const t = startFrame / sampleRate;
      const buf = ctx.createBuffer(1, samples.length, sampleRate);
      buf.copyToChannel(samples, 0);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      src.start(t);
      sources.push(src);
      src.onended = () => {
        sources = sources.filter((s) => s !== src);
      };
      if (!heardFirst || marks.length > 0) {
        const i = firstAudible(samples);
        if (i >= 0) {
          const audibleAt = now() + (t + i / sampleRate - ctx.currentTime) * 1000;
          if (!heardFirst) {
            heardFirst = true;
            opts.onFirstWord(audibleAt);
          }
          const met = marks;
          marks = [];
          for (const m of met) m(audibleAt);
        }
      }
      playFrame = startFrame + samples.length;
    },
    finish(onDone) {
      clearDone();
      const left = ctx ? Math.max(0, playFrame / ctx.sampleRate - ctx.currentTime) : 0;
      doneTimer = setTimeout(() => {
        doneTimer = null;
        active = false;
        onDone();
      }, left * 1000);
    },
    stop() {
      clearDone();
      active = false;
      for (const s of sources) {
        try {
          s.stop();
        } catch {}
      }
      sources = [];
      playFrame = 0;
      resample = null;
      oddByte = null;
      marks = [];
    },
    mark(onStart) {
      marks.push(onStart);
    },
    playing: () => active,
    facts() {
      if (!ctx) return null;
      const latency = (v: number | undefined): number | null =>
        typeof v === 'number' && Number.isFinite(v) ? v : null;
      return {
        sampleRate: ctx.sampleRate,
        state: ctx.state,
        baseLatency: latency(ctx.baseLatency),
        outputLatency: latency(ctx.outputLatency),
        chunks,
        underruns,
        leastAheadMs: Number.isFinite(leastAhead) ? Math.round(leastAhead * 1000) : null,
        leadMs: Math.round(lead * 1000),
      };
    },
    release() {
      player.stop();
      void ctx?.close?.().catch(() => {});
      ctx = null;
    },
  };
  return player;
}
