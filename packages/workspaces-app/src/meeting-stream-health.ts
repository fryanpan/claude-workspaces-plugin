/**
 * What happens when one of a meeting's captures dies, in words and in policy.
 *
 * `meeting-track-watch.ts` NOTICES the loss. This decides what it means: which
 * streams can be got back without a person, what the strip says while one is
 * gone, and what the button is called when only a person can fix it. No DOM,
 * no timers, no media — every answer here is a pure function of which streams
 * are down and which are still running, which is what makes the wording
 * testable rather than a thing somebody reads off a screenshot.
 *
 * THE ONE ASYMMETRY THAT SHAPES ALL OF IT. A microphone can come back on its
 * own: the page already holds the permission, so `getUserMedia` reopens it
 * with no prompt, and a person who never knew it went away is the best
 * outcome. The Mac's own audio cannot: it arrives through `getDisplayMedia`,
 * which is a modal that browsers refuse to open without a fresh user gesture.
 * Trying anyway does not fail loudly — it fails as a rejected promise the
 * person never sees — so this module marks it as needing a press, and the
 * strip renders a button rather than a sentence.
 *
 * WHY THE WORDING NAMES BOTH HALVES. The meeting that produced this code
 * carried two streams; a share started mid-meeting killed one of them. A line
 * that says only "audio stopped" is read as "the recording is dead" and the
 * person stops a meeting that is still catching every word they say. So every
 * sentence here names what stopped AND what is still being recorded — the same
 * rule `partialCaptureNote` follows for a stream refused at the start, because
 * it is the same person reading the same line for the same reason.
 */

import type { MeetingStreamId } from '@claude-workspaces/core';
import { createReconnectPlan } from './meeting-reconnect.ts';
import type { TrackLossReason } from './meeting-track-watch.ts';

/** What a stream is called where a person reads it. */
export function streamWords(stream: MeetingStreamId): string {
  return stream === 'system' ? "this Mac's audio" : 'the microphone';
}

/** Who a stream carries, for the half of the sentence about what is lost. */
function whoIsLost(stream: MeetingStreamId): string {
  return stream === 'system' ? "voices on the call aren't" : "people in the room aren't";
}

/**
 * Whether this stream can be reopened without a person pressing something.
 *
 * The whole of the auto-recovery policy, in one place, because it is the fact
 * every other surface derives from: whether the strip shows a sentence or a
 * button, whether a retry loop starts, and whether "trying to get it back" is
 * a true thing to say.
 */
export function reopensWithoutGesture(stream: MeetingStreamId): boolean {
  return stream !== 'system';
}

/** The label on the button that only a person's press can work. */
export function reopenActionLabel(stream: MeetingStreamId): string {
  return stream === 'system' ? "Share this Mac's audio again" : 'Start the microphone again';
}

/** One capture that is currently down. */
export interface LostStream {
  stream: MeetingStreamId;
  reason: TrackLossReason;
  /** Whether a reopen this page started is still in flight. */
  recovering: boolean;
}

/** What the strip should show about the captures, or null when all is well. */
export interface StreamAlarm {
  /** The sentence, naming what stopped and what is still recording. */
  text: string;
  /** Present only where a person's press is the only way back. */
  action?: { stream: MeetingStreamId; label: string };
}

/**
 * The alarm for the current state of a meeting's captures.
 *
 * `running` is what is still delivering audio — never what the meeting asked
 * for. A meeting whose every stream has died says so in the strongest terms it
 * has, because that is the case where the person's own words are going
 * nowhere and the recording light is lying to them.
 */
export function streamAlarm(opts: {
  lost: readonly LostStream[];
  running: readonly MeetingStreamId[];
}): StreamAlarm | null {
  const lost = opts.lost;
  if (lost.length === 0) return null;
  const missing = lost.map((l) => streamWords(l.stream)).join(' and ');
  const capitalised = missing.charAt(0).toUpperCase() + missing.slice(1);
  // "Trying to get it back" is said only while it is TRUE. A stream whose
  // retries have run out, and one that never had any because only a person can
  // reopen it, both fall through to the button instead — a sentence promising
  // a recovery nobody is attempting is the same lie as the silent recording.
  const tail = lost.every((l) => l.recovering) ? ' Trying to get it back.' : '';
  const needsPress = lost.find((l) => !l.recovering);
  const action = needsPress
    ? { stream: needsPress.stream, label: reopenActionLabel(needsPress.stream) }
    : undefined;

  if (opts.running.length === 0) {
    // Nothing is being heard at all. There is no "still recording" half to
    // offer, and no softening: this is the case where the recording light is
    // lying and the strip is the only thing that can say so.
    return {
      text: `${capitalised} stopped — nothing is being recorded.${tail}`,
      ...(action ? { action } : {}),
    };
  }
  const kept = opts.running.map(streamWords).join(' and ');
  const who = lost.map((l) => whoIsLost(l.stream)).join(', and ');
  return {
    text: `${capitalised} stopped — ${who} being recorded. Still recording ${kept}.${tail}`,
    ...(action ? { action } : {}),
  };
}

/** What the strip says for a moment once a stream comes back. */
export function restoredNote(stream: MeetingStreamId): string {
  const words = streamWords(stream);
  return `${words.charAt(0).toUpperCase()}${words.slice(1)} is recording again.`;
}

/**
 * How long a restored-note stays up before the strip goes back to the words.
 *
 * Long enough to be read by somebody who was talking when it appeared, short
 * enough that it is not still on screen when the next thing happens.
 */
export const RESTORED_NOTE_MS = 6_000;

/**
 * The retry schedule for a stream that can come back on its own.
 *
 * Deliberately the SOCKET's schedule (`meeting-reconnect.ts`) rather than a
 * second one: both are "something the meeting needs went away, keep asking for
 * it politely, and stop before the recording light is a lie". Two ladders
 * would be two things to tune and two things to get wrong, and this one is
 * already bounded at both ends for reasons that apply unchanged here.
 */
export const createStreamRetryPlan = createReconnectPlan;
