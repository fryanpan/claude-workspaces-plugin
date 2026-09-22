/**
 * What the stale review item SAYS about a rule whose gaps are uneven, and
 * when it is filed at all (`task-run-record.ts`).
 *
 * The item used to claim "it runs every 3h" for a rule firing at 00, 06, 09,
 * 12, 15, 18 and 21 Pacific, because the cadence clause read the gap between
 * the next two occurrences — and the same arithmetic filed the item before
 * 06:00 was due. An uneven rule now names the run it was owed instead.
 *
 * Driven on a real store with a real review-item queue and an injected clock,
 * so the item read here is the one a person would open. `observeRunRecord` is
 * called directly where the point is a run that was NEVER FILED; the
 * scheduler drives the case where one was. Fixtures are invented; the repo is
 * public.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TaskReviewItem, isReviewItemOpen, reviewWithdrawn } from '@claude-workspaces/core';
import { instantForLocal } from '@claude-workspaces/core/task-schedule';
import { observeRunRecord } from '../src/task-run-record.ts';
import { createTaskScheduler } from '../src/task-scheduler.ts';
import { TaskStore } from '../src/tasks.ts';
import { seed } from './task-scheduler-seed.ts';

const LA = 'America/Los_Angeles';
/** A wall-clock reading on 2026-09-22, Pacific — the day it was measured. */
const la = (hour: number, minute = 0): number => instantForLocal(LA, 2026, 9, 22, hour, minute);
/** The midnight run closed five minutes after it fired. */
const SUCCESS = la(0, 5);
const SCHEDULER = { id: 'agent-scheduler', name: 'Scheduler', kind: 'agent' } as const;

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

  /** Put a rule where it stood at 00:05: its midnight run fired and
   *  succeeded, and nothing has been filed since. */
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

  /** The scheduler's own per-rule pass, without firing anything. */
  const readAt = (workspaceId: string, ruleId: string, now: number): void => {
    observeRunRecord(store, SCHEDULER, () => {})({ taskId: ruleId, workspaceId }, now);
  };

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'stale-item-words-'));
    store = new TaskStore({ dataDir, debounceMs: 5 });
  });

  afterEach(() => {
    store.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('files nothing at 05:30, because the 06:00 run is not due yet', () => {
    const { workspaceId, ruleId } = seed(store, SEVEN_A_DAY);
    recordMidnightRun(ruleId);
    // 05:30 is the reading that discriminates: five hours and twenty-five
    // minutes after the success, past the four hours the old arithmetic
    // allowed, and still before the run it is waiting for.
    readAt(workspaceId, ruleId, la(5, 30));
    expect(openItems(ruleId)).toHaveLength(0);
    // The control: the same rule, same store, an hour past 06:00, does file.
    readAt(workspaceId, ruleId, la(7, 30));
    expect(openItems(ruleId)).toHaveLength(1);
  });

  it('names the run that was due instead of claiming a cadence it does not run on', () => {
    const { workspaceId, ruleId } = seed(store, SEVEN_A_DAY);
    recordMidnightRun(ruleId);
    readAt(workspaceId, ruleId, la(7, 30));
    const detail = openItems(ruleId)[0]?.review.detail ?? '';
    expect(detail).toContain('its 06:00 America/Los_Angeles run was due 2h ago');
    expect(detail).not.toContain('it runs every');
  });

  it('names the time the rule itself carries across a spring-forward morning', () => {
    // 2026-03-08 has no 02:30 in Los Angeles, so the instant the rule is owed
    // reads as some other wall-clock time. The reader typed 02:30.
    const { workspaceId, ruleId } = seed(store, {
      rule: { kind: 'calendar' as const, times: [{ hour: 2, minute: 30 }] },
      timezone: LA,
      armedAt: instantForLocal(LA, 2026, 3, 1, 0, 0),
    });
    const schedule = store.getTask(ruleId)?.schedule;
    if (schedule === undefined) throw new Error('no schedule');
    const lastGood = instantForLocal(LA, 2026, 3, 7, 2, 30);
    schedule.state = {
      ...schedule.state,
      lastOccurrenceAt: lastGood,
      lastFiredAt: lastGood,
      lastSuccessAt: lastGood,
    };
    readAt(workspaceId, ruleId, instantForLocal(LA, 2026, 3, 8, 12, 0));
    const detail = openItems(ruleId)[0]?.review.detail ?? '';
    expect(detail).toContain('its 02:30 America/Los_Angeles run was due');
  });

  it('still tells an even rule its cadence — the control', () => {
    const { workspaceId, ruleId } = seed(store, {
      rule: { kind: 'every' as const, everyMs: 3 * 3_600_000 },
      timezone: LA,
      armedAt: la(0, 0),
    });
    recordMidnightRun(ruleId);
    // The same 05:30 reading that leaves the uneven rule alone: this rule was
    // owed a run at 03:00 and did not get one, so it files.
    readAt(workspaceId, ruleId, la(5, 30));
    expect(openItems(ruleId)).toHaveLength(1);
    expect(openItems(ruleId)[0]?.review.detail).toContain('it runs every 3h');
  });

  it('files nothing while a run is in flight for the occurrence that came due', () => {
    const { ruleId } = seed(store, SEVEN_A_DAY);
    recordMidnightRun(ruleId);
    let now = la(7, 30);
    const scheduler = createTaskScheduler(store, { now: () => now, report: () => {} });
    // The 06:00 run is filed on this tick and nobody closes it. It has until
    // 09:00, the next occurrence the rule is owed.
    scheduler.tick();
    expect(openItems(ruleId)).toHaveLength(0);
    now = la(9, 1);
    scheduler.tick();
    expect(openItems(ruleId)).toHaveLength(1);
  });
});
