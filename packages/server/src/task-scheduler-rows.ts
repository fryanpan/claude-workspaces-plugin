/**
 * Every rule row the loop looks at, with its cursor resolved
 * (`task-scheduler.ts` runs the loop; this is what it reads). Split out when
 * the on-change kind gave the cursor a third reading and the loop's file
 * crossed its line.
 */
import type { TriggerSource } from '@claude-workspaces/core/schedule-trigger';
import type { ScheduleCursor, TaskSchedule } from '@claude-workspaces/core/task-schedule';
import type { ScheduledRow, SchedulerStore } from './task-scheduler.ts';
import { isRetired } from './workspace-store.ts';

/**
 * When the watched doc or task last changed, for an on-change rule. A task's
 * `updatedAt` moves on every edit the store makes to it; a doc's is the
 * `.ydoc` mtime the doc store reports, which every prose and thread change
 * rewrites. Unknown — a doc the store cannot see, a task that is gone — reads
 * as no change, so a rule watching nothing is owed nothing rather than firing
 * on a guess.
 */
function changedAtFor(store: SchedulerStore, source: TriggerSource): number | undefined {
  if (source.kind === 'task') return store.getTask(source.taskId)?.updatedAt;
  return store.docActivityAt?.(source.docId);
}

/**
 * When the instance created by the last occurrence finished, for the one mode
 * that needs it. Three readings, and the third is the one worth stating:
 *
 *  - **done** — the timestamp of the transition INTO done, which is when the
 *    work actually finished, not when the row was last touched afterwards;
 *  - **archived** — a soft delete takes the row out of the open set as
 *    finally as closing it does, so a rule whose instance was archived is not
 *    blocked forever behind it;
 *  - **gone** — an instance the store cannot find is not open either. Dated
 *    from the fire that created it, the only honest timestamp left; without
 *    this an after-completion rule whose instance was purged would never come
 *    due again, silently.
 */
export function scheduleCursorFor(store: SchedulerStore, schedule: TaskSchedule): ScheduleCursor {
  if (schedule.rule.kind === 'on-change') {
    const changedAt = changedAtFor(store, schedule.rule.source);
    return changedAt === undefined ? {} : { changedAt };
  }
  const instanceId = schedule.state?.lastInstanceId;
  if (instanceId === undefined) return {};
  const instance = store.getTask(instanceId);
  if (!instance) {
    const firedAt = schedule.state?.lastFiredAt;
    return firedAt !== undefined ? { lastCompletedAt: firedAt } : {};
  }
  if (instance.archivedAt !== undefined) return { lastCompletedAt: instance.archivedAt };
  // Open. If it is a CATCH-UP it is also the lock: the next fixed-cadence
  // occurrence folds into it rather than filing beside it (schedule-missed.ts).
  if (instance.status !== 'done') {
    return instance.recurrenceOf?.catchUp === true ? { openCatchUpInstanceId: instance.id } : {};
  }
  let closedAt: number | undefined;
  for (const t of instance.transitions ?? []) {
    if (t.to === 'done') closedAt = t.ts;
  }
  return { lastCompletedAt: closedAt ?? instance.updatedAt };
}

/** Every rule row on every live board, with its cursor resolved. */
export function scheduledRows(store: SchedulerStore): ScheduledRow[] {
  const out: ScheduledRow[] = [];
  for (const workspace of store.listWorkspaces()) {
    // A retired board fires nothing. Its rows keep their rules, so an
    // unretire resumes them — but `createTask` refuses every filing to a
    // stood-down board, and asking it once per rule per tick would fill the
    // log with refusals nobody can act on.
    if (isRetired(workspace)) continue;
    for (const task of store.listTasks(workspace.id)) {
      const schedule = task.schedule;
      // `listTasks` already drops archived rows: archiving the rule is how a
      // person turns a schedule off without destroying its history.
      if (!schedule) continue;
      out.push({
        taskId: task.id,
        workspaceId: workspace.id,
        schedule,
        cursor: scheduleCursorFor(store, schedule),
      });
    }
  }
  return out;
}
