import {
  type AudioPumpFactory,
  MEETING_FRAME_SAMPLES,
  MEETING_SAMPLE_RATE,
  chunkPcm16,
  createAudioPump,
  createResampler,
  floatToPcm16,
} from '@claude-workspaces/core';

/**
 * The microphone, as frames of the meeting's wire format.
 *
 * The DSP and the audio graph are core's (`pcm-audio.ts`), the same ones the
 * meeting capture streams through; what is here is only the part that is
 * this surface's — asking for the microphone, and a loudness reading for the
 * bars on the live comment, so they move with the speaker's voice rather than
 * on a loop that moves whether anyone is talking or not.
 */

export interface PcmCapture {
  stop(): void;
}

export type PcmCaptureStart = { ok: true; capture: PcmCapture } | { ok: false; message: string };

export interface PcmCaptureOpts {
  onFrame: (pcm: Int16Array) => void;
  /** Loudness of each frame, 0..1. */
  onLevel?: (level: number) => void;
  /** Made inside the tap that asked for it — see `createAudioPump`. */
  context?: AudioContext;
  getMedia?: (c: MediaStreamConstraints) => Promise<MediaStream>;
  createPump?: AudioPumpFactory;
}

/** What the page says when the browser will not hand over a microphone. */
export function micRefusal(err: unknown): string {
  const name = (err as { name?: string } | null)?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'The microphone is blocked for this page. Allow it in the browser’s site settings.';
  }
  if (name === 'NotFoundError') return 'No microphone was found.';
  return 'The microphone could not be opened.';
}

/** RMS of a frame, scaled so ordinary speech reads near the top. */
export function frameLevel(pcm: Int16Array): number {
  let sum = 0;
  for (const s of pcm) sum += s * s;
  const rms = Math.sqrt(sum / Math.max(1, pcm.length)) / 32768;
  return Math.min(1, rms * 6);
}

export async function startPcmCapture(opts: PcmCaptureOpts): Promise<PcmCaptureStart> {
  if (!window.isSecureContext) {
    return { ok: false, message: 'Voice feedback needs https or localhost.' };
  }
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
    return { ok: false, message: micRefusal(err) };
  }
  let pump: Awaited<ReturnType<AudioPumpFactory>>;
  try {
    pump = await (opts.createPump ?? createAudioPump)(stream, opts.context);
  } catch (err) {
    for (const t of stream.getTracks()) t.stop();
    return { ok: false, message: micRefusal(err) };
  }
  const resample = createResampler(pump.sampleRate, MEETING_SAMPLE_RATE);
  let pending: Int16Array = new Int16Array(0);
  pump.onBlock = (block) => {
    const step = chunkPcm16(pending, floatToPcm16(resample(block)), MEETING_FRAME_SAMPLES);
    pending = step.rest;
    for (const frame of step.frames) {
      opts.onLevel?.(frameLevel(frame));
      opts.onFrame(frame);
    }
  };
  return {
    ok: true,
    capture: {
      stop() {
        pump.onBlock = null;
        pump.stop();
        // The track holds the device: without this the browser's recording
        // light stays on after Stop.
        for (const t of stream.getTracks()) t.stop();
      },
    },
  };
}
