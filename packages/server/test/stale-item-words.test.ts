/**
 * What the stale review item SAYS about a rule whose gaps are uneven
 * (`task-run-record.ts`, `buildStaleReview`). The item used to claim "it runs
 * every 3h" for a rule firing at 00, 06, 09, 12, 15, 18 and 21 Pacific,
 * because the cadence clause read the gap between the next two occurrences.
 * An uneven rule names the run it was owed and when instead.
 *
 * Driven through the real scheduler on a real store with an injected clock,
 * so the item read here is the one a person would open. Fixtures are
 * invented; the repo is public.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TaskReviewItem, isReviewItemOpen, reviewWithdrawn } from '@claude-workspaces/core';
import { instantForLocal } from '@claude-workspaces/core/task-schedule';
import { createTaskScheduler } from '../src/task-scheduler.ts';
import { TaskStore } from '../src/tasks.ts';
import { seed } from './task-scheduler-seed.ts';

const LA = 'America/Los_Angeles';
/** A wall-clock reading on 2026-09-22, Pacific — the day it was measured. */
const la = (hour: number, minute = 0): number => instantForLocal(LA, 2026, 9, 22, hour, minute);
/** The midnight run closed five minutes after it fired. */
const SUCCESS = la(0, 5);

const SEVEN_A_DAY = {
  rule: {
    kind: 'calendar' as const,
    times: [0, 6, 9, 12, 15, 18, 21].map((hour) => ({ hour, minute: 0 })),
  },
  timezone: LA,
  armedAt: instantForLocal(LA, 2026, 9, 1, 12, 0),
};

describe('the stale item for a rule whose gaps are uneven', () => {
  let dataDir: string;
  let store: TaskStore;

  const openItems = (ruleId: string): TaskReviewItem[] =>
    store.listReviewItems(ruleId).filter((i) => isReviewItemOpen(i) && !reviewWithdrawn(i.review));

  /** Put the rule where it stood at 00:05: the midnight run fired and
   *  succeeded, and nothing is owed again until 06:00. */
  const recordMidnightRun = (ruleId: string): void => {
    const schedule = store.getTask(ruleId)?.schedule;
    if (schedule === undefined) throw new Error('no schedule');
    schedule.state = {
      ...schedule.state,
      lastOccurrenceAt: la(0, 0),
      lastFiredAt: la(0, 0),
      lastSuccessAt: SUCCESS,
    };
  };

  /** The rule as it stood at 00:05: the midnight run fired and succeeded. */
  const armed = (): { workspaceId: string; ruleId: string } => {
    const ids = seed(store, SEVEN_A_DAY);
    recordMidnightRun(ids.ruleId);
    return ids;
  };

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'stale-item-words-'));
    store = new TaskStore({ dataDir, debounceMs: 5 });
  });

  afterEach(() => {
    store.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('files nothing at 04:01, two hours before the 06:00 run is due', () => {
    const { ruleId } = armed();
    let now = la(4, 1);
    const scheduler = createTaskScheduler(store, { now: () => now, report: () => {} });
    scheduler.tick();
    expect(openItems(ruleId)).toHaveLength(0);
    // The control: the same rule, same store, an hour past 06:00, does file.
    now = la(7, 30);
    scheduler.tick();
    expect(openItems(ruleId)).toHaveLength(1);
  });

  it('names the run that was due instead of claiming a cadence it does not run on', () => {
    const { ruleId } = armed();
    const now = la(7, 30);
    const scheduler = createTaskScheduler(store, { now: () => now, report: () => {} });
    scheduler.tick();
    const detail = openItems(ruleId)[0]?.review.detail ?? '';
    expect(detail).toContain('its 06:00 run was due 2h ago');
    expect(detail).not.toContain('it runs every');
  });

  it('still tells an even rule its cadence', () => {
    const { ruleId } = seed(store, {
      rule: { kind: 'every' as const, everyMs: 3 * 3_600_000 },
      timezone: LA,
      armedAt: la(0, 0),
    });
    recordMidnightRun(ruleId);
    const now = la(4, 1);
    const scheduler = createTaskScheduler(store, { now: () => now, report: () => {} });
    scheduler.tick();
    expect(openItems(ruleId)[0]?.review.detail).toContain('it runs every 3h');
  });
});
