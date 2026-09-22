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

  it('is the gap between the next two occurrences of a calendar rule', () => {
    expect(scheduleIntervalMs(DAILY_9)).toBe(DAY);
    const weekdays: TaskSchedule = {
      rule: { kind: 'calendar', times: [{ hour: 9, minute: 0 }], weekdays: [1, 2, 3, 4, 5] },
      armedAt: MON + 4 * DAY + 10 * HOUR, // a Friday, after 9am
    };
    // Monday's 9am is next, then Tuesday's: one day, not the weekend.
    expect(scheduleIntervalMs(weekdays)).toBe(DAY);
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

  it('calls an open run stale a slack after the occurrence nobody closed', () => {
    const open = { id: 't-run', status: 'open' as const };
    // Armed an hour before the fire, so the arming is not what makes it late.
    const rule = { ...fired, armedAt: NINE - HOUR };
    expect(runRecord(rule, open, NINE + 30 * MINUTE).stale).toBe(false);
    expect(runRecord(rule, open, NINE + 2 * HOUR).stale).toBe(true);
  });

  it('gives a ten-minute rule ten minutes of slack, not an hour', () => {
    const rule: TaskSchedule = { rule: { kind: 'every', everyMs: 10 * MINUTE }, armedAt: MON };
    expect(runRecord(rule, undefined, MON + 20 * MINUTE).stale).toBe(false);
    expect(runRecord(rule, undefined, MON + 20 * MINUTE + 1).stale).toBe(true);
  });

  it('leaves an after-completion rule on its delay plus the same slack', () => {
    const rule: TaskSchedule = {
      rule: { kind: 'after-completion', delayMs: 3 * DAY },
      armedAt: MON,
    };
    expect(runRecord(rule, undefined, MON + 3 * DAY + HOUR).stale).toBe(false);
    expect(runRecord(rule, undefined, MON + 3 * DAY + HOUR + 1).stale).toBe(true);
  });

  it('is never stale past its end limit — that rule is finished, not stuck', () => {
    const ended = { ...fired, until: NINE + 2 * DAY };
    expect(runRecord(ended, closed, NINE + 10 * DAY).stale).toBe(false);
    // The control: the same rule with the end further out IS stale then.
    expect(runRecord({ ...fired, until: NINE + 30 * DAY }, closed, NINE + 10 * DAY).stale).toBe(
      true,
    );
  });
});

/**
 * The reading that sent a stale item out on 22 September: a rule running at
 * 00, 06, 09, 12, 15, 18 and 21 Pacific, read at 04:01 with its midnight run
 * long since done. The old arithmetic took the 06-to-09 gap as the rule's
 * interval, so three hours plus an hour of slack made a 00:05 success late
 * two hours before 06:00 was even due.
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
    state: { lastFiredAt: la(0, 0), lastInstanceId: 't-run', lastSuccessAt: SUCCESS },
  };

  it('is not stale at 04:01, because 06:00 has not come due', () => {
    const r = runRecord(sevenADay, ran, la(4, 1));
    expect(r.dueAt).toBe(la(6, 0));
    expect(r.stale).toBe(false);
  });

  it('is stale once an hour has passed with the 06:00 run unanswered', () => {
    expect(runRecord(sevenADay, ran, la(7, 0)).stale).toBe(false);
    expect(runRecord(sevenADay, ran, la(7, 30)).stale).toBe(true);
  });

  it('still calls an even three-hourly rule stale at 04:01 — the control', () => {
    const every3h: TaskSchedule = {
      rule: { kind: 'every', everyMs: 3 * HOUR },
      timezone: LA,
      armedAt: la(0, 0),
      state: { lastFiredAt: la(0, 0), lastInstanceId: 't-run', lastSuccessAt: SUCCESS },
    };
    const r = runRecord(every3h, ran, la(4, 1));
    expect(r.dueAt).toBe(la(3, 0));
    expect(r.stale).toBe(true);
  });
});
