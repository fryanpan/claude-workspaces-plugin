/**
 * Opening every stream one meeting wants, and reporting honestly on the ones
 * it did not get.
 *
 * A mic + Mac-audio meeting asks the browser for two different things through
 * two different doors: `getUserMedia`, which the page may already hold a
 * permission for, and `getDisplayMedia`, which is a modal the person has to
 * drive and can close. Either can be refused on its own, so "the capture
 * started" and "the capture started with everything asked for" are two
 * different facts and this module keeps them apart.
 *
 * PARTIAL IS A SUCCESS, AND IT SAYS SO. A refused share picker with a working
 * microphone is still a meeting worth recording — Bryan is in the room and the
 * words he says are the ones being lost while nobody records them. So the set
 * opens on whatever was granted and hands back a sentence naming what is
 * missing, and the `start` frame then names the source that is ACTUALLY
 * running rather than the one that was asked for: a record that claims two
 * streams and holds one is a record that lies about a meeting.
 *
 * ONLY EVERYTHING REFUSED IS A REFUSAL. With no streams at all there is
 * nothing to transcribe, and the strip goes to its blocked state carrying the
 * reasons — both of them, because a person who was refused twice needs to know
 * which door to go back through.
 *
 * IT IS NOT `meeting-audio.ts`. That file is one capture: the graph, the
 * resampler, the frame. This one is the set of them, and it holds no audio
 * machinery of its own — every stream it opens goes through
 * `startMeetingCapture` exactly as a single-source meeting always did.
 */

import {
  COMBINED_SOURCE,
  type CaptureMode,
  type MeetingCaptureSource,
  type MeetingStreamId,
  sourceForStreams,
  streamsForSource,
  tagAudioFrame,
} from '@claude-workspaces/core';
import {
  type MeetingCapture,
  type MeetingCaptureStart,
  ROOM_AUDIO_DEFAULT,
  type RoomAudioProcessing,
  startMeetingCapture,
} from './meeting-audio.ts';

/** The one seam this module has: how a single stream is opened. */
export type StartOneCapture = (opts: {
  onFrame: (pcm: Int16Array) => void;
  mode: CaptureMode;
  room?: RoomAudioProcessing;
  source?: MeetingStreamId;
}) => Promise<MeetingCaptureStart>;

/**
 * What the microphone is asked for in a mic + Mac-audio meeting.
 *
 * Echo cancellation and noise suppression are FORCED ON here, and this is the
 * one place a `?mic=ec0` on the address is overruled. The reason is that the
 * knob was measured for a room with no far-end signal in it (see
 * `ROOM_AUDIO_DEFAULT`), and this mode always has one: the Mac is playing the
 * remote side into the same room the microphone is listening to. Without
 * cancellation every remote sentence is transcribed twice, under two speaker
 * labels in two different groups — precisely what this mode exists to keep
 * apart. A `solo` capture reaches the same place by a different road: it does
 * not read this config at all, and the constraints it does use ask for echo
 * cancellation already.
 */
export function combinedMicRoom(room?: RoomAudioProcessing): RoomAudioProcessing {
  return { ...(room ?? ROOM_AUDIO_DEFAULT), echoCancellation: true, noiseSuppression: true };
}

/** A stream that was asked for and refused, with what to do about it. */
export interface CaptureRefusal {
  stream: MeetingStreamId;
  kind: 'insecure' | 'denied';
  message: string;
}

export type CaptureSetResult =
  | {
      ok: true;
      /** Every capture that opened, in the order they were asked for. */
      captures: ReadonlyArray<{ stream: MeetingStreamId; capture: MeetingCapture }>;
      /** The source that is actually running — never the one that was asked for. */
      source: MeetingCaptureSource;
      /** Streams asked for and refused. Empty on a capture that got it all. */
      refusals: readonly CaptureRefusal[];
      /** Whether frames on the wire carry a stream byte. */
      tagged: boolean;
      /** Feed every open stream one frame each way — stop, echo cancellation. */
      stopAll(): void;
      setEchoCancellation(on: boolean): Promise<void>;
    }
  | {
      ok: false;
      kind: 'insecure' | 'denied';
      /** One sentence for the strip: every refusal, in the order asked. */
      message: string;
      refusals: readonly CaptureRefusal[];
    };

/** What a stream is called where a person reads it. */
function streamWords(stream: MeetingStreamId): string {
  return stream === 'system' ? "this Mac's audio" : 'the microphone';
}

/**
 * What the strip says when one of two streams was refused.
 *
 * It names BOTH halves — what is missing and what is still running — because
 * a line that only says what failed reads as a meeting that did not start,
 * and the person would stop and try again over a recording that is already
 * catching every word they say.
 */
export function partialCaptureNote(
  refusals: readonly CaptureRefusal[],
  running: readonly MeetingStreamId[],
): string {
  if (refusals.length === 0 || running.length === 0) return '';
  const missing = refusals.map((r) => streamWords(r.stream)).join(' and ');
  const kept = running.map(streamWords).join(' and ');
  return `Recording without ${missing} — ${refusals[0]?.message ?? ''} Running on ${kept}.`.replace(
    /\s+/g,
    ' ',
  );
}

/**
 * Open the streams a source names, in the order it names them.
 *
 * Sequential, because the second door is a modal: asking for the share picker
 * while the microphone prompt is still up puts two permission dialogs on
 * screen at once, and a browser is free to drop one of them.
 */
export async function openCaptureSet(opts: {
  source: MeetingCaptureSource;
  mode: CaptureMode;
  room?: RoomAudioProcessing;
  onFrame: (pcm: Uint8Array | Int16Array) => void;
  startCapture?: StartOneCapture;
}): Promise<CaptureSetResult> {
  const startOne = opts.startCapture ?? startMeetingCapture;
  const wanted = streamsForSource(opts.source);
  const tagged = wanted.length > 1;
  const captures: Array<{ stream: MeetingStreamId; capture: MeetingCapture }> = [];
  const refusals: CaptureRefusal[] = [];

  for (const stream of wanted) {
    const started = await startOne({
      onFrame: (pcm) => {
        // A tag only where there are two streams to tell apart. One stream
        // puts raw PCM on the wire, byte-for-byte what it always did, so an
        // older server reads this meeting exactly as it read the last one.
        opts.onFrame(
          tagged
            ? tagAudioFrame(stream, new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength))
            : pcm,
        );
      },
      mode: opts.mode,
      // The microphone in a combined meeting is listening to a room the Mac
      // is playing into; see `combinedMicRoom`.
      ...(stream === 'mic' && opts.source === COMBINED_SOURCE
        ? { room: combinedMicRoom(opts.room) }
        : opts.room
          ? { room: opts.room }
          : {}),
      source: stream,
    });
    if (started.ok) captures.push({ stream, capture: started.capture });
    else refusals.push({ stream, kind: started.kind, message: started.message });
  }

  const running = captures.map((c) => c.stream);
  const source = sourceForStreams(running);
  if (source === undefined) {
    return {
      ok: false,
      // An insecure origin gives no microphone to any press and is the
      // stronger claim: it is the one a retry cannot fix.
      kind: refusals.some((r) => r.kind === 'insecure') ? 'insecure' : 'denied',
      message: refusals.map((r) => r.message).join(' '),
      refusals,
    };
  }
  return {
    ok: true,
    captures,
    source,
    refusals,
    // What is on the WIRE follows what actually opened, not what was asked
    // for: a set that lost its second stream sends untagged frames, and the
    // server it is talking to reads them as the one stream it was told about.
    tagged: running.length > 1,
    stopAll() {
      for (const { capture } of captures) capture.stop();
    },
    async setEchoCancellation(on: boolean) {
      await Promise.all(captures.map(({ capture }) => capture.setEchoCancellation(on)));
    },
  };
}
