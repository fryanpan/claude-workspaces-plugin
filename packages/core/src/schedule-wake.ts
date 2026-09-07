/**
 * The WAKE of a scheduled run — the board's bounded attempts to get somebody
 * onto the instance it just filed (docs/architecture/scheduled-tasks.md,
 * "The wake path").
 *
 * A filed instance with a named owner is not a run. The owner's session has
 * to be told, and if that session is not running somebody has to start it.
 * This module is the pure half: the retry schedule, what state one wake
 * carries, and the word the run record puts on it. The server
 * (`task-scheduled-wake.ts`) does the reaching; the board reads the state
 * this describes off the rule.
 *
 * ── Bounded, with backoff ─────────────────────────────────────────────────
 *
 * Four attempts: at the fire, then five, fifteen and forty-five minutes after
 * the previous one. After the last attempt the board waits one more window
 * and then stops trying and files a review item on the row instead — an
 * unanswered wake repeated forever is the log nobody reads, and a person is
 * the one who can start a session the board cannot. Every attempt is
 * recorded, whoever it reached, so "was it answered?" is a fact on the rule
 * rather than a guess from the silence.
 */

/** The wait AFTER attempt n before attempt n+1, and after the last before the
 *  board gives up. */
export const WAKE_BACKOFF_MS = [5 * 60_000, 15 * 60_000, 45 * 60_000] as const;
export const WAKE_MAX_ATTEMPTS = WAKE_BACKOFF_MS.length + 1;

/** Who one attempt reached. `nobody` is an attempt too: it is what bounds the run. */
export type WakeVia = 'owner' | 'spawner' | 'nobody';

export interface WakeAttempt {
  at: number;
  via: WakeVia;
  /** The agent id the frame went to, for `owner` and `spawner`. */
  to?: string;
}

/** One instance's wake, kept on the rule's `schedule.state`. A new instance
 *  starts a new one; the old is not history worth keeping there. */
export interface ScheduleWake {
  instanceId: string;
  attempts: WakeAttempt[];
  /** When the instance left `todo` — somebody took it. */
  answeredAt?: number;
  /** Who moved it, when the row says. */
  answeredBy?: string;
  /** The review item filed after the last attempt went unanswered. */
  exhaustedItemId?: string;
}

/** What the wake should do now. */
export type WakeStep = 'attempt' | 'wait' | 'exhausted';

export function wakeStep(wake: ScheduleWake | undefined, now: number): WakeStep {
  const n = wake?.attempts.length ?? 0;
  if (n === 0) return 'attempt';
  const last = wake?.attempts[n - 1]?.at ?? now;
  const backoff = WAKE_BACKOFF_MS[Math.min(n, WAKE_BACKOFF_MS.length) - 1] ?? 0;
  if (now - last < backoff) return 'wait';
  return n < WAKE_MAX_ATTEMPTS ? 'attempt' : 'exhausted';
}

/** Whether the wake was answered, as the run record says it. */
export type WakeStatus = 'answered' | 'waiting' | 'unanswered';

export function wakeStatus(wake: ScheduleWake): WakeStatus {
  if (wake.answeredAt !== undefined) return 'answered';
  return wake.exhaustedItemId !== undefined ? 'unanswered' : 'waiting';
}

/** The wake's attempts, as a person reads them: `owner ×2, spawner ×1, nobody ×1`. */
export function describeAttempts(wake: ScheduleWake): string {
  const counts = new Map<WakeVia, number>();
  for (const a of wake.attempts) counts.set(a.via, (counts.get(a.via) ?? 0) + 1);
  return [...counts].map(([via, n]) => `${via} ×${n}`).join(', ');
}
