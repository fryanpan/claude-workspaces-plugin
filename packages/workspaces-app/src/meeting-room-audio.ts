/**
 * What the browser is ASKED for: the three microphone processors, the address
 * knob that moves them, and the constraints each capture mode sends.
 *
 * Split out of `meeting-audio.ts`, which is the machinery — the graph, the
 * resampler, the frame on the wire. This file holds no machinery at all: it
 * is one measured decision, its evidence, and the spelling a person types in
 * an address bar to overrule it. `meeting-audio.ts` re-exports every name
 * here, so nothing that imported them had to move.
 */

import type { CaptureMode } from '@claude-workspaces/core';

/**
 * The browser's three microphone processors, as one config.
 *
 * They are a config rather than three literals because a ROOM is not the
 * situation any of them was tuned for. Echo cancellation, noise suppression
 * and automatic gain control are built for one near-field talker on a laptop:
 * AGC renormalises level continuously, noise suppression gates the quieter
 * part of the spectrum, and both act on exactly the cues — relative loudness,
 * timbre, the difference between the person at the mic and the person across
 * the table — that a diarizer uses to tell two voices apart. Whether they
 * help or hurt a shared microphone is a MEASUREMENT, not an opinion, and
 * `scripts/room-labels-check.ts` is the instrument; this shape is what lets
 * one recording session vary them.
 */
export interface RoomAudioProcessing {
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
}

/**
 * What a solo capture asks for: the three answers this subsystem has always
 * given, kept as their own constant so that moving the ROOM default below
 * cannot reach a case it was never measured on. One person holding a device
 * is not a room, and nothing here has measured it.
 */
const SOLO_AUDIO_PROCESSING: RoomAudioProcessing = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

/**
 * What a room capture asks for, now that the measurement has spoken.
 *
 * Measured through the real engine on one far-field element of the AMI array
 * — one microphone on a table with people around it. The figure is the one
 * that survives a change of denominator: reference words BOTH transcribed and
 * attributed to the person who said them, over every word said in the window.
 * (Attribution over the part a run covered cannot rank settings, because each
 * setting produces a different transcript and so covers a different amount.)
 *
 *     two people, 120s     raw 16.4%   ns 34.4%   agc 13.4%   ns+agc 16.4%
 *     four people, 120s    raw 27.3%   ns 29.5%   agc 31.8%   ns+agc 49.0%
 *
 * NOISE SUPPRESSION ON beats noise suppression off in all four pairings —
 * both windows, gain control either way. That one is not close and it is not
 * split.
 *
 * GAIN CONTROL IS SPLIT, and the honest reading is that it depends on how
 * many people are in the room. On two voices it costs (13.4 against 16.4, and
 * it cancels the whole of noise suppression's gain: 16.4 against 34.4); on
 * four it helps (31.8 against 27.3, and the best row of the eight). A
 * mechanism fits both halves: telling people apart on ONE microphone leans on
 * how loud each of them is, so removing that difference costs when two voices
 * are already separable and pays when four voices are so unequal that the
 * quiet ones are lost entirely.
 *
 * So this default is chosen for the room this product is FOR — two people
 * with a device on the table — and not by a majority of the eight numbers. A
 * bigger room wants `?mic=ec1-ns1-agc1`, which is exactly why the knob is on
 * the address.
 *
 * Echo cancellation stays on and UNMEASURED: it cancels what the device's own
 * speaker is playing, and an AMI recording has no far-end signal to cancel,
 * so no run here says anything about it either way.
 *
 * These were ffmpeg approximations of a browser's processors, on two windows
 * of one meeting. Bryan's own recording is what confirms them; moving this
 * line back is as cheap as moving it was.
 */
export const ROOM_AUDIO_DEFAULT: RoomAudioProcessing = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: false,
};

/** The short spelling the address knob and the measurement report share. */
export function formatRoomAudio(cfg: RoomAudioProcessing): string {
  const bit = (on: boolean) => (on ? '1' : '0');
  return `ec${bit(cfg.echoCancellation)}-ns${bit(cfg.noiseSuppression)}-agc${bit(cfg.autoGainControl)}`;
}

/**
 * A config out of `ec1-ns0-agc0`, or nothing.
 *
 * Nothing for anything unreadable, so a typo in an address bar falls back to
 * the default instead of silently recording under half a setting. Each flag
 * is independent: `ns0` alone leaves the other two at their defaults.
 */
export function parseRoomAudio(raw: string | null | undefined): RoomAudioProcessing | undefined {
  if (!raw) return undefined;
  const flags = /^(?:ec([01])-?)?(?:ns([01])-?)?(?:agc([01]))?$/.exec(raw.trim().toLowerCase());
  if (!flags || flags.slice(1).every((f) => f === undefined)) return undefined;
  const read = (v: string | undefined, fallback: boolean) =>
    v === undefined ? fallback : v === '1';
  return {
    echoCancellation: read(flags[1], ROOM_AUDIO_DEFAULT.echoCancellation),
    noiseSuppression: read(flags[2], ROOM_AUDIO_DEFAULT.noiseSuppression),
    autoGainControl: read(flags[3], ROOM_AUDIO_DEFAULT.autoGainControl),
  };
}

/** What the browser is asked for: one channel of cleaned-up speech. */
export const MEETING_CONSTRAINTS: MediaStreamConstraints = {
  audio: { channelCount: 1, ...SOLO_AUDIO_PROCESSING },
};

/**
 * The constraints for a capture, given what its room is doing.
 *
 * A `solo` capture is not a room and takes no config: it is one person at
 * arm's length, which is the case every one of these processors was designed
 * for, and it keeps `MEETING_CONSTRAINTS` exactly as it was.
 */
export function captureConstraints(
  mode: CaptureMode,
  room?: RoomAudioProcessing,
): MediaStreamConstraints {
  if (mode !== 'conversation') return MEETING_CONSTRAINTS;
  return { audio: { channelCount: 1, ...(room ?? ROOM_AUDIO_DEFAULT) } };
}
