/**
 * The on-change rule, driven through the same `nextOccurrence` /
 * `dueOccurrence` every kind answers (`schedule-trigger.ts`). Every instant is
 * a literal; fixtures are invented.
 */
import { describe, expect, it } from 'vitest';
import { missedRunOutcome } from './schedule-missed.ts';
import { parseSchedule } from './schedule-parse.ts';
import { scheduleIntervalMs } from './schedule-run-record.ts';
import { TRIGGER_DEFAULT_DEBOUNCE_MS, parseOnChangeRule } from './schedule-trigger.ts';
import { type TaskSchedule, dueOccurrence, nextOccurrence } from './task-schedule.ts';

const MON = Date.UTC(2026, 2, 2);
const MINUTE = 60_000;

const WATCH: TaskSchedule = {
  rule: { kind: 'on-change', source: { kind: 'doc', docId: 'd-lamp' } },
  armedAt: MON,
};

describe('when an on-change rule is owed', () => {
  it('is owed nothing until the watched thing changes after the arming', () => {
    expect(nextOccurrence(WATCH, {})).toBeUndefined();
    expect(nextOccurrence(WATCH, { changedAt: MON - MINUTE })).toBeUndefined();
    expect(nextOccurrence(WATCH, { changedAt: MON })).toBeUndefined();
  });

  it('is owed one quiet window after the change, and a later edit moves it later', () => {
    expect(nextOccurrence(WATCH, { changedAt: MON + MINUTE })).toBe(
      MON + MINUTE + TRIGGER_DEFAULT_DEBOUNCE_MS,
    );
    expect(nextOccurrence(WATCH, { changedAt: MON + 3 * MINUTE })).toBe(
      MON + 3 * MINUTE + TRIGGER_DEFAULT_DEBOUNCE_MS,
    );
    const quick = { ...WATCH, rule: { ...WATCH.rule, debounceMs: 5 * MINUTE } };
    expect(nextOccurrence(quick, { changedAt: MON + MINUTE })).toBe(MON + 6 * MINUTE);
  });

  it('is not due until the window has passed, then due exactly once, with nothing to catch up', () => {
    const changedAt = MON + MINUTE;
    const owed = changedAt + TRIGGER_DEFAULT_DEBOUNCE_MS;
    expect(dueOccurrence(WATCH, owed - 1, { changedAt })).toBeUndefined();
    expect(dueOccurrence(WATCH, owed, { changedAt })).toEqual({ at: owed, missed: 0 });
    // Hours late — say, after a restart — still one occurrence, not a walk.
    expect(dueOccurrence(WATCH, owed + 5 * 60 * MINUTE, { changedAt })).toEqual({
      at: owed,
      missed: 0,
    });
    // Acted on: the same change is spent, a newer one is owed again.
    const fired = { ...WATCH, state: { lastOccurrenceAt: owed } };
    expect(nextOccurrence(fired, { changedAt })).toBeUndefined();
    expect(nextOccurrence(fired, { changedAt: owed + MINUTE })).toBe(
      owed + MINUTE + TRIGGER_DEFAULT_DEBOUNCE_MS,
    );
  });

  it('is never missed, never stale, and honours an end limit', () => {
    const changedAt = MON + MINUTE;
    const owed = changedAt + TRIGGER_DEFAULT_DEBOUNCE_MS;
    expect(missedRunOutcome(WATCH, { at: owed, missed: 0 }, owed + 60 * MINUTE)).toEqual({
      kind: 'run',
    });
    expect(scheduleIntervalMs(WATCH)).toBeUndefined();
    expect(nextOccurrence({ ...WATCH, until: owed }, { changedAt })).toBeUndefined();
  });
});

describe('reading an on-change rule off the wire', () => {
  it('accepts a doc or a task source and an optional debounce', () => {
    expect(parseOnChangeRule({ source: { kind: 'doc', docId: 'd-Lamp_1' } })).toEqual({
      ok: true,
      rule: { kind: 'on-change', source: { kind: 'doc', docId: 'd-Lamp_1' } },
    });
    expect(
      parseOnChangeRule({ source: { kind: 'task', taskId: 't-lamp' }, debounceMs: 5 * MINUTE }),
    ).toEqual({
      ok: true,
      rule: {
        kind: 'on-change',
        source: { kind: 'task', taskId: 't-lamp' },
        debounceMs: 5 * MINUTE,
      },
    });
  });

  it('refuses a missing source, a path-shaped id, and a negative debounce', () => {
    expect(parseOnChangeRule({}).ok).toBe(false);
    expect(parseOnChangeRule({ source: { kind: 'doc', docId: '../etc' } }).ok).toBe(false);
    expect(parseOnChangeRule({ source: { kind: 'doc', docId: 'd-x' }, debounceMs: -1 }).ok).toBe(
      false,
    );
  });

  it('is one of the kinds the JSON door accepts', () => {
    const parsed = parseSchedule({
      rule: { kind: 'on-change', source: { kind: 'task', taskId: 't-lamp' } },
      until: MON,
    });
    expect(parsed).toEqual({
      ok: true,
      rule: { kind: 'on-change', source: { kind: 'task', taskId: 't-lamp' } },
      until: MON,
    });
  });
});
