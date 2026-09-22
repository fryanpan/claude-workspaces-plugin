/**
 * The RUN RECORD of a scheduled row — what the row says about its last run,
 * and when that reading has gone stale (docs/architecture/scheduled-tasks.md,
 * "The run record").
 *
 * Every peer interviewed for the scheduler had a job fail silently for
 * weeks, and every one of them asked for the same thing: prove the run
 * HAPPENED, not that it was scheduled. A schedule that is not firing looks
 * exactly like one that is, unless the row carries three facts — the last
 * run, how it ended, and how old that state is. This module derives those
 * three from what the board already stores, and from them the one verdict
 * that changes what a reader does: STALE, the rule's last success is older
 * than its own cadence allows.
 *
 * Pure. The server and the board both call it with what they can see —
 * the rule's `schedule`, its last instance, and a clock — so a row on screen
 * and the item the server files can never disagree about whether a rule
 * has stopped.
 *
 * ── When is a rule stale? ────────────────────────────────────────────────
 *
 * When an OCCURRENCE has come due since the rule's last success — the last
 * instance that closed `done`, or the arming if none ever has — and a slack
 * has passed with no success. The due occurrence is `staleDueAt`: the next
 * one the rule is owed, measured from that success.
 *
 * The slack is the smaller of one hour and THE GAP THAT CONTAINS THE WAIT —
 * from the due occurrence to the one after it, because that is how long the
 * due run has before the next one is owed. A daily rule that succeeded at
 * nine is owed again at nine tomorrow and reads stale at ten, twenty-five
 * hours on; a ten-minute rule gets ten minutes. Without a slack a job that
 * takes ten minutes would read stale every morning, which trains the reader
 * to ignore the word.
 *
 * Measuring from the due occurrence rather than from the interval is what
 * makes an UNEVEN rule readable. The interval used to be the gap between the
 * next two occurrences from now, so a rule firing at 00, 06, 09, 12, 15, 18
 * and 21 Pacific, read at 04:01, was handed the 06-to-09 gap: three hours
 * plus an hour made its 00:05 success read stale two hours before 06:00 was
 * even due. That filed a stale review item against a healthy rule on
 * 22 September 2026.
 *
 * A one-off and an on-change rule are owed nothing on a cadence and are never
 * stale; a rule past its end limit is finished, not stale. An after-completion
 * rule is owed its delay after the last success, so one whose instance nobody
 * closes goes stale like any other — that is the failure the peers described,
 * a run that started and never finished.
 */

import { type WakeStatus, wakeStatus } from './schedule-wake.ts';
import { type ScheduleCursor, type TaskSchedule, nextOccurrence } from './task-schedule.ts';

/** How the last run ended, as the row reads it. */
export type RunStatus =
  /** No occurrence has fired yet. */
  | 'never'
  /** The instance is still open — the run is in progress, or nobody picked it up. */
  | 'open'
  | 'done'
  /** Archived without being closed: retired, not finished. */
  | 'archived'
  /** The instance is not on the board any more; only the fire is known. */
  | 'gone';

/** What the caller knows about the rule's last instance. */
export interface LastInstance {
  id: string;
  status: RunStatus;
  /** When it closed, for `done` and `archived`. */
  closedAt?: number;
}

export interface RunRecord {
  status: RunStatus;
  instanceId?: string;
  /** When the last run was FIRED — the server's clock, not the occurrence's
   *  instant, because a catch-up fires long after the slot it stands for. */
  startedAt?: number;
  /** When the state the row is in was reached: the close, else the fire,
   *  else the arming. */
  stateAt: number;
  /** How old that state is at the caller's `now`. */
  ageMs: number;
  /** The newest success the rule has had, if any. */
  lastSuccessAt?: number;
  /** The gap between the next two occurrences; absent for a one-off. */
  intervalMs?: number;
  /** The occurrence the next success is owed at, measured from the last
   *  success (or from the arming). Absent when the rule is owed nothing
   *  more — a spent one-off, an on-change rule, a rule past its end. */
  dueAt?: number;
  /** An occurrence came due since the last success and its slack has passed
   *  with no success. */
  stale: boolean;
  /** Whether the last instance's wake was answered (`schedule-wake.ts`).
   *  Absent when no wake was ever attempted for it. */
  wake?: WakeStatus;
}

export const STALE_SLACK_MAX_MS = 60 * 60_000;

/** How long a run that has come due has to succeed before its rule reads
 *  stale: its own gap, capped at an hour. */
export function staleSlackMs(gapMs: number): number {
  return Math.min(gapMs, STALE_SLACK_MAX_MS);
}

/**
 * The occurrence the rule's next success is owed at, measured from its last
 * success — or from the arming when it has never had one.
 *
 * `nextOccurrence` answers it for every kind but one. An after-completion
 * rule asked through it needs a completion cursor, and answers "owed
 * nothing" for exactly the instance nobody closed, which is the failure this
 * record exists to catch; its delay from the last success says it instead.
 */
export function staleDueAt(
  schedule: TaskSchedule,
  lastSuccessAt: number | undefined,
): number | undefined {
  const rule = schedule.rule;
  // A one-off is spent; an on-change rule has no cadence to be late against.
  if (rule.kind === 'once' || rule.kind === 'on-change') return undefined;
  const since = lastSuccessAt ?? schedule.armedAt;
  if (rule.kind === 'after-completion') {
    if (!(rule.delayMs > 0)) return undefined;
    const at = since + rule.delayMs;
    return schedule.until !== undefined && at >= schedule.until ? undefined : at;
  }
  return nextOccurrence({ ...schedule, state: { ...schedule.state, lastOccurrenceAt: since } });
}

/** The gap that CONTAINS the wait being judged — from the due occurrence to
 *  the one after it. `until` is stripped so the last run a rule is ever owed
 *  still gets a slack rather than none. */
function gapAfter(schedule: TaskSchedule, dueAt: number): number | undefined {
  const rule = schedule.rule;
  if (rule.kind === 'every') return rule.everyMs;
  if (rule.kind === 'after-completion') return rule.delayMs;
  const then = nextOccurrence({
    ...schedule,
    until: undefined,
    state: { ...schedule.state, lastOccurrenceAt: dueAt },
  });
  return then === undefined ? undefined : then - dueAt;
}

/**
 * The gap between one occurrence and the next. Closed form for the two kinds
 * that carry it; a calendar rule is asked for its next two occurrences and
 * the gap between them — a weekday rule read on a Friday says three days,
 * which is the honest answer for the weekend it is about to sit through.
 */
export function scheduleIntervalMs(
  schedule: TaskSchedule,
  cursor: ScheduleCursor = {},
): number | undefined {
  const rule = schedule.rule;
  if (rule.kind === 'every') return rule.everyMs;
  if (rule.kind === 'after-completion') return rule.delayMs;
  // A one-off has no next; an on-change rule has no cadence to be late against.
  if (rule.kind === 'once' || rule.kind === 'on-change') return undefined;
  const first = nextOccurrence({ ...schedule, until: undefined }, cursor);
  if (first === undefined) return undefined;
  const second = nextOccurrence(
    { ...schedule, until: undefined, state: { ...schedule.state, lastOccurrenceAt: first } },
    cursor,
  );
  return second === undefined ? undefined : second - first;
}

/** The record, from the rule, its last instance and the clock. */
export function runRecord(
  schedule: TaskSchedule,
  last: LastInstance | undefined,
  now: number,
): RunRecord {
  const state = schedule.state ?? {};
  const startedAt = state.lastFiredAt;
  const status: RunStatus = startedAt === undefined ? 'never' : (last?.status ?? 'gone');
  const closedAt = last?.closedAt;
  // A success recorded by the server outranks nothing the instance says: the
  // instance may have been reopened, and the rule still succeeded once.
  const successes = [state.lastSuccessAt, status === 'done' ? closedAt : undefined].filter(
    (t): t is number => t !== undefined,
  );
  const lastSuccessAt = successes.length > 0 ? Math.max(...successes) : undefined;
  const stateAt =
    (status === 'done' || status === 'archived' ? closedAt : undefined) ??
    startedAt ??
    schedule.armedAt;
  const intervalMs = scheduleIntervalMs(schedule);
  const wake =
    state.wake !== undefined && last !== undefined && state.wake.instanceId === last.id
      ? wakeStatus(state.wake)
      : undefined;
  const ended = schedule.until !== undefined && schedule.until <= now;
  const dueAt = staleDueAt(schedule, lastSuccessAt);
  const stale =
    dueAt !== undefined &&
    !ended &&
    now > dueAt + staleSlackMs(gapAfter(schedule, dueAt) ?? STALE_SLACK_MAX_MS);
  return {
    status,
    ...(last?.id !== undefined && status !== 'never' ? { instanceId: last.id } : {}),
    ...(startedAt !== undefined ? { startedAt } : {}),
    stateAt,
    ageMs: Math.max(0, now - stateAt),
    ...(lastSuccessAt !== undefined ? { lastSuccessAt } : {}),
    ...(intervalMs !== undefined ? { intervalMs } : {}),
    ...(dueAt !== undefined ? { dueAt } : {}),
    stale,
    ...(wake !== undefined ? { wake } : {}),
  };
}

/** An age as a person reads it on a row: `just now`, `4m`, `2h`, `3d`. */
export function ageWord(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/**
 * The row's own words for the record — one short phrase, state first, age
 * after it, so a column of scheduled rows reads as a column of verdicts:
 * `Done 2h ago`, `Running 3d`, `Never ran` — and `Waiting 5m` / `Unanswered 2h`
 * while the wake of an open instance is still owed or has given up.
 */
export function formatRunRecord(record: RunRecord): string {
  const age = ageWord(record.ageMs);
  const ago = age === 'just now' ? age : `${age} ago`;
  switch (record.status) {
    case 'never':
      return 'Never ran';
    case 'open': {
      // An open instance nobody has taken is not running; say which.
      const word =
        record.wake === 'unanswered'
          ? 'Unanswered'
          : record.wake === 'waiting'
            ? 'Waiting'
            : 'Running';
      return age === 'just now' ? word : `${word} ${age}`;
    }
    case 'done':
      return `Done ${ago}`;
    case 'archived':
      return `Archived ${ago}`;
    case 'gone':
      return `Ran ${ago}`;
  }
}
