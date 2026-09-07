/**
 * The missed-run policy, driven against a REAL task store with an injected
 * clock (`task-scheduler.ts` + `schedule-missed.ts`). The four outcomes are
 * unit-tested in core; what is asserted here is what each one leaves on the
 * BOARD — the flagged row, the note instead of a row, the fold into an open
 * catch-up, and the release when that catch-up closes.
 *
 * Nothing reads the wall clock. Fixtures are invented; the repo is public.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTaskScheduler } from '../src/task-scheduler.ts';
import { TaskStore } from '../src/tasks.ts';
import { DAY, HOUR, MON, OWNER, instancesOf, seed } from './task-scheduler-seed.ts';

describe('what happens to a missed run is the rule’s choice', () => {
  let dataDir: string;
  let store: TaskStore;
  const DAILY_9 = {
    rule: { kind: 'calendar' as const, times: [{ hour: 9, minute: 0 }] },
    timezone: 'UTC',
    armedAt: MON,
  };

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'task-scheduler-missed-'));
    store = new TaskStore({ dataDir, debounceMs: 5 });
  });

  afterEach(() => {
    store.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('an on-time run is never flagged, whatever the policy', () => {
    const { workspaceId, ruleId } = seed(store, { ...DAILY_9, onMissed: 'skip' });
    const now = MON + 9 * HOUR + 60_000;
    const fired = createTaskScheduler(store, { now: () => now }).tick();
    expect(fired.map((f) => f.outcome)).toEqual(['run']);
    const [instance] = instancesOf(store, workspaceId, ruleId);
    expect(instance?.recurrenceOf?.catchUp).toBeUndefined();
    expect(store.getTask(ruleId)?.notes?.at(-1)?.text).toContain('Scheduled occurrence');
  });

  it('skip-to-latest files nothing after an outage, records the skip, and never refires it', () => {
    const { workspaceId, ruleId } = seed(store, { ...DAILY_9, onMissed: 'skip' });
    // Down from before Monday 9am until Thursday evening: four occurrences.
    let now = MON + 3 * DAY + 20 * HOUR;
    const scheduler = createTaskScheduler(store, { now: () => now });
    const fired = scheduler.tick();
    expect(fired).toEqual([
      { taskId: ruleId, at: MON + 3 * DAY + 9 * HOUR, missed: 4, outcome: 'skip' },
    ]);
    expect(instancesOf(store, workspaceId, ruleId)).toHaveLength(0);

    const rule = store.getTask(ruleId);
    // The skip is on the record — the rule row's activity and its counters —
    // so a quiet week reads as a policy, not as a scheduler that stopped.
    expect(rule?.notes?.at(-1)?.text).toContain('Skipped missed occurrence');
    expect(rule?.notes?.at(-1)?.text).toContain('3 before it');
    expect(rule?.schedule?.state?.missedTotal).toBe(4);
    expect(rule?.schedule?.state?.skippedTotal).toBe(4);
    // Spent: the cursor moved past all four, so the same tick fires nothing…
    expect(scheduler.tick()).toEqual([]);
    // …and the next LIVE occurrence runs as normal.
    now = MON + 4 * DAY + 9 * HOUR + 60_000;
    expect(scheduler.tick().map((f) => f.outcome)).toEqual(['run']);
    expect(instancesOf(store, workspaceId, ruleId)).toHaveLength(1);
  });

  it('an open catch-up row is the lock: the next live occurrence folds into it', () => {
    const { workspaceId, ruleId } = seed(store, DAILY_9);
    // Recover Wednesday evening: one catch-up for Wed 9am, standing in for two.
    let now = MON + 2 * DAY + 20 * HOUR;
    const scheduler = createTaskScheduler(store, { now: () => now });
    const [catchUp] = scheduler.tick();
    expect(catchUp?.outcome).toBe('catch-up');
    const catchUpId = catchUp?.instanceId as string;
    expect(store.getTask(catchUpId)?.recurrenceOf?.missed).toBe(2);

    // Thursday 9am comes round with the catch-up still open. NO second row:
    // it folds, the catch-up's own count grows, and the note says where it
    // went.
    now = MON + 3 * DAY + 9 * HOUR + 60_000;
    expect(scheduler.tick()).toEqual([
      {
        taskId: ruleId,
        instanceId: catchUpId,
        at: MON + 3 * DAY + 9 * HOUR,
        missed: 1,
        outcome: 'fold',
      },
    ]);
    expect(instancesOf(store, workspaceId, ruleId)).toHaveLength(1);
    expect(store.getTask(catchUpId)?.recurrenceOf?.missed).toBe(3);
    expect(store.getTask(ruleId)?.notes?.at(-1)?.text).toContain(
      `folded into open catch-up ${catchUpId}`,
    );
    expect(store.getTask(ruleId)?.schedule?.state?.missedTotal).toBe(3);
    // Folded is spent: the same tick owes nothing more.
    expect(scheduler.tick()).toEqual([]);

    // Close the catch-up and the lock is gone: Friday files its own row.
    expect(store.transition(catchUpId, 'done', { actor: OWNER }).ok).toBe(true);
    now = MON + 4 * DAY + 9 * HOUR + 60_000;
    const [friday] = scheduler.tick();
    expect(friday?.outcome).toBe('run');
    expect(friday?.instanceId).not.toBe(catchUpId);
    expect(instancesOf(store, workspaceId, ruleId)).toHaveLength(2);
  });

  it('an ordinary open run is NOT a lock — fixed cadence stacks by design', () => {
    const { workspaceId, ruleId } = seed(store, DAILY_9);
    let now = MON + 9 * HOUR + 60_000;
    const scheduler = createTaskScheduler(store, { now: () => now });
    expect(scheduler.tick().map((f) => f.outcome)).toEqual(['run']);
    now = MON + DAY + 9 * HOUR + 60_000;
    expect(scheduler.tick().map((f) => f.outcome)).toEqual(['run']);
    expect(instancesOf(store, workspaceId, ruleId)).toHaveLength(2);
  });

  it('the policy survives a restart with the rule, and so does a skip', () => {
    const before = new TaskStore({ dataDir, debounceMs: 5 });
    const { workspaceId, ruleId } = seed(before, { ...DAILY_9, onMissed: 'skip' });
    before.stop();
    const after = new TaskStore({ dataDir, debounceMs: 5 });
    try {
      expect(after.getTask(ruleId)?.schedule?.onMissed).toBe('skip');
      const now = MON + 2 * DAY + 20 * HOUR;
      const fired = createTaskScheduler(after, { now: () => now }).tick();
      expect(fired.map((f) => f.outcome)).toEqual(['skip']);
      expect(instancesOf(after, workspaceId, ruleId)).toHaveLength(0);
    } finally {
      after.stop();
    }
    store.stop();
    store = new TaskStore({ dataDir, debounceMs: 5 });
  });
});
