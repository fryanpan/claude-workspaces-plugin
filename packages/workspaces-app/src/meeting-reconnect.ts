/**
 * How long a dropped meeting socket keeps trying, and when it stops.
 *
 * The socket IS the meeting's lifecycle, so a connection that drops mid
 * sentence used to end the recording: the microphone closed, the strip said
 * the connection was lost, and pressing Record again opened a NEW meeting with
 * a new id, a new transcript file and a second notes section under the same
 * conversation. The server has kept one section per meeting across a restart
 * since PR 824; this is the client half — the mic stays open and the same
 * meeting id is offered back until the server can take it.
 *
 * WHY THE POLICY IS ITS OWN MODULE. It is the only part of the reconnect with
 * a decision in it — how long to wait, and when to give up — and it is the
 * part that has to be driven through a dozen attempts to be believed. No DOM,
 * no socket, no timers: it answers "what now" and the strip does it.
 *
 * THE BACKOFF IS BOUNDED IN BOTH DIRECTIONS. Each gap grows so a server that
 * is down is not hammered by every open tab, and it stops growing at fifteen
 * seconds so a server that comes back is found within one of them rather than
 * minutes later. The whole window ends at two minutes because an outage longer
 * than that has almost certainly taken the meeting with it — the engine
 * session is gone, the room has moved on — and a microphone held open against
 * a server that is never answering is a recording light with nothing behind
 * it.
 */

/**
 * The gaps between attempts, in order; the last one repeats. Doubling from a
 * second is short enough that a deploy's restart (a few seconds) is invisible,
 * and the fifteen-second cap is what keeps a long outage cheap.
 */
export const RECONNECT_DELAYS_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000, 15_000];

/** How long the whole run of attempts may last before the meeting is let go. */
export const RECONNECT_WINDOW_MS = 120_000;

/** What to do about a socket that just went away. */
export type ReconnectStep =
  /** Try again in `delayMs`. `attempt` counts from 1 for the first retry. */
  | { kind: 'retry'; delayMs: number; attempt: number }
  /** The window is spent: this meeting is over, and the strip says so. */
  | { kind: 'give-up' };

export interface ReconnectPlan {
  /**
   * The socket dropped (or an attempt to reopen it failed). Answers whether
   * to try again and how long to wait first.
   */
  dropped(): ReconnectStep;
  /** A reconnect landed: the window and the backoff start over. */
  succeeded(): void;
  /** How many retries this run has asked for. Zero while connected. */
  attempts(): number;
}

export interface ReconnectPlanOpts {
  now?: () => number;
  delays?: readonly number[];
  windowMs?: number;
}

/**
 * A fresh plan. One per mount rather than per meeting: `succeeded` is what
 * puts it back to the start, so a meeting that survives one outage gets the
 * whole window again for the next.
 */
export function createReconnectPlan(opts: ReconnectPlanOpts = {}): ReconnectPlan {
  const now = opts.now ?? Date.now;
  const delays = opts.delays && opts.delays.length > 0 ? opts.delays : RECONNECT_DELAYS_MS;
  const windowMs = opts.windowMs ?? RECONNECT_WINDOW_MS;
  /** When the CURRENT run of failures began, or null while connected. */
  let since: number | null = null;
  let attempt = 0;
  return {
    dropped() {
      const at = now();
      // The window is measured from the first drop, not from the last
      // attempt: a run of failures that keeps resetting its own deadline
      // never has one.
      if (since === null) since = at;
      if (at - since >= windowMs) return { kind: 'give-up' };
      const delayMs = delays[Math.min(attempt, delays.length - 1)] as number;
      attempt += 1;
      return { kind: 'retry', delayMs, attempt };
    },
    succeeded() {
      since = null;
      attempt = 0;
    },
    attempts() {
      return attempt;
    },
  };
}

/**
 * What the strip says while it is trying. One plain sentence, because the
 * strip has one line and the words share it with the transcript.
 *
 * It says the ONE thing a person mid-meeting can act on — a long outage costs
 * words, a short one does not — and not how the holding works. The mechanism
 * is `AUDIO_HOLD_MS` below, and explaining it here would double a line that
 * has no room and calm nobody down.
 */
export const RECONNECTING_NOTE =
  'The connection dropped — reconnecting. A long outage loses what was said.';

/**
 * And what it says when the meeting could not be picked up again: the
 * recording carries on, under a new meeting with a section of its own, and
 * nothing pretends the two halves are one.
 */
export const RESUME_FAILED_NOTE =
  'The earlier meeting could not be resumed, so this is a new recording with its own notes section.';

/**
 * How much of the audio spoken during an outage a reconnect carries across.
 *
 * THE DROP IS DELIBERATE AND IT STAYS. Replaying a minute of banked speech
 * into an engine session that has just opened means paying for it by the
 * second while the words arrive out of time with the ones around them, and a
 * transcript nobody can trust is worse than a hole a reader can see. What was
 * wrong was that the bound was zero: a three-second blip cost three seconds
 * of conversation, and five of them inside one real meeting cost 36 seconds.
 *
 * EIGHT SECONDS, and the number has three reasons rather than a feel:
 *
 * - The outages measured on the meeting this fix comes from ran 3 to 8
 *   seconds. The cap covers the whole measured band and nothing beyond it.
 * - It covers the 1 + 2 + 4 = 7 seconds the backoff waits before its fourth
 *   attempt, with a second to spare — so an outage the reconnect resolves
 *   early is covered, and one still failing after that is past the point
 *   where a burst is the right answer anyway.
 * - It fits inside the server's own pre-handshake buffer with room to spare.
 *   That buffer holds 256 frames — 12.8 seconds at this frame size — and the
 *   replay goes out before the handshake finishes, so `AUDIO_HOLD_FRAMES`
 *   leaves 4.8 seconds of handshake headroom before the far end would start
 *   dropping what this end just carefully kept.
 *
 * Past it the excess is dropped exactly as all of it used to be: the oldest
 * frames go, because what a room wants back is the sentence it was in the
 * middle of, not the one before the network died.
 */
export const AUDIO_HOLD_MS = 8_000;

/**
 * And the same bound counted in FRAMES, which is the one that binds when a
 * meeting is carrying more than one capture.
 *
 * `meeting-capture-set.ts` forwards the microphone and the Mac's own audio
 * through a single `onFrame`, so a mic+system meeting banks two frames every
 * 50 ms: eight seconds of it is ~320 frames against the 256 the server's
 * pre-handshake buffer holds. Overflowing that buffer is the worst shape this
 * whole change has, because the far end drops the NEWEST frames — the seam,
 * the part the hold exists to keep — while the start frame goes on claiming
 * the full `heldMs`, and the server then shortens the gap over audio it threw
 * away. A record that understates a loss is the thing being fixed here, so
 * the hold cannot be the thing that causes one.
 *
 * 160 is therefore the SHARED budget however many captures fill it: eight
 * seconds of one capture, four of two. `heldMs` stays honest either way
 * because it is measured from the oldest frame still held, not from the cap.
 */
export const AUDIO_HOLD_FRAMES = 160;

/** What a hold hands back when it is read. */
export interface HeldAudio {
  /** Every frame still inside the cap, oldest first. */
  frames: readonly ArrayBufferView[];
  /**
   * From the oldest frame still held to the moment it was read.
   *
   * The server subtracts it from the outage to work out what was actually
   * lost, so it has to be the span the frames COVER rather than the cap or
   * the length of the outage. Zero when nothing was held, which is the same
   * answer as never having held anything.
   */
  heldMs: number;
}

/**
 * A bounded, ordered bank of audio frames.
 *
 * Opaque frames in order rather than one bank per stream: a two-stream
 * meeting tags each frame with the stream it belongs to before it reaches
 * here, so one queue replays both in the order they were captured, and the
 * cap is one fact about time rather than a number that has to be divided by
 * however many captures are open.
 */
export interface AudioHold {
  /** Bank one frame. Anything past either cap — age or count — is dropped. */
  push(frame: ArrayBufferView, at: number): void;
  /**
   * Everything still inside the cap, WITHOUT emptying the hold.
   *
   * A replay goes out on the new socket's `open`, and that socket can still
   * die before the server answers `ready` — a handshake the server refuses
   * with `already_recording` while the dropped socket's teardown holds the
   * doc, or simply another drop. Emptying here would mean the retry after
   * that has nothing left to replay, which loses exactly the audio the hold
   * exists to keep. So the hold is read and kept, and only a `ready` empties
   * it (`clear`).
   */
  peek(at: number): HeldAudio;
  /** Forget it all — a resume that landed, a new recording, or one nobody
   *  took. */
  clear(): void;
}

export function createAudioHold(opts: { capMs?: number; capFrames?: number } = {}): AudioHold {
  const capMs = opts.capMs ?? AUDIO_HOLD_MS;
  const capFrames = opts.capFrames ?? AUDIO_HOLD_FRAMES;
  let frames: Array<{ frame: ArrayBufferView; at: number }> = [];
  /** Drop what is now past either cap, measured back from `at`. */
  const expire = (at: number): void => {
    // A linear scan from the front rather than a filter: frames arrive in
    // time order, so everything to drop is at the head.
    let first = 0;
    while (first < frames.length && at - (frames[first]?.at ?? at) > capMs) first += 1;
    // Then the count, from the same end: whichever bound bites first, what
    // goes is the oldest audio and what stays is the seam.
    first = Math.max(first, frames.length - capFrames);
    if (first > 0) frames = frames.slice(first);
  };
  return {
    push(frame, at) {
      frames.push({ frame, at });
      expire(at);
    },
    peek(at) {
      expire(at);
      const oldest = frames[0]?.at;
      return {
        frames: frames.map((f) => f.frame),
        heldMs: oldest === undefined ? 0 : Math.max(0, at - oldest),
      };
    },
    clear() {
      frames = [];
    },
  };
}
