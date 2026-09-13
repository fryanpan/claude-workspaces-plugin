/**
 * Microphone capture for a live meeting: raw browser audio in, the wire
 * contract's PCM out.
 *
 * The DSP and the audio graph are core's (`pcm-audio.ts`), shared with the
 * widget's voice feedback, and say there why the browser resamples. This
 * module owns what is the meeting's alone: the source, the track watch, and
 * reopening a capture whose device went away.
 *
 * The secure-context gate and the messages come from `voice-capture.ts`: this
 * is the same microphone, blocked by the same rule, and a second wording of
 * "the mic needs https or localhost" would be a second thing to keep true.
 */

import {
  type AudioPump,
  type AudioPumpFactory,
  type CaptureMode,
  DEFAULT_CAPTURE_MODE,
  MEETING_FRAME_SAMPLES,
  MEETING_SAMPLE_RATE,
  chunkPcm16,
  createAudioPump,
  createResampler,
  floatToPcm16,
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

// The DSP and the audio graph are core's (`pcm-audio.ts`), shared with the
// widget's voice feedback; re-exported so a meeting caller keeps one import.
export {
  type AudioPump,
  type AudioPumpFactory,
  MEETING_FRAME_SAMPLES,
  RESAMPLE_START,
  type ResampleState,
  chunkPcm16,
  createAudioPump,
  createResampler,
  floatToPcm16,
  resampleLinear,
} from '@claude-workspaces/core';

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
