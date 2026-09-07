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
  staleAfterMs,
} from './schedule-run-record.ts';
import type { TaskSchedule } from './task-schedule.ts';

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

  it('adds a slack of at most an hour before calling a rule stale', () => {
    expect(staleAfterMs(DAY)).toBe(DAY + STALE_SLACK_MAX_MS);
    expect(staleAfterMs(10 * MINUTE)).toBe(20 * MINUTE);
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
  const closed = { id: 't-run', status: 'done' as const, closedAt: NINE + HOUR };
  const fired = { ...DAILY_9, state: { lastFiredAt: NINE, lastInstanceId: 't-run' } };

  it('is not stale inside one interval plus the slack, and is past it', () => {
    const limit = NINE + HOUR + staleAfterMs(DAY);
    expect(runRecord(fired, closed, limit).stale).toBe(false);
    expect(runRecord(fired, closed, limit + 1).stale).toBe(true);
  });

  it('counts from the arming when nothing has ever succeeded', () => {
    expect(runRecord(DAILY_9, undefined, MON + staleAfterMs(DAY)).stale).toBe(false);
    expect(runRecord(DAILY_9, undefined, MON + staleAfterMs(DAY) + 1).stale).toBe(true);
  });

  it('calls an open run stale once its rule was owed another success', () => {
    const open = { id: 't-run', status: 'open' as const };
    // Armed an hour before the fire, so the arming is not what makes it late.
    const rule = { ...fired, armedAt: NINE - HOUR };
    expect(runRecord(rule, open, NINE + 20 * HOUR).stale).toBe(false);
    expect(runRecord(rule, open, NINE + 2 * DAY).stale).toBe(true);
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
