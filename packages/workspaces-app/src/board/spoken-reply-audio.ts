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

export async function startSpokenCapture(opts: SpokenCaptureOpts): Promise<SpokenCaptureStart> {
  const release = (): void => void opts.context?.close().catch(() => {});
  let stream: MediaStream;
  try {
    const getMedia =
      opts.getMedia ?? ((c: MediaStreamConstraints) => navigator.mediaDevices.getUserMedia(c));
    stream = await getMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
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
      stop() {
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
  readonly currentTime: number;
  readonly state: string;
  resume(): Promise<void>;
  createBuffer(channels: number, length: number, sampleRate: number): AudioBuffer;
  createBufferSource(): AudioBufferSourceNode;
  readonly destination: AudioNode;
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
}

export interface SpokenPlayerOpts {
  context: () => PlaybackContext | null;
  /** The first audible sample's play time, on the `performance.now()` clock. */
  onFirstWord(at: number): void;
  now?: () => number;
}

/** A little headroom so the first buffer is not scheduled in the past. */
const LEAD_S = 0.03;

export function createSpokenPlayer(opts: SpokenPlayerOpts): SpokenPlayer {
  const now = opts.now ?? (() => performance.now());
  let rate = 24_000;
  let ctx: PlaybackContext | null = null;
  let playAt = 0;
  let sources: AudioBufferSourceNode[] = [];
  let heardFirst = false;
  let doneTimer: ReturnType<typeof setTimeout> | null = null;
  let active = false;
  let marks: Array<(audibleAt: number) => void> = [];

  const clearDone = (): void => {
    if (doneTimer) clearTimeout(doneTimer);
    doneTimer = null;
  };

  return {
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
      // `playAt` stays: a reply that follows one still playing starts after it.
      heardFirst = false;
      active = true;
    },
    push(bytes) {
      if (!active || !ctx) return;
      const samples = pcm16ToFloat(bytes);
      if (samples.length === 0) return;
      const buf = ctx.createBuffer(1, samples.length, rate);
      buf.copyToChannel(samples, 0);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      const t = Math.max(playAt, ctx.currentTime + LEAD_S);
      src.start(t);
      sources.push(src);
      src.onended = () => {
        sources = sources.filter((s) => s !== src);
      };
      if (!heardFirst || marks.length > 0) {
        const i = firstAudible(samples);
        if (i >= 0) {
          const audibleAt = now() + (t + i / rate - ctx.currentTime) * 1000;
          if (!heardFirst) {
            heardFirst = true;
            opts.onFirstWord(audibleAt);
          }
          const met = marks;
          marks = [];
          for (const m of met) m(audibleAt);
        }
      }
      playAt = t + samples.length / rate;
    },
    finish(onDone) {
      clearDone();
      const left = ctx ? Math.max(0, playAt - ctx.currentTime) : 0;
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
      playAt = 0;
      marks = [];
    },
    mark(onStart) {
      marks.push(onStart);
    },
    playing: () => active,
  };
}
