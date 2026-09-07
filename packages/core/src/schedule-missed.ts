/**
 * What to do about an occurrence the server was not running for — the
 * MISSED-RUN POLICY (docs/architecture/scheduled-tasks.md, "Missed runs").
 *
 * `dueOccurrence` in `task-schedule.ts` already collapses an outage into one
 * occurrence carrying a count. This module makes the per-rule choice about
 * that occurrence, as a pure function of the rule, the collapse and the
 * clock, so the loop in the server holds no policy of its own and a test can
 * put every branch on the table without a timer.
 *
 * ── Four outcomes ───────────────────────────────────────────────────────
 *
 *  - **run** — the occurrence is on time. The ordinary fire; nothing about
 *    the policy is visible.
 *  - **catch-up** — it is late, and the rule wants a run once it recovers.
 *    ONE instance is filed and it is FLAGGED as a catch-up, standing in for
 *    the occurrences collapsed behind it. What the peers asked for as "run
 *    once on recovery, flagged", and the default.
 *  - **skip** — it is late, and the rule wants the missed work left alone.
 *    Nothing is filed; the cursor still advances so the occurrence can never
 *    come due again, and the skip is recorded where a reader can see it.
 *  - **fold** — a catch-up row from an earlier recovery is STILL OPEN. The
 *    new occurrence, on time or not, folds into that row rather than filing
 *    beside it. This is the "board-held lock": the open catch-up instance is
 *    the lock, held in the row's own status on the board, so a catch-up run
 *    and a live run of the same rule can never both be filed. A fixed-cadence
 *    rule stacks by design when its runs are ORDINARY — an open Monday row
 *    does not stop Tuesday's — but a catch-up row is already "the one row
 *    standing in for the missed ones", and a second row beside it would be the
 *    flood the policy exists to prevent.
 *
 * ── When is an occurrence "missed"? ─────────────────────────────────────
 *
 * When something came due after it (the collapse has a count), or when the
 * fire would land more than a grace past its instant. The grace is five
 * minutes — ten ticks of the loop, so a slow pass never reads as an outage —
 * and for an interval rule never more than half its interval, so a two-minute
 * rule cannot be four minutes late and still call itself on time.
 *
 * An after-completion rule is never missed. Its next run is owed a delay
 * after a COMPLETION, not at a slot on a clock, so there is no slot to have
 * missed: a late fire is simply the run, and an open instance already holds
 * the rule on its own (`nextOccurrence` returns nothing for it).
 */

import type { DueOccurrence, ScheduleCursor, ScheduleRule, TaskSchedule } from './task-schedule.ts';

/**
 * The choice itself, as stored on `TaskSchedule.onMissed`. `catch-up` files
 * ONE flagged instance for the latest missed occurrence; `skip` files nothing
 * and records the skip. Absent reads as `catch-up` — the peers who asked for
 * the choice all named it as the default.
 */
export type MissedRunPolicy = 'catch-up' | 'skip';
export const MISSED_RUN_POLICIES = ['catch-up', 'skip'] as const;
export const DEFAULT_MISSED_RUN_POLICY: MissedRunPolicy = 'catch-up';

/** How late an occurrence may fire and still count as on time. */
export const MISSED_GRACE_MS = 5 * 60_000;

/** The grace this rule gets: `MISSED_GRACE_MS`, capped at half an interval. */
export function missedGraceFor(rule: ScheduleRule): number {
  if (rule.kind === 'every') return Math.min(MISSED_GRACE_MS, rule.everyMs / 2);
  return MISSED_GRACE_MS;
}

export type MissedRunOutcome =
  /** On time: the ordinary fire. */
  | { kind: 'run' }
  /** Late, and the rule catches up: one flagged instance, standing in for
   *  `missed` earlier occurrences (the collapse's count). */
  | { kind: 'catch-up'; missed: number }
  /** Late, and the rule skips: nothing filed. `missed` counts the occurrence
   *  itself and everything collapsed behind it. */
  | { kind: 'skip'; missed: number }
  /** An earlier catch-up row is still open and holds the lock: this occurrence
   *  and everything collapsed behind it (`missed`) fold into it. */
  | { kind: 'fold'; into: string; missed: number };

/** Whether this occurrence, fired at `now`, would be a missed one. */
export function isMissed(schedule: TaskSchedule, due: DueOccurrence, now: number): boolean {
  if (schedule.rule.kind === 'after-completion') return false;
  return due.missed > 0 || now - due.at > missedGraceFor(schedule.rule);
}

/**
 * The decision, for the loop to act on. Pure: the same rule, collapse, clock
 * and cursor always give the same answer.
 */
export function missedRunOutcome(
  schedule: TaskSchedule,
  due: DueOccurrence,
  now: number,
  cursor: ScheduleCursor = {},
): MissedRunOutcome {
  const rule = schedule.rule;
  // The lock is checked first and whatever the clock says: an on-time
  // occurrence beside an open catch-up row is exactly the double run the
  // lock exists to stop.
  if (
    cursor.openCatchUpInstanceId !== undefined &&
    (rule.kind === 'every' || rule.kind === 'calendar')
  ) {
    return { kind: 'fold', into: cursor.openCatchUpInstanceId, missed: due.missed + 1 };
  }
  if (!isMissed(schedule, due, now)) return { kind: 'run' };
  const policy = schedule.onMissed ?? DEFAULT_MISSED_RUN_POLICY;
  if (policy === 'skip') return { kind: 'skip', missed: due.missed + 1 };
  return { kind: 'catch-up', missed: due.missed };
}
