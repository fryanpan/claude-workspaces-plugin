/**
 * A rule that runs when something changes, on a REAL task store with an
 * injected clock (`task-scheduler-rows.ts` reads the change; the loop in
 * `task-scheduler.ts` fires it). What is asserted is what the board gets:
 * nothing inside the quiet window, ONE instance after it, none more while
 * the source stays still, and a second instance for a second change. A
 * task edit is stamped by the wall clock, so the clock here is read off the
 * edited row rather than invented. Fixtures are made up; the repo is public.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TRIGGER_DEFAULT_DEBOUNCE_MS } from '@claude-workspaces/core/schedule-trigger';
import { createTaskScheduler } from '../src/task-scheduler.ts';
import { TaskStore } from '../src/tasks.ts';
import { HOUR, MON, OWNER, instancesOf, seed } from './task-scheduler-seed.ts';

const MINUTE = 60_000;

describe('a rule that runs when a task changes', () => {
  let dataDir: string;
  let store: TaskStore;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'task-scheduler-trigger-'));
    store = new TaskStore({ dataDir, debounceMs: 5 });
  });

  afterEach(() => {
    store.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  /** A second row on the rule's board, for the rule to watch. */
  function watched(workspaceId: string, goalId: string): string {
    const created = store.createTask(workspaceId, {
      title: 'The lamp doc',
      body: 'Bryan can read the lamp doc so that the beam is explained.',
      assignee: OWNER.name,
      assigneeKind: 'agent',
      goal: goalId,
      actor: OWNER,
    });
    if (!created.ok) throw new Error(`create refused: ${created.error}`);
    return created.task.id;
  }

  it('fires once per change, after the quiet window, and never for stillness', () => {
    const ws = store.createWorkspace('Harbour Lights');
    const goals = store.setGoalList(ws.id, [{ title: 'Keep the lamps lit' }], { actor: OWNER });
    if (!goals.ok) throw new Error('goal list refused');
    const goalId = goals.created[0]?.id ?? '';
    const taskId = watched(ws.id, goalId);
    // Armed after the watched row was filed — its creation is not a change.
    const armedAt = store.getTask(taskId)?.updatedAt ?? 0;
    const { workspaceId, ruleId } = seed(store, {
      rule: { kind: 'on-change', source: { kind: 'task', taskId } },
      armedAt,
    });
    let now = armedAt + HOUR;
    const scheduler = createTaskScheduler(store, { now: () => now, report: () => {} });
    // Armed, nothing changed: owed nothing, however long it waits.
    expect(scheduler.tick()).toEqual([]);
    now = armedAt + 30 * 24 * HOUR;
    expect(scheduler.tick()).toEqual([]);

    // A change. The edit is stamped by the wall clock, so let that clock
    // pass the arming first (a same-millisecond edit reads as no change).
    while (Date.now() <= armedAt) {
      /* spin */
    }
    expect(store.renameTask(taskId, 'The lamp doc, revised', { actor: OWNER }).ok).toBe(true);
    const changedAt = store.getTask(taskId)?.updatedAt ?? 0;
    expect(changedAt).toBeGreaterThanOrEqual(armedAt);
    now = changedAt + TRIGGER_DEFAULT_DEBOUNCE_MS - 1;
    expect(scheduler.tick()).toEqual([]);
    now = changedAt + TRIGGER_DEFAULT_DEBOUNCE_MS;
    expect(scheduler.tick()).toHaveLength(1);
    expect(instancesOf(store, workspaceId, ruleId)).toHaveLength(1);
    // Still: no second instance for the same change, however many ticks.
    for (const step of [MINUTE, HOUR, 24 * HOUR]) {
      now = changedAt + TRIGGER_DEFAULT_DEBOUNCE_MS + step;
      expect(scheduler.tick()).toEqual([]);
    }
    expect(instancesOf(store, workspaceId, ruleId)).toHaveLength(1);

    // A second change, a second instance — nothing about the first is
    // required to have closed. Again let the wall clock pass the last edit.
    while (Date.now() <= changedAt) {
      /* spin */
    }
    expect(store.renameTask(taskId, 'The lamp doc, revised again', { actor: OWNER }).ok).toBe(true);
    const again = store.getTask(taskId)?.updatedAt ?? 0;
    now = Math.max(now, again + TRIGGER_DEFAULT_DEBOUNCE_MS);
    expect(scheduler.tick()).toHaveLength(1);
    expect(instancesOf(store, workspaceId, ruleId)).toHaveLength(2);
    // The instance names the occurrence it stands for: the quiet window's end.
    expect(instancesOf(store, workspaceId, ruleId)[1]?.recurrenceOf?.occurrenceAt).toBe(
      again + TRIGGER_DEFAULT_DEBOUNCE_MS,
    );
  });

  it('reads a doc change through the reader the doc store is wired to', () => {
    let activity: number | undefined;
    store.setDocActivityReader((docId) => (docId === 'd-lamp' ? activity : undefined));
    const { workspaceId, ruleId } = seed(store, {
      rule: { kind: 'on-change', source: { kind: 'doc', docId: 'd-lamp' }, debounceMs: 5 * MINUTE },
      armedAt: MON,
    });
    let now = MON + HOUR;
    const scheduler = createTaskScheduler(store, { now: () => now, report: () => {} });
    // A doc that last changed BEFORE the arming is not a change.
    activity = MON - HOUR;
    expect(scheduler.tick()).toEqual([]);
    // One after it fires once the five minutes have passed.
    activity = MON + HOUR;
    now = MON + HOUR + 4 * MINUTE;
    expect(scheduler.tick()).toEqual([]);
    now = MON + HOUR + 5 * MINUTE;
    expect(scheduler.tick()).toHaveLength(1);
    now = MON + 2 * HOUR;
    expect(scheduler.tick()).toEqual([]);
    // A doc the store cannot see is owed nothing.
    const blind = seed(store, {
      rule: { kind: 'on-change', source: { kind: 'doc', docId: 'd-gone' } },
      armedAt: MON,
    });
    now = MON + 3 * HOUR;
    expect(scheduler.tick()).toEqual([]);
    expect(instancesOf(store, workspaceId, ruleId)).toHaveLength(1);
    expect(instancesOf(store, blind.workspaceId, blind.ruleId)).toHaveLength(0);
  });
});

describe('an interval under an hour', () => {
  let dataDir: string;
  let store: TaskStore;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'task-scheduler-five-'));
    store = new TaskStore({ dataDir, debounceMs: 5 });
  });

  afterEach(() => {
    store.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('fires at every five-minute tick and never between them', () => {
    const { workspaceId, ruleId } = seed(store, {
      rule: { kind: 'every', everyMs: 5 * MINUTE },
      armedAt: MON,
    });
    let now = MON;
    const scheduler = createTaskScheduler(store, { now: () => now, report: () => {} });
    expect(scheduler.tick()).toEqual([]);
    for (let n = 1; n <= 3; n++) {
      now = MON + n * 5 * MINUTE - 1;
      expect(scheduler.tick()).toEqual([]);
      now = MON + n * 5 * MINUTE;
      expect(scheduler.tick()).toHaveLength(1);
      now += 2 * MINUTE;
      expect(scheduler.tick()).toEqual([]);
    }
    const instances = instancesOf(store, workspaceId, ruleId);
    expect(instances.map((t) => t.recurrenceOf?.occurrenceAt)).toEqual([
      MON + 5 * MINUTE,
      MON + 10 * MINUTE,
      MON + 15 * MINUTE,
    ]);
  });
});
