/**
 * Noticing that a capture has died under a meeting that is still running.
 *
 * THE FAILURE THIS EXISTS FOR IS AN ABSENCE, NOT AN ERROR. A `MediaStreamTrack`
 * can be ended by something that is not this page — macOS and Chrome
 * re-arbitrate screen capture the moment a person starts sharing their screen,
 * and a `getDisplayMedia` audio track opened before that can simply stop. What
 * happens next is the whole bug: a `MediaStreamAudioSourceNode` downstream of a
 * dead track keeps being pulled and keeps delivering SILENCE, so the pump still
 * fires, frames still leave the device at fifty a second, the socket stays open
 * and the engine hears a quiet room. Every health signal a meeting had said
 * everything was fine, and the recording was silent for minutes.
 *
 * TWO SIGNALS, BECAUSE ONE OF THEM IS NOT GUARANTEED TO ARRIVE.
 *
 * - The `ended` event, which is what a browser fires when the SOURCE ends. It
 *   is the fast path and the one the real failure takes.
 * - `readyState`, read on every audio block. The audio graph is already
 *   ticking twenty times a second, so it is a clock this module gets for free,
 *   and it catches an end whose event never came — including the one the spec
 *   guarantees will not fire one, because `track.stop()` called in-page ends a
 *   track SILENTLY. Nothing here polls: `tick` is called by the audio the
 *   capture was going to process anyway.
 *
 * AND A THIRD STATE THAT IS NOT AN END. `muted` on a track means the source is
 * not currently delivering data — the same silent recording, without the track
 * ever ending. It is also transient by design, so reporting it at once would
 * cry wolf. It has to PERSIST past `MUTE_LOST_MS` before it counts, measured on
 * the same block clock, and an `unmute` inside the window clears it with
 * nothing said. Silence in the room is NOT this: `muted` is a fact about the
 * source, not about how loud it is, so a quiet meeting never trips it.
 *
 * IT REPORTS ONCE. A loss is an edge, and the surfaces downstream — a sentence
 * on the strip, a gap opened in the durable record — are things that happen
 * once per loss and are undone by a recovery, never repeated per block.
 */

/** Why a capture stopped delivering. Both are "no audio is arriving". */
export type TrackLossReason = 'ended' | 'muted';

/**
 * How long a track may sit `muted` before it counts as lost.
 *
 * Five seconds, from the requirement rather than from the platform: the
 * person has to learn about a dead microphone in seconds rather than at the
 * end of the meeting, and a mute shorter than this is a glitch they will
 * never have noticed. A track that ENDS is not held for this window — an end
 * is final, and there is nothing to wait to see.
 */
export const MUTE_LOST_MS = 5_000;

/** The bits of a `MediaStreamTrack` this module reads. */
export interface WatchableTrack {
  readonly readyState: MediaStreamTrackState;
  readonly muted: boolean;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

export interface TrackWatch {
  /**
   * One beat of the audio graph's own clock. Called from the block handler,
   * so a capture that is producing silence is still being checked.
   */
  tick(): void;
  /** Whether this watch has already reported its loss. */
  lost(): boolean;
  /** Take the listeners off. Called when the capture is torn down. */
  stop(): void;
}

/**
 * Watch every track behind one capture, and report the first loss once.
 *
 * A capture is one stream and in practice one audio track; the set is watched
 * rather than the first, because a browser is free to hand back more than one
 * and a meeting is silent if ANY of the tracks it is mixing has died.
 */
export function watchTracks(opts: {
  tracks: readonly WatchableTrack[];
  onLost: (reason: TrackLossReason) => void;
  now?: () => number;
}): TrackWatch {
  const now = opts.now ?? (() => Date.now());
  const installed: Array<{ track: WatchableTrack; type: string; fn: () => void }> = [];
  /** When a track first went quiet without ending, or null while all are live. */
  let mutedSince: number | null = null;
  let reported = false;
  let stopped = false;

  function report(reason: TrackLossReason): void {
    if (reported || stopped) return;
    reported = true;
    opts.onLost(reason);
  }

  function check(): void {
    if (reported || stopped) return;
    if (opts.tracks.some((t) => t.readyState === 'ended')) {
      report('ended');
      return;
    }
    if (opts.tracks.some((t) => t.muted)) {
      // The window opens on the first block that sees the mute, not on the
      // event: an `unmute` that never came is exactly the case this catches,
      // and it has no event of its own to hang a deadline on.
      mutedSince ??= now();
      if (now() - mutedSince >= MUTE_LOST_MS) report('muted');
      return;
    }
    mutedSince = null;
  }

  for (const track of opts.tracks) {
    for (const type of ['ended', 'mute', 'unmute']) {
      const fn = () => check();
      track.addEventListener(type, fn);
      installed.push({ track, type, fn });
    }
  }
  // The state a track was ALREADY in when the watch went on. A capture opened
  // onto a track that had died in the meantime would otherwise wait for an
  // event that has already fired.
  check();

  return {
    tick: check,
    lost: () => reported,
    stop() {
      stopped = true;
      for (const { track, type, fn } of installed) track.removeEventListener(type, fn);
      installed.length = 0;
    },
  };
}
