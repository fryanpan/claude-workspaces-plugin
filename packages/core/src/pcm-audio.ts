/**
 * Microphone audio to the wire format live transcription reads: PCM16LE mono
 * at `MEETING_SAMPLE_RATE`, in fixed frames.
 *
 * Two captures read this — the meeting's (`meeting-audio.ts` in the app) and
 * the widget's voice feedback — so it lives in core rather than being grown a
 * second time inside the widget. The DSP is pure and exported, and the
 * AudioContext sits behind `AudioPumpFactory`, because a test environment has
 * no audio hardware and the parts that are easy to get wrong (the clamp, the
 * phase across a block boundary, a half-full frame) are exactly the parts that
 * need checking.
 *
 * WHY THE BROWSER RESAMPLES. An AudioContext runs at the device's rate — 44.1k
 * or 48k, and on some hardware neither — and the engine wants
 * `MEETING_SAMPLE_RATE`. Doing it here means the socket carries one format
 * whatever machine opened it, so the server never has to ask what it is
 * receiving, and the audio that crosses the network is a third of the size.
 */
import { MEETING_SAMPLE_RATE } from './meeting.ts';

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

export type AudioPumpFactory = (stream: MediaStream, context?: AudioContext) => Promise<AudioPump>;

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
export async function createAudioPump(
  stream: MediaStream,
  context?: AudioContext,
): Promise<AudioPump> {
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!context && !Ctor) {
    throw Object.assign(new Error('no AudioContext'), { name: 'NotSupportedError' });
  }
  // A context made by the caller inside the tap that asked for it: Safari
  // starts one only from a gesture, and a context built after an await (a
  // lazily loaded chunk, a permission prompt) can stay suspended for good.
  const ctx = context ?? new (Ctor as typeof AudioContext)();
  if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
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
