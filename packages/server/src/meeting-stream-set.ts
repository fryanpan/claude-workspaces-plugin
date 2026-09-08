/**
 * One meeting, more than one engine session.
 *
 * A laptop on a call hears two rooms — the people present, through the
 * microphone, and the people dialled in, through the Mac's own output — and
 * `MeetingRelay` now has to run a transcription session for each while
 * keeping ONE meeting: one index row, one transcript, one notes pipeline, one
 * socket. This module is the piece that makes those two facts compatible.
 *
 * WHY IT IS NOT IN `meeting-protocol.ts`. That file owns the lifecycle — the
 * socket is the meeting, and every way it can end has to end the meeting
 * exactly once. What is here is a different job: fan one audio stream out to
 * the right session, and fold two engines' independent numbering back into one
 * transcript. Both would fit in the relay; neither would be findable there,
 * and the relay is already the largest file in the subsystem.
 *
 * THE THREE THINGS TWO SESSIONS COLLIDE ON, and what is done about each:
 *
 * - **Turn ids.** Both engines number from zero. `MeetingTurnMerger` hands out
 *   a global id per (stream, engine turn) IN ARRIVAL ORDER, so the ids merge
 *   the two streams by time and a revision still lands on the turn it belongs
 *   to. See its own comment for why arithmetic interleaving is wrong.
 * - **Speaker labels.** Both engines hand out "A". `namespacedSpeaker` puts
 *   the group in front, so a room Speaker A and a remote Speaker A are two
 *   voices that can be named separately and never merge in the record.
 * - **Opening.** Two billed sessions open in sequence, and the second can
 *   fail. A half-open set is closed rather than returned: a session nobody is
 *   feeding still bills, and a meeting that heard only half of what it
 *   promised is worse than a meeting that refused to start.
 *
 * A ONE-STREAM SET IS THE OLD BEHAVIOUR EXACTLY. No namespacing, no group on
 * a frame, and the turn ids are the engine's own — which is what every
 * microphone meeting recorded before this module reads back as.
 */

import {
  type MeetingGroup,
  type MeetingStreamId,
  MeetingTurnMerger,
  groupForStream,
  namespacedSpeaker,
} from '@claude-workspaces/core';
import type { MeetingTuning } from '@claude-workspaces/core';
import type {
  EngineTurn,
  TranscriptionEngine,
  TranscriptionOpenOpts,
  TranscriptionSession,
} from './transcribe.ts';

/** One turn, told apart from the other stream's. */
export interface StreamTurn extends EngineTurn {
  /** The stream whose engine produced it — the audio file it was heard on. */
  stream: MeetingStreamId;
  /** Where those people are. Absent on a single-stream meeting. */
  group?: MeetingGroup;
}

export interface StreamSetOpts {
  /** The engine every stream in this set opens on. One meeting, one bill rate. */
  engine: TranscriptionEngine;
  /** The streams to open, in the order they should be asked for. */
  streams: readonly MeetingStreamId[];
  /** What each session is opened with, apart from its callbacks. */
  session: Omit<TranscriptionOpenOpts, 'onTurn' | 'onError'>;
  /** One turn from one stream, already merged into this meeting's numbering. */
  onTurn: (turn: StreamTurn) => void;
  /** An engine said something went wrong. Named by stream, since two can. */
  onError: (message: string, stream: MeetingStreamId) => void;
}

/** Every stream of one meeting, behind the shape a single session had. */
export interface MeetingStreamSet {
  /** The streams that actually opened, in order. */
  readonly streams: readonly MeetingStreamId[];
  /** Whether labels are namespaced — true exactly when more than one opened. */
  readonly namespaced: boolean;
  /** Feed one chunk to one stream's engine. A stream not in the set is dropped. */
  send(stream: MeetingStreamId, audio: Uint8Array): void;
  /**
   * Apply live tuning to every session that can take it, and say whether any
   * could. Two sessions of one engine either both have `update` or neither
   * does, so this is still a single yes/no for the `tuned` answer.
   */
  update(tuning: MeetingTuning): boolean;
  /** Close every session, flushing each one's turn in progress. */
  close(): Promise<void>;
}

/**
 * Open one engine session per stream.
 *
 * Sequential rather than concurrent, and deliberately: the engines are paid
 * sockets and a `Promise.all` that rejects leaves the winners open with
 * nobody holding a handle to close them. Opening in order means the failure
 * path has an explicit list of what to take back.
 */
export async function openMeetingStreamSet(opts: StreamSetOpts): Promise<MeetingStreamSet> {
  const streams = [...opts.streams];
  if (streams.length === 0) throw new Error('a meeting needs at least one stream');
  const namespaced = streams.length > 1;
  const merger = new MeetingTurnMerger();
  const sessions = new Map<MeetingStreamId, TranscriptionSession>();

  for (const stream of streams) {
    try {
      const session = await opts.engine.open({
        ...opts.session,
        onTurn: (turn) => {
          opts.onTurn({
            ...turn,
            stream,
            // The engine's own numbering only survives a one-stream meeting;
            // past that the ids belong to the merge, or two streams' turn 0
            // would be one turn in the record.
            turn: namespaced ? merger.idFor(stream, turn.turn) : turn.turn,
            ...(turn.speaker !== undefined
              ? { speaker: namespaced ? namespacedSpeaker(stream, turn.speaker) : turn.speaker }
              : {}),
            ...(namespaced ? { group: groupForStream(stream) } : {}),
          });
        },
        onError: (message) => opts.onError(message, stream),
      });
      sessions.set(stream, session);
    } catch (err) {
      // Whatever opened before this one is a billed socket with no owner.
      // Close it before the failure leaves this function, and never let a
      // close failure hide the reason the set could not be built.
      await Promise.allSettled([...sessions.values()].map((s) => s.close()));
      throw err;
    }
  }

  return {
    streams,
    namespaced,
    send(stream, audio) {
      sessions.get(stream)?.send(audio);
    },
    update(tuning) {
      let applied = false;
      for (const session of sessions.values()) {
        if (!session.update) continue;
        session.update(tuning);
        applied = true;
      }
      return applied;
    },
    async close() {
      // allSettled: one engine refusing to close must not keep the other's
      // final sentence out of the record, and the relay logs what it gets.
      const results = await Promise.allSettled([...sessions.values()].map((s) => s.close()));
      const failed = results.find((r) => r.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
    },
  };
}
