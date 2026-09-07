/**
 * The missed-run decision, driven directly (`schedule-missed.ts`). Every
 * instant is a literal and the clock is a number the test moves: the whole
 * point of the module is that the loop holds no policy of its own, so the
 * four outcomes have to be reachable here without a scheduler in the room.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { describe, expect, it } from 'vitest';
import { MISSED_GRACE_MS, isMissed, missedGraceFor, missedRunOutcome } from './schedule-missed.ts';
import { type TaskSchedule, dueOccurrence } from './task-schedule.ts';

/** 2026-03-02T00:00:00Z, a Monday. */
const MON = Date.UTC(2026, 2, 2);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const DAILY_9: TaskSchedule = {
  rule: { kind: 'calendar', times: [{ hour: 9, minute: 0 }] },
  armedAt: MON,
};
const NINE = MON + 9 * HOUR;

describe('when an occurrence counts as missed', () => {
  it('is on time inside the grace, whatever the collapse says about earlier ones', () => {
    expect(isMissed(DAILY_9, { at: NINE, missed: 0 }, NINE + 30_000)).toBe(false);
    expect(isMissed(DAILY_9, { at: NINE, missed: 0 }, NINE + MISSED_GRACE_MS)).toBe(false);
  });

  it('is missed once the fire would land past the grace', () => {
    expect(isMissed(DAILY_9, { at: NINE, missed: 0 }, NINE + MISSED_GRACE_MS + 1)).toBe(true);
  });

  it('is missed when something later has also come due, however prompt the fire', () => {
    expect(isMissed(DAILY_9, { at: NINE + DAY, missed: 1 }, NINE + DAY + 1)).toBe(true);
  });

  it('gives an interval rule at most half its interval, so a short rule cannot be late and on time', () => {
    expect(missedGraceFor({ kind: 'every', everyMs: 2 * MINUTE })).toBe(MINUTE);
    expect(missedGraceFor({ kind: 'every', everyMs: HOUR })).toBe(MISSED_GRACE_MS);
    expect(missedGraceFor({ kind: 'calendar', times: [] })).toBe(MISSED_GRACE_MS);
  });

  it('never calls an after-completion rule missed — it has no slot to miss', () => {
    const rule: TaskSchedule = { rule: { kind: 'after-completion', delayMs: HOUR }, armedAt: MON };
    expect(isMissed(rule, { at: MON + HOUR, missed: 0 }, MON + 3 * DAY)).toBe(false);
  });
});

describe('the outcome the loop acts on', () => {
  it('runs an on-time occurrence as the ordinary fire', () => {
    expect(missedRunOutcome(DAILY_9, { at: NINE, missed: 0 }, NINE + MINUTE)).toEqual({
      kind: 'run',
    });
  });

  it('catches up by default, flagging the run and carrying the collapsed count', () => {
    const due = dueOccurrence(DAILY_9, NINE + 3 * DAY + HOUR);
    expect(due).toEqual({ at: NINE + 3 * DAY, missed: 3 });
    expect(missedRunOutcome(DAILY_9, due ?? { at: 0, missed: 0 }, NINE + 3 * DAY + HOUR)).toEqual({
      kind: 'catch-up',
      missed: 3,
    });
  });

  it('skips when the rule says so, counting the occurrence itself among the missed', () => {
    const skip: TaskSchedule = { ...DAILY_9, onMissed: 'skip' };
    expect(
      missedRunOutcome(skip, { at: NINE + 3 * DAY, missed: 3 }, NINE + 3 * DAY + HOUR),
    ).toEqual({ kind: 'skip', missed: 4 });
  });

  it('still runs an on-time occurrence under the skip policy — skip is about missed work only', () => {
    const skip: TaskSchedule = { ...DAILY_9, onMissed: 'skip' };
    expect(missedRunOutcome(skip, { at: NINE, missed: 0 }, NINE + MINUTE)).toEqual({ kind: 'run' });
  });

  it('folds into an open catch-up row whatever the clock says — the lock', () => {
    const cursor = { openCatchUpInstanceId: 't-catchup' };
    expect(missedRunOutcome(DAILY_9, { at: NINE, missed: 0 }, NINE + MINUTE, cursor)).toEqual({
      kind: 'fold',
      into: 't-catchup',
      missed: 1,
    });
    // …and under the skip policy too: the open row is the answer, not a skip.
    const skip: TaskSchedule = { ...DAILY_9, onMissed: 'skip' };
    expect(missedRunOutcome(skip, { at: NINE, missed: 2 }, NINE + DAY, cursor)).toEqual({
      kind: 'fold',
      into: 't-catchup',
      missed: 3,
    });
  });

  it('does not fold a one-off or an after-completion rule — neither stacks', () => {
    const cursor = { openCatchUpInstanceId: 't-catchup' };
    const once: TaskSchedule = { rule: { kind: 'once', at: NINE }, armedAt: MON };
    expect(missedRunOutcome(once, { at: NINE, missed: 0 }, NINE + MINUTE, cursor)).toEqual({
      kind: 'run',
    });
    const after: TaskSchedule = { rule: { kind: 'after-completion', delayMs: HOUR }, armedAt: MON };
    expect(missedRunOutcome(after, { at: MON + HOUR, missed: 0 }, MON + DAY, cursor)).toEqual({
      kind: 'run',
    });
  });

  it('treats a late one-off like any missed occurrence: caught up, or skipped', () => {
    const once: TaskSchedule = { rule: { kind: 'once', at: NINE }, armedAt: MON };
    expect(missedRunOutcome(once, { at: NINE, missed: 0 }, NINE + DAY)).toEqual({
      kind: 'catch-up',
      missed: 0,
    });
    expect(
      missedRunOutcome({ ...once, onMissed: 'skip' }, { at: NINE, missed: 0 }, NINE + DAY),
    ).toEqual({ kind: 'skip', missed: 1 });
  });
});
