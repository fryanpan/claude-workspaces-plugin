/**
 * One made-up board with one rule row, for the scheduler suites. Fixtures are
 * invented — the repo is public.
 */
import type { TaskSchedule } from '@claude-workspaces/core/task-schedule';
import { setTaskSchedule } from '../src/task-scheduler.ts';
import type { Task, TaskStore } from '../src/tasks.ts';

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
/** 2026-03-02T00:00:00Z, a Monday. */
export const MON = Date.UTC(2026, 2, 2);

export const OWNER = { id: 'agent-lamplighter', name: 'Lamplighter', kind: 'agent' } as const;

/** A board with one goal band and one row carrying a rule. */
export function seed(store: TaskStore, schedule: TaskSchedule) {
  const ws = store.createWorkspace('Harbour Lights');
  const goals = store.setGoalList(ws.id, [{ title: 'Keep the lamps lit' }], { actor: OWNER });
  if (!goals.ok) throw new Error('goal list refused');
  const goalId = goals.created[0]?.id;
  if (goalId === undefined) throw new Error('no goal id');
  const created = store.createTask(ws.id, {
    title: 'Sweep the lamp doc',
    body: 'Agent can sweep the lamp doc so that the beam stays clean.',
    assignee: OWNER.name,
    assigneeKind: 'agent',
    goal: goalId,
    actor: OWNER,
  });
  if (!created.ok) throw new Error(`create refused: ${created.error}`);
  const armed = setTaskSchedule(store, created.task.id, schedule);
  if (!armed.ok) throw new Error('arm refused');
  return { workspaceId: ws.id, goalId, ruleId: created.task.id };
}

/** Every instance the rule has produced, oldest first. */
export function instancesOf(store: TaskStore, workspaceId: string, ruleId: string): Task[] {
  return store
    .listTasks(workspaceId)
    .filter((t) => t.recurrenceOf?.taskId === ruleId)
    .sort((a, b) => a.createdAt - b.createdAt);
}
