/**
 * The run record, driven directly (`schedule-run-record.ts`). A rule, its
 * last instance and a clock go in; what the row says and whether it is stale
 * come out. Every instant is a literal. Fixtures are synthetic; the repo is
 * public.
 */
import { describe, expect, it } from 'vitest';
import {
  STALE_SLACK_MAX_MS,
  ageWord,
  formatRunRecord,
  runRecord,
  scheduleIntervalMs,
  staleSlackMs,
} from './schedule-run-record.ts';
import { type TaskSchedule, instantForLocal } from './task-schedule.ts';

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

describe('the interval a rule runs on', () => {
  it('is closed form for an interval and an after-completion rule', () => {
    expect(scheduleIntervalMs({ rule: { kind: 'every', everyMs: 2 * HOUR }, armedAt: MON })).toBe(
      2 * HOUR,
    );
    expect(
      scheduleIntervalMs({ rule: { kind: 'after-completion', delayMs: 3 * DAY }, armedAt: MON }),
    ).toBe(3 * DAY);
  });

  it('is nothing for a calendar rule, which has no one gap to name', () => {
    expect(scheduleIntervalMs(DAILY_9)).toBeUndefined();
    const weekdays: TaskSchedule = {
      rule: { kind: 'calendar', times: [{ hour: 9, minute: 0 }], weekdays: [1, 2, 3, 4, 5] },
      armedAt: MON + 4 * DAY + 10 * HOUR, // a Friday, after 9am
    };
    expect(scheduleIntervalMs(weekdays)).toBeUndefined();
    // And the record carries none, so nothing downstream can print one.
    expect(runRecord(DAILY_9, undefined, NINE).intervalMs).toBeUndefined();
  });

  it('is nothing for a one-off, which can never be stale', () => {
    expect(scheduleIntervalMs({ rule: { kind: 'once', at: NINE }, armedAt: MON })).toBeUndefined();
    expect(
      runRecord({ rule: { kind: 'once', at: NINE }, armedAt: MON }, undefined, MON + 30 * DAY)
        .stale,
    ).toBe(false);
  });

  it('slacks a due run by the smaller of its gap and an hour', () => {
    expect(staleSlackMs(DAY)).toBe(STALE_SLACK_MAX_MS);
    expect(staleSlackMs(10 * MINUTE)).toBe(10 * MINUTE);
  });
});

describe('what the record says', () => {
  it('says a rule that has never fired never ran, aged from its arming', () => {
    const r = runRecord(DAILY_9, undefined, MON + 3 * HOUR);
    expect(r.status).toBe('never');
    expect(r.stateAt).toBe(MON);
    expect(r.ageMs).toBe(3 * HOUR);
    expect(formatRunRecord(r)).toBe('Never ran');
  });

  it('reads an open instance as running since the fire', () => {
    const fired = { ...DAILY_9, state: { lastFiredAt: NINE, lastInstanceId: 't-run' } };
    const r = runRecord(fired, { id: 't-run', status: 'open' }, NINE + 3 * HOUR);
    expect(r).toMatchObject({
      status: 'open',
      instanceId: 't-run',
      startedAt: NINE,
      stateAt: NINE,
    });
    expect(formatRunRecord(r)).toBe('Running 3h');
  });

  it('reads a closed instance as done at its close, and that close as the success', () => {
    const fired = { ...DAILY_9, state: { lastFiredAt: NINE, lastInstanceId: 't-run' } };
    const r = runRecord(
      fired,
      { id: 't-run', status: 'done', closedAt: NINE + HOUR },
      NINE + 3 * HOUR,
    );
    expect(r).toMatchObject({ status: 'done', stateAt: NINE + HOUR, lastSuccessAt: NINE + HOUR });
    expect(formatRunRecord(r)).toBe('Done 2h ago');
  });

  it('keeps a success the rule recorded when the instance has since been reopened', () => {
    const fired = {
      ...DAILY_9,
      state: { lastFiredAt: NINE, lastInstanceId: 't-run', lastSuccessAt: NINE + HOUR },
    };
    const r = runRecord(fired, { id: 't-run', status: 'open' }, NINE + 3 * HOUR);
    expect(r.status).toBe('open');
    expect(r.lastSuccessAt).toBe(NINE + HOUR);
  });

  it('still says when a run happened after the instance is gone from the board', () => {
    const fired = { ...DAILY_9, state: { lastFiredAt: NINE, lastInstanceId: 't-run' } };
    const r = runRecord(fired, { id: 't-run', status: 'gone' }, NINE + 2 * DAY);
    expect(formatRunRecord(r)).toBe('Ran 2d ago');
    expect(
      formatRunRecord(
        runRecord(
          fired,
          { id: 't-run', status: 'archived', closedAt: NINE + HOUR },
          NINE + 2 * HOUR,
        ),
      ),
    ).toBe('Archived 1h ago');
  });

  it('says an open instance is waiting, or unanswered, while its wake is owed', () => {
    const fired = { ...DAILY_9, state: { lastFiredAt: NINE, lastInstanceId: 't-run' } };
    const open = { id: 't-run', status: 'open' as const };
    const attempts = [{ at: NINE, via: 'nobody' as const }];
    const waiting = {
      ...fired,
      state: { ...fired.state, wake: { instanceId: 't-run', attempts } },
    };
    expect(formatRunRecord(runRecord(waiting, open, NINE + 5 * MINUTE))).toBe('Waiting 5m');
    const gaveUp = {
      ...fired,
      state: { ...fired.state, wake: { instanceId: 't-run', attempts, exhaustedItemId: 'r-1' } },
    };
    expect(formatRunRecord(runRecord(gaveUp, open, NINE + 2 * HOUR))).toBe('Unanswered 2h');
    // Answered reads as running; a wake for an OLDER instance says nothing.
    const answered = {
      ...fired,
      state: { ...fired.state, wake: { instanceId: 't-run', attempts, answeredAt: NINE + MINUTE } },
    };
    expect(formatRunRecord(runRecord(answered, open, NINE + 2 * HOUR))).toBe('Running 2h');
    const older = {
      ...fired,
      state: { ...fired.state, wake: { instanceId: 't-old', attempts, exhaustedItemId: 'r-1' } },
    };
    expect(runRecord(older, open, NINE + 2 * HOUR).wake).toBeUndefined();
  });

  it('writes an age the way a row has room for', () => {
    expect(ageWord(20_000)).toBe('just now');
    expect(ageWord(4 * MINUTE)).toBe('4m');
    expect(ageWord(90 * MINUTE)).toBe('2h');
    expect(ageWord(3 * DAY)).toBe('3d');
    const fresh = { ...DAILY_9, state: { lastFiredAt: NINE, lastInstanceId: 't-run' } };
    expect(formatRunRecord(runRecord(fresh, { id: 't-run', status: 'open' }, NINE + 5_000))).toBe(
      'Running',
    );
  });
});

describe('when a rule is stale', () => {
  /** Closed on the hour it was owed, so "one day later" is unambiguous. */
  const closed = { id: 't-run', status: 'done' as const, closedAt: NINE };
  const fired = { ...DAILY_9, state: { lastFiredAt: NINE, lastInstanceId: 't-run' } };
  const open = { id: 't-run', status: 'open' as const };

  it('gives a daily rule the hour after its next run was due', () => {
    expect(runRecord(fired, closed, NINE + DAY).dueAt).toBe(NINE + DAY);
    expect(runRecord(fired, closed, NINE + DAY).stale).toBe(false);
    expect(runRecord(fired, closed, NINE + DAY + HOUR).stale).toBe(false);
    expect(runRecord(fired, closed, NINE + DAY + HOUR + 1).stale).toBe(true);
    expect(runRecord(fired, closed, NINE + DAY + 90 * MINUTE).stale).toBe(true);
  });

  it('counts a rule that has never succeeded from its arming', () => {
    // Armed at midnight, so nine o'clock is the first run it was ever owed.
    expect(runRecord(DAILY_9, undefined, NINE + HOUR).stale).toBe(false);
    expect(runRecord(DAILY_9, undefined, NINE + HOUR + 1).stale).toBe(true);
  });

  it('never counts from before the arming, so re-arming cannot make a rule stale', () => {
    // `set_task_schedule` stamps a new `armedAt` and KEEPS the state when the
    // rule itself is unchanged, so an envelope edit leaves a success older
    // than the arming. Unfloored, this rule is owed 09:00 — an instant it
    // never fires — and reads stale an hour later instead of seven.
    const rearmed: TaskSchedule = {
      rule: { kind: 'every', everyMs: 6 * HOUR },
      armedAt: NINE,
      state: { lastFiredAt: NINE - 5 * HOUR, lastSuccessAt: NINE - 5 * HOUR },
    };
    expect(runRecord(rearmed, undefined, NINE + HOUR).dueAt).toBe(NINE + 6 * HOUR);
    expect(runRecord(rearmed, undefined, NINE + 7 * HOUR).stale).toBe(false);
    expect(runRecord(rearmed, undefined, NINE + 7 * HOUR + 1).stale).toBe(true);
  });

  it('gives a run in flight the whole gap, so a long job is not stale every cycle', () => {
    // Armed an hour before the fire, so the arming is not what makes it late.
    // The 09:00 occurrence was filed and its instance is still running; a
    // three-hour job would otherwise read stale from 10:01 to noon daily.
    const running = {
      ...DAILY_9,
      armedAt: NINE - HOUR,
      state: { lastOccurrenceAt: NINE, lastFiredAt: NINE, lastInstanceId: 't-run' },
    };
    expect(runRecord(running, open, NINE + 90 * MINUTE).dueAt).toBe(NINE);
    expect(runRecord(running, open, NINE + 90 * MINUTE).stale).toBe(false);
    expect(runRecord(running, open, NINE + 3 * HOUR).stale).toBe(false);
    // Stale only once tomorrow's nine o'clock is owed.
    expect(runRecord(running, open, NINE + DAY).stale).toBe(false);
    expect(runRecord(running, open, NINE + DAY + 1).stale).toBe(true);
  });

  it('does not let an instance from an older occurrence shield the rule', () => {
    // Yesterday's run succeeded and its instance was reopened; today's was
    // never filed, so nothing is in flight and the capped slack applies.
    const reopened = {
      ...DAILY_9,
      state: {
        lastOccurrenceAt: NINE,
        lastFiredAt: NINE,
        lastInstanceId: 't-run',
        lastSuccessAt: NINE,
      },
    };
    expect(runRecord(reopened, open, NINE + DAY).dueAt).toBe(NINE + DAY);
    expect(runRecord(reopened, open, NINE + DAY + HOUR).stale).toBe(false);
    expect(runRecord(reopened, open, NINE + DAY + HOUR + 1).stale).toBe(true);
  });

  it('gives a ten-minute rule ten minutes of slack, not an hour', () => {
    // A preservation case: this reads the same on the commit before the fix.
    const rule: TaskSchedule = { rule: { kind: 'every', everyMs: 10 * MINUTE }, armedAt: MON };
    expect(runRecord(rule, undefined, MON + 20 * MINUTE).stale).toBe(false);
    expect(runRecord(rule, undefined, MON + 20 * MINUTE + 1).stale).toBe(true);
  });

  it('leaves an after-completion rule on its delay plus the same slack', () => {
    // A preservation case: this reads the same on the commit before the fix.
    const rule: TaskSchedule = {
      rule: { kind: 'after-completion', delayMs: 3 * DAY },
      armedAt: MON,
    };
    expect(runRecord(rule, undefined, MON + 3 * DAY + HOUR).stale).toBe(false);
    expect(runRecord(rule, undefined, MON + 3 * DAY + HOUR + 1).stale).toBe(true);
  });

  it('still catches the after-completion instance nobody closes, one delay later', () => {
    const rule: TaskSchedule = {
      rule: { kind: 'after-completion', delayMs: 3 * DAY },
      armedAt: MON,
      state: {
        lastOccurrenceAt: MON + 3 * DAY,
        lastFiredAt: MON + 3 * DAY,
        lastInstanceId: 't-run',
      },
    };
    expect(runRecord(rule, open, MON + 5 * DAY).stale).toBe(false);
    expect(runRecord(rule, open, MON + 6 * DAY).stale).toBe(false);
    expect(runRecord(rule, open, MON + 6 * DAY + 1).stale).toBe(true);
  });

  it('is never stale past its end limit — that rule is finished, not stuck', () => {
    const ended = { ...fired, until: NINE + 2 * DAY };
    expect(runRecord(ended, closed, NINE + 10 * DAY).stale).toBe(false);
    // The control: the same rule with the end further out IS stale then.
    expect(runRecord({ ...fired, until: NINE + 30 * DAY }, closed, NINE + 10 * DAY).stale).toBe(
      true,
    );
  });

  it('is not stale on the last run its end limit admits', () => {
    // `until` falls between the due occurrence and the one after it, so there
    // is no next gap to wait through — the rule is winding down.
    const winding = { ...fired, until: NINE + DAY + 12 * HOUR };
    expect(runRecord(winding, closed, NINE + DAY + 11 * HOUR).dueAt).toBe(NINE + DAY);
    expect(runRecord(winding, closed, NINE + DAY + 11 * HOUR).stale).toBe(false);
  });

  it('is never stale on a rule whose cadence is not a positive number', () => {
    const noInterval: TaskSchedule = { rule: { kind: 'every', everyMs: 0 }, armedAt: MON };
    const noDelay: TaskSchedule = {
      rule: { kind: 'after-completion', delayMs: -1 },
      armedAt: MON,
    };
    expect(runRecord(noInterval, undefined, MON + 30 * DAY).stale).toBe(false);
    expect(runRecord(noDelay, undefined, MON + 30 * DAY).stale).toBe(false);
  });

  it('is never stale on a calendar rule that admits no occurrence', () => {
    const noTimes: TaskSchedule = { rule: { kind: 'calendar', times: [] }, armedAt: MON };
    const noDays: TaskSchedule = {
      rule: { kind: 'calendar', times: [{ hour: 9, minute: 0 }], weekdays: [] },
      armedAt: MON,
    };
    expect(runRecord(noTimes, undefined, MON + 30 * DAY).stale).toBe(false);
    expect(runRecord(noDays, undefined, MON + 30 * DAY).stale).toBe(false);
  });
});

/**
 * The reading that sent a stale item out on 22 September: a rule running at
 * 00, 06, 09, 12, 15, 18 and 21 Pacific with its midnight run long since
 * done. The old arithmetic took the 06-to-09 gap as the rule's interval, so
 * three hours plus an hour of slack made a 00:05 success late before 06:00
 * was ever due.
 */
describe('a calendar rule whose gaps are uneven', () => {
  const LA = 'America/Los_Angeles';
  /** A wall-clock reading on 2026-09-22, Pacific. */
  const la = (hour: number, minute = 0): number => instantForLocal(LA, 2026, 9, 22, hour, minute);
  const SUCCESS = la(0, 5);
  const ran = { id: 't-run', status: 'done' as const, closedAt: SUCCESS };
  const sevenADay: TaskSchedule = {
    rule: {
      kind: 'calendar',
      times: [0, 6, 9, 12, 15, 18, 21].map((hour) => ({ hour, minute: 0 })),
    },
    timezone: LA,
    armedAt: instantForLocal(LA, 2026, 9, 1, 12, 0),
    state: { lastOccurrenceAt: la(0, 0), lastFiredAt: la(0, 0), lastSuccessAt: SUCCESS },
  };

  it('is not stale at 05:30, because 06:00 has not come due', () => {
    // 05:30 is the reading that discriminates: five hours and twenty-five
    // minutes after the success, past the four hours the old arithmetic
    // allowed, and still before the run it is waiting for.
    const r = runRecord(sevenADay, ran, la(5, 30));
    expect(r.dueAt).toBe(la(6, 0));
    expect(r.stale).toBe(false);
  });

  it('is stale once an hour has passed with the 06:00 run unanswered', () => {
    expect(runRecord(sevenADay, ran, la(7, 0)).stale).toBe(false);
    expect(runRecord(sevenADay, ran, la(7, 30)).stale).toBe(true);
  });

  it('still calls an even three-hourly rule stale at 05:30 — the control', () => {
    const every3h: TaskSchedule = {
      rule: { kind: 'every', everyMs: 3 * HOUR },
      timezone: LA,
      armedAt: la(0, 0),
      state: { lastOccurrenceAt: la(0, 0), lastFiredAt: la(0, 0), lastSuccessAt: SUCCESS },
    };
    const r = runRecord(every3h, ran, la(5, 30));
    expect(r.dueAt).toBe(la(3, 0));
    expect(r.stale).toBe(true);
  });
});

/**
 * A daily rule across both US transitions. The gap the slack is drawn from is
 * 23 hours in March and 25 in November, and the slack is an hour either way,
 * so the rule is owed its run at nine local and stale at ten local on both
 * days rather than an hour out.
 */
describe('a daily rule across a daylight-saving transition', () => {
  const LA = 'America/Los_Angeles';
  const nine = (month: number, day: number): number => instantForLocal(LA, 2026, month, day, 9, 0);
  const dailyNine = (success: number): TaskSchedule => ({
    rule: { kind: 'calendar', times: [{ hour: 9, minute: 0 }] },
    timezone: LA,
    armedAt: instantForLocal(LA, 2026, 3, 1, 0, 0),
    state: { lastOccurrenceAt: success, lastFiredAt: success, lastSuccessAt: success },
  });

  it('spring forward: 2026-03-08 is 23 hours on, and the hour still holds', () => {
    const rule = dailyNine(nine(3, 7));
    const due = nine(3, 8);
    expect(runRecord(rule, undefined, due).dueAt).toBe(due);
    expect(due - nine(3, 7)).toBe(23 * HOUR);
    expect(runRecord(rule, undefined, due + HOUR).stale).toBe(false);
    expect(runRecord(rule, undefined, due + HOUR + 1).stale).toBe(true);
  });

  it('fall back: 2026-11-01 is 25 hours on, and the hour still holds', () => {
    const rule = { ...dailyNine(nine(11, 1)), armedAt: instantForLocal(LA, 2026, 10, 1, 0, 0) };
    const due = nine(11, 2);
    expect(runRecord(rule, undefined, due).dueAt).toBe(due);
    expect(nine(11, 1) - nine(10, 31)).toBe(25 * HOUR);
    expect(runRecord(rule, undefined, due + HOUR).stale).toBe(false);
    expect(runRecord(rule, undefined, due + HOUR + 1).stale).toBe(true);
  });
});
