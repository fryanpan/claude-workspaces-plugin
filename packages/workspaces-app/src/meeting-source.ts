/**
 * Where a meeting's audio comes from, and how each source is opened.
 *
 * The microphone is `getUserMedia`. The Mac's own output — a call on any
 * platform, a video, anything through the speakers — is `getDisplayMedia`
 * with system audio asked for: Chrome 141+ on macOS 14.2+ shows a share
 * picker with an audio tick-box, and hands the page an audio track beside
 * the screen it insisted on. The screen is stopped at once; only the sound
 * is wanted. Everything after this point — the pump, the resampler, the
 * frames on the socket — is the microphone path unchanged, which is why the
 * choice lives here and not in `meeting-audio.ts`.
 *
 * Two refusals are this module's own, worded for the strip to show as they
 * are: a browser with no picker at all (Safari, an older Chrome), and a
 * picker closed with the audio box unticked, which Chrome reports as a
 * stream with a screen and no sound rather than as an error.
 */

import type { MeetingStreamId } from '@claude-workspaces/core';

/**
 * One capture this module can open. The SOURCE a meeting was started with
 * may name two of them — see `MeetingCaptureSource` in core, and
 * `meeting-capture-set.ts` for the thing that opens the pair.
 */
export type MeetingAudioSource = MeetingStreamId;

/** The subset of `navigator.mediaDevices` this module touches, for tests. */
export interface MediaDeviceSeam {
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  getDisplayMedia?: (constraints: DisplayMediaStreamOptions) => Promise<MediaStream>;
}

export const SYSTEM_AUDIO_UNSUPPORTED =
  "This browser can't share the Mac's audio. Chrome 141 or newer on macOS 14.2 or newer can; the microphone still works here.";

export const SYSTEM_AUDIO_NOT_SHARED =
  'Chrome shared the screen without its sound. Start again and tick "Also share system audio" in the picker.';

/** Whether the chooser should offer "This Mac's audio" at all. */
export function systemAudioOffered(
  devices: MediaDeviceSeam | undefined = defaultDevices(),
): boolean {
  return typeof devices?.getDisplayMedia === 'function';
}

/**
 * The share request. `systemAudio: 'include'` is what puts the audio box in
 * the picker; `selfBrowserSurface: 'exclude'` keeps this very tab out of the
 * list, since nobody wants to transcribe the notetaker; video cannot be
 * declined — Chrome refuses an audio-only share — so it is asked for and
 * dropped.
 */
export const SYSTEM_AUDIO_REQUEST: DisplayMediaStreamOptions & Record<string, unknown> = {
  video: true,
  audio: {
    channelCount: 1,
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
  },
  systemAudio: 'include',
  selfBrowserSurface: 'exclude',
};

/**
 * The wording the strip shows while a mic + Mac-audio meeting runs.
 *
 * Echo cancellation is the mechanism and headphones are the fallback, in
 * that order, because that is the order they actually work in: the canceller
 * removes what the Mac is PLAYING from what the microphone hears, and it is a
 * best-effort filter running on the device rather than a guarantee. Where it
 * falls short the remote side is heard twice — once through the Mac's own
 * audio and once bounced off the room — and headphones are what removes the
 * second copy outright.
 */
export const COMBINED_ECHO_NOTE =
  'Hearing the room and this Mac. Headphones keep remote voices from being heard twice.';

/** Open the source. Throws an `Error` whose `message` the strip can show. */
export async function openMeetingSource(
  source: MeetingAudioSource,
  constraints: MediaStreamConstraints,
  devices: MediaDeviceSeam | undefined = defaultDevices(),
): Promise<MediaStream> {
  if (source === 'system') {
    if (typeof devices?.getDisplayMedia !== 'function') {
      throw named('SystemAudioUnsupported', SYSTEM_AUDIO_UNSUPPORTED);
    }
    const shared = await devices.getDisplayMedia(SYSTEM_AUDIO_REQUEST);
    // The screen was the price of the picker; release it before a single
    // frame is drawn, so the share badge names audio and nothing else.
    for (const track of shared.getVideoTracks()) {
      track.stop();
      shared.removeTrack(track);
    }
    if (shared.getAudioTracks().length === 0) {
      throw named('SystemAudioNotShared', SYSTEM_AUDIO_NOT_SHARED);
    }
    return shared;
  }
  if (typeof devices?.getUserMedia !== 'function') {
    throw named('NotFoundError', 'no mediaDevices');
  }
  return devices.getUserMedia(constraints);
}

/**
 * A getUserMedia rejection, as one of the codes `recognitionErrorMessage`
 * already has words for. Anything it does not recognise keeps its own name, so
 * the message names something a search will find rather than "unknown error".
 */
export function mediaErrorCode(err: unknown): string {
  const name = (err as { name?: unknown } | null)?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'not-allowed';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'audio-capture';
  return typeof name === 'string' && name.length > 0 ? name : 'unknown';
}

/** Whether an error is one of this module's, whose message is the answer. */
export function isSourceRefusal(err: unknown): err is Error {
  const name = (err as { name?: unknown } | null)?.name;
  return name === 'SystemAudioUnsupported' || name === 'SystemAudioNotShared';
}

function named(name: string, message: string): Error {
  return Object.assign(new Error(message), { name });
}

function defaultDevices(): MediaDeviceSeam | undefined {
  return typeof navigator === 'undefined' ? undefined : (navigator.mediaDevices as MediaDeviceSeam);
}
