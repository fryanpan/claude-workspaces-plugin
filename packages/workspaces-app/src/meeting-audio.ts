/**
 * Microphone capture for a live meeting: raw browser audio in, the wire
 * contract's PCM out.
 *
 * The DSP is pure and exported — `floatToPcm16`, `resampleLinear`,
 * `chunkPcm16` — and the AudioContext sits behind `AudioPumpFactory`, because
 * a test environment has no audio hardware and the parts that are easy to get
 * wrong (the clamp, the phase across a block boundary, a half-full frame) are
 * exactly the parts that need checking.
 *
 * WHY THE BROWSER RESAMPLES. An AudioContext runs at the device's rate — 44.1k
 * or 48k, and on some hardware neither — and the engine wants
 * `MEETING_SAMPLE_RATE`. Doing it here means the socket carries one format
 * whatever machine opened it, so the server never has to ask what it is
 * receiving, and the audio that crosses the network is a third of the size.
 *
 * The secure-context gate and the messages come from `voice-capture.ts`: this
 * is the same microphone, blocked by the same rule, and a second wording of
 * "the mic needs https or localhost" would be a second thing to keep true.
 */

import {
  type CaptureMode,
  DEFAULT_CAPTURE_MODE,
  MEETING_SAMPLE_RATE,
} from '@claude-workspaces/core';
import { type RoomAudioProcessing, captureConstraints } from './meeting-room-audio.ts';
import {
  type MediaDeviceSeam,
  type MeetingAudioSource,
  isSourceRefusal,
  mediaErrorCode,
  openMeetingSource,
} from './meeting-source.ts';
import {
  type TrackLossReason,
  type TrackWatch,
  type WatchableTrack,
  watchTracks,
} from './meeting-track-watch.ts';
import {
  type OriginFacts,
  defaultOriginFacts,
  insecureOriginMessage,
  recognitionErrorMessage,
} from './voice-capture.ts';

/**
 * Samples per outgoing frame — 50 ms at `MEETING_SAMPLE_RATE`, the engine's
 * own floor (chunks may be 50–1000ms) and its recommendation for
 * latency-sensitive callers. A word cannot leave the device until its frame
 * closes, so the frame size is a direct, deterministic term in word-to-paint
 * latency: half a frame on average, a whole frame at the tail. Halving the
 * frame from 100ms buys that wait down by ~25ms at the median and ~45ms at
 * the tail — arithmetic; a `?timing=1` session is what confirms it on the
 * live pipeline — for the price of 20 socket writes a second instead of 10.
 */
export const MEETING_FRAME_SAMPLES = MEETING_SAMPLE_RATE / 20;

// What the browser is ASKED for now lives beside the measurement that chose
// it (`meeting-room-audio.ts`); re-exported here because every caller reaches
// for the constraints in the same breath as the capture that sends them.
export {
  MEETING_CONSTRAINTS,
  ROOM_AUDIO_DEFAULT,
  type RoomAudioProcessing,
  captureConstraints,
  formatRoomAudio,
  parseRoomAudio,
} from './meeting-room-audio.ts';

/**
 * Float samples to signed 16-bit, clamped.
 *
 * The clamp is the point. A sample outside [-1, 1] is legal in the Web Audio
 * graph and arrives whenever gain control overshoots; a bare multiply-and-cast
 * WRAPS it, which turns a loud syllable into a burst of noise the engine hears
 * as a different word. The negative side scales by 32768 and the positive by
 * 32767 because the range is asymmetric.
 */
export function floatToPcm16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = input[i] ?? 0;
    const clamped = s < -1 ? -1 : s > 1 ? 1 : s;
    out[i] = Math.round(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff);
  }
  return out;
}

/** Where the resampler's read head is between two blocks. */
export interface ResampleState {
  /** The last sample of the previous block — the left-hand partner for an
   *  output sample that falls between the blocks. */
  prev: number;
  /** The next output position, relative to the START of the next block.
   *  Negative (down to -1) means it falls in the seam. */
  offset: number;
}

export const RESAMPLE_START: ResampleState = { prev: 0, offset: 0 };

/**
 * Linear resampling, one block at a time, CONTINUOUS across blocks.
 *
 * `ratio` is input samples per output sample (48000/16000 = 3). Each call
 * consumes as much of the block as it can and hands back where the read head
 * ended up, so the next block picks up mid-stride. Restarting the phase at
 * every block instead — the obvious per-block implementation — puts a
 * discontinuity every few milliseconds, which is a steady buzz under the
 * speech and measurably worse recognition.
 */
export function resampleLinear(
  input: Float32Array,
  ratio: number,
  state: ResampleState,
): { out: Float32Array; state: ResampleState } {
  const last = input.length - 1;
  if (last < 0) return { out: new Float32Array(0), state };
  const count = Math.max(0, Math.ceil((last - state.offset) / ratio) + 1);
  const out = new Float32Array(count);
  let n = 0;
  let p = state.offset;
  for (; p <= last; p += ratio) {
    const i = Math.floor(p);
    const f = p - i;
    const a = i < 0 ? state.prev : (input[i] ?? 0);
    const b = i + 1 <= last ? (input[i + 1] ?? 0) : a;
    out[n++] = a + (b - a) * f;
  }
  return {
    out: n === count ? out : out.subarray(0, n),
    state: { prev: input[last] ?? 0, offset: p - input.length },
  };
}

/** A resampler bound to a pair of rates, carrying its own phase. */
export function createResampler(from: number, to: number): (block: Float32Array) => Float32Array {
  const ratio = from / to;
  let state = RESAMPLE_START;
  return (block) => {
    const step = resampleLinear(block, ratio, state);
    state = step.state;
    return step.out;
  };
}

/**
 * Cut a stream of samples into fixed-size frames, holding the remainder back.
 *
 * The audio graph's block size has nothing to do with the frame size the
 * socket wants, and after resampling it is not even a whole number of them —
 * so every call leaves a few samples over. Dropping them (the shortcut) loses
 * a few milliseconds of speech per block, which across a meeting is a word
 * here and there going missing for no visible reason.
 */
export function chunkPcm16(
  pending: Int16Array,
  incoming: Int16Array,
  frame: number,
): { frames: Int16Array[]; rest: Int16Array } {
  const total = pending.length + incoming.length;
  if (total < frame) {
    const rest = new Int16Array(total);
    rest.set(pending, 0);
    rest.set(incoming, pending.length);
    return { frames: [], rest };
  }
  const all = new Int16Array(total);
  all.set(pending, 0);
  all.set(incoming, pending.length);
  const frames: Int16Array[] = [];
  let at = 0;
  for (; at + frame <= total; at += frame) frames.push(all.slice(at, at + frame));
  return { frames, rest: all.slice(at) };
}

/**
 * The audio graph, reduced to what the capture needs of it. `onBlock` is
 * assigned AFTER the pump exists, because the rate it reports is what the
 * resampler has to be built from.
 */
export interface AudioPump {
  readonly sampleRate: number;
  onBlock: ((samples: Float32Array) => void) | null;
  stop(): void;
}

export type AudioPumpFactory = (stream: MediaStream) => Promise<AudioPump>;

/**
 * The worklet, as source rather than a build asset. A separate .js file would
 * be one more thing the server has to serve at a path this module has to
 * guess; a blob URL keeps the processor next to the code that loads it.
 */
const WORKLET_SOURCE = `
class MeetingPcmProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    // A copy, not the view: the render quantum's buffer is reused, so a
    // reference posted across the port would be rewritten before it is read.
    if (channel && channel.length) this.port.postMessage(new Float32Array(channel));
    return true;
  }
}
registerProcessor('meeting-pcm', MeetingPcmProcessor);
`;

/** How many samples the ScriptProcessor fallback batches. ~85ms at 48kHz. */
const SCRIPT_PROCESSOR_BUFFER = 4096;

/**
 * The real audio graph: an AudioWorklet where there is one, and a
 * ScriptProcessor where there is not.
 *
 * The worklet runs on the audio thread, so a busy main thread (a big document
 * re-rendering, say) drops no audio. The fallback exists because
 * `audioWorklet` is unavailable on any page that is not a secure context and
 * on older Safari — and the fallback's node must be CONNECTED to the
 * destination or it is never pulled, so it goes through a muted gain node
 * rather than to the speakers, which would be a feedback loop.
 */
export async function createAudioPump(stream: MediaStream): Promise<AudioPump> {
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) throw Object.assign(new Error('no AudioContext'), { name: 'NotSupportedError' });
  const ctx = new Ctor();
  const source = ctx.createMediaStreamSource(stream);
  const pump: AudioPump = {
    sampleRate: ctx.sampleRate,
    onBlock: null,
    stop: () => {},
  };
  let url: string | null = null;
  try {
    url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'text/javascript' }));
    await ctx.audioWorklet.addModule(url);
    const node = new AudioWorkletNode(ctx, 'meeting-pcm');
    node.port.onmessage = (ev: MessageEvent) => pump.onBlock?.(ev.data as Float32Array);
    source.connect(node);
    pump.stop = () => {
      node.port.onmessage = null;
      node.disconnect();
      source.disconnect();
      void ctx.close();
    };
    return pump;
  } catch {
    const node = ctx.createScriptProcessor(SCRIPT_PROCESSOR_BUFFER, 1, 1);
    const mute = ctx.createGain();
    mute.gain.value = 0;
    node.onaudioprocess = (ev) =>
      pump.onBlock?.(new Float32Array(ev.inputBuffer.getChannelData(0)));
    source.connect(node);
    node.connect(mute);
    mute.connect(ctx.destination);
    pump.stop = () => {
      node.onaudioprocess = null;
      node.disconnect();
      mute.disconnect();
      source.disconnect();
      void ctx.close();
    };
    return pump;
  } finally {
    if (url) URL.revokeObjectURL(url);
  }
}

export { mediaErrorCode } from './meeting-source.ts';

export interface MeetingCaptureDeps {
  readOrigin?: () => OriginFacts;
  getMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  /** The browser's devices, for the source-aware path (`meeting-source.ts`). */
  devices?: MediaDeviceSeam;
  createPump?: AudioPumpFactory;
}

export interface MeetingCapture {
  stop(): void;
  /**
   * Turn echo cancellation off for a moment, and back on.
   *
   * WHY THIS EXISTS. `SOLO_AUDIO_PROCESSING` and `ROOM_AUDIO_DEFAULT` both ask for echo cancellation because
   * a meeting on a laptop speaker otherwise transcribes its own output. But
   * echo cancellation exists precisely to remove what the DEVICE is playing
   * from what the microphone hears — and the recording announcement is the
   * device playing something it needs the microphone to hear. Whether a given
   * browser's canceller actually reaches speech synthesis depends on whether
   * synthesis shares the render path it uses as its reference, which differs
   * by platform and is not something the page can ask.
   *
   * So this is a hedge, not a guarantee: best-effort, and every failure is
   * swallowed. `applyConstraints` can reject outright (Safari has refused
   * `echoCancellation` on a live track), and where it does the capture is
   * exactly where it was before. It never rejects, so no caller has to guard
   * an announcement behind it.
   */
  setEchoCancellation(on: boolean): Promise<void>;
  /**
   * Open the same source again, in place, after its track died.
   *
   * The capture keeps its identity across this: the same `onFrame`, the same
   * stream id on the wire, the same meeting. What is rebuilt is everything
   * below the track — a fresh graph, and a fresh resampler, because the
   * replacement device is free to run at a different rate and a resampler
   * carrying the old ratio would quietly transpose the speech.
   *
   * WHETHER IT NEEDS A GESTURE IS THE CALLER'S PROBLEM, NOT THIS ONE'S.
   * `getUserMedia` on a permission the page already holds opens no prompt, so
   * a microphone can come back on its own; the share picker is a modal and
   * cannot be opened except from a click. Both arrive here as the same call —
   * `meeting-stream-health.ts` holds the rule about which may be called
   * without a person, so this module is not the second place it is written.
   */
  reopen(): Promise<MeetingReopen>;
}

/**
 * What the strip says when a device opened and stopped in the same breath —
 * its own sentence rather than a refusal's, because nothing was refused.
 */
export const CAPTURE_DIED_AT_OPEN = 'That capture stopped again as soon as it opened.';

/** Whether a capture came back, with the strip's words when it did not. */
export type MeetingReopen = { ok: true } | { ok: false; message: string };

/** Why a capture did not start, in words the strip can show as they are. */
export type MeetingCaptureStart =
  | { ok: true; capture: MeetingCapture }
  | { ok: false; kind: 'insecure' | 'denied'; message: string };

export interface MeetingCaptureOpts {
  /** One frame of `MEETING_FRAME_SAMPLES` at `MEETING_SAMPLE_RATE`. */
  onFrame: (pcm: Int16Array) => void;
  /** What the microphone is about to hear. Defaults to `solo`. */
  mode?: CaptureMode;
  /** Room processing for a `conversation`; ignored by a solo capture. */
  room?: RoomAudioProcessing;
  /** The microphone unless said otherwise — see `meeting-source.ts`. */
  source?: MeetingAudioSource;
  /**
   * The capture stopped delivering audio and the meeting is still running —
   * see `meeting-track-watch.ts` for what counts. Reported ONCE per leg, and
   * again only after a `reopen` that landed.
   */
  onLost?: (reason: TrackLossReason) => void;
  /** The clock the mute window is measured on. Injected by tests. */
  now?: () => number;
  deps?: MeetingCaptureDeps;
}

/**
 * Open the microphone and stream frames until `stop()`.
 *
 * The origin gate runs BEFORE the permission prompt, for the reason
 * `voice-capture` documents: on plain http the browser offers no microphone
 * permission at all, so reacting to the refusal afterwards would send someone
 * into site settings looking for a control that is not there.
 */
export async function startMeetingCapture(opts: MeetingCaptureOpts): Promise<MeetingCaptureStart> {
  const deps = opts.deps ?? {};
  const blocked = insecureOriginMessage((deps.readOrigin ?? defaultOriginFacts)());
  if (blocked) return { ok: false, kind: 'insecure', message: blocked };
  const constraints = captureConstraints(opts.mode ?? DEFAULT_CAPTURE_MODE, opts.room);
  const source = opts.source ?? 'mic';

  /** The device, the graph and the watch over them — replaced whole by a reopen. */
  interface Leg {
    stream: MediaStream;
    pump: AudioPump;
    watch: TrackWatch;
  }

  async function openLeg(): Promise<{ ok: true; leg: Leg } | { ok: false; message: string }> {
    let stream: MediaStream;
    try {
      stream =
        source === 'mic' && deps.getMedia
          ? await deps.getMedia(constraints)
          : await openMeetingSource(source, constraints, deps.devices);
    } catch (err) {
      // A source refusal already says, in the strip's words, what to do next.
      const message = isSourceRefusal(err)
        ? err.message
        : recognitionErrorMessage(mediaErrorCode(err));
      return { ok: false, message };
    }
    let pump: AudioPump;
    try {
      pump = await (deps.createPump ?? createAudioPump)(stream);
    } catch (err) {
      for (const track of stream.getTracks()) track.stop();
      return { ok: false, message: recognitionErrorMessage(mediaErrorCode(err)) };
    }
    // A resampler PER LEG, never one shared across a reopen: it is built from
    // the rate the graph reported, and the device that comes back may not be
    // the one that went away.
    const resample = createResampler(pump.sampleRate, MEETING_SAMPLE_RATE);
    let pending: Int16Array = new Int16Array(0);
    /**
     * A LEG IS NOT OPEN UNTIL IT HAS SURVIVED BEING WATCHED. `watchTracks`
     * checks the state a track was already in, so a device handed back dead
     * reports its loss from inside this constructor — while the caller still
     * believes it is opening something. Forwarding that would spend the leg's
     * one report on a leg nobody has been given, and `reopen` would answer
     * `ok` for a capture delivering silence: the original bug, plus a record
     * claiming the audio came back. So the report is held until the leg is
     * handed over, and anything earlier makes the open a refusal instead.
     */
    let bornDead: TrackLossReason | null = null;
    let handedOver = false;
    const watch = watchTracks({
      tracks: stream.getAudioTracks() as unknown as WatchableTrack[],
      onLost: (reason) => {
        if (handedOver) opts.onLost?.(reason);
        else bornDead = reason;
      },
      ...(opts.now ? { now: opts.now } : {}),
    });
    if (bornDead !== null) {
      watch.stop();
      pump.stop();
      for (const track of stream.getTracks()) track.stop();
      return { ok: false, message: CAPTURE_DIED_AT_OPEN };
    }
    handedOver = true;
    pump.onBlock = (block) => {
      // Before the samples, not after: this block may BE the silence a dead
      // track is producing, and forwarding it first would put another frame of
      // nothing on the wire ahead of the report.
      watch.tick();
      const step = chunkPcm16(pending, floatToPcm16(resample(block)), MEETING_FRAME_SAMPLES);
      pending = step.rest;
      for (const frame of step.frames) opts.onFrame(frame);
    };
    return { ok: true, leg: { stream, pump, watch } };
  }

  const first = await openLeg();
  if (!first.ok) return { ok: false, kind: 'denied', message: first.message };
  let leg = first.leg;
  let closed = false;

  /** Everything below the track, released. The track itself goes with it. */
  function tearDown(current: Leg): void {
    current.watch.stop();
    current.pump.onBlock = null;
    current.pump.stop();
    // The graph closing is not enough: the TRACK is what holds the device,
    // and leaving it open keeps the browser's recording indicator lit long
    // after the meeting ended.
    for (const track of current.stream.getTracks()) track.stop();
  }

  return {
    ok: true,
    capture: {
      setEchoCancellation: async (on: boolean) => {
        await Promise.all(
          leg.stream.getAudioTracks().map(async (track) => {
            try {
              await track.applyConstraints({ echoCancellation: on });
            } catch {
              // A track that will not take the constraint keeps the one it
              // has. Reporting this would be reporting a hedge that did not
              // apply, which is not a state anybody can act on.
            }
          }),
        );
      },
      async reopen(): Promise<MeetingReopen> {
        if (closed) return { ok: false, message: 'The recording has already stopped.' };
        const next = await openLeg();
        if (!next.ok) return { ok: false, message: next.message };
        // The OLD leg comes down only once the new one is up. Reversing this
        // would put a hole in the audio for the length of a permission round
        // trip, on a path whose whole job is to lose less of the meeting — and
        // would release a working capture to find out the replacement was
        // refused.
        if (closed) {
          tearDown(next.leg);
          return { ok: false, message: 'The recording has already stopped.' };
        }
        const previous = leg;
        leg = next.leg;
        tearDown(previous);
        return { ok: true };
      },
      stop: () => {
        closed = true;
        tearDown(leg);
      },
    },
  };
}
