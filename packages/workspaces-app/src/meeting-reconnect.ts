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
 */
export const RECONNECTING_NOTE =
  'The connection dropped — reconnecting. Words spoken until it comes back are not recorded.';

/**
 * And what it says when the meeting could not be picked up again: the
 * recording carries on, under a new meeting with a section of its own, and
 * nothing pretends the two halves are one.
 */
export const RESUME_FAILED_NOTE =
  'The earlier meeting could not be resumed, so this is a new recording with its own notes section.';
