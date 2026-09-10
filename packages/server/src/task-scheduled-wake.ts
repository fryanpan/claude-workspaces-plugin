/**
 * Waking the owner of a scheduled run, on the scheduler's own pass
 * (docs/architecture/scheduled-tasks.md, "The wake path").
 *
 * `task-scheduler.ts` files the instance and names its owner on it. This is
 * what gets that owner ONTO it — the difference between a row appearing and
 * the work starting, which every peer's silent-for-weeks job showed is the
 * difference that matters. Three things happen here, and only here:
 *
 *  - **An attached owner is woken.** While the instance sits in `todo`, one
 *    addressed frame (`task.scheduled_run`, carrying the instance id) goes to
 *    the owner's session on the board — `sendToAgent`, the same delivery the
 *    stall and ready wakes ride, never a broadcast.
 *  - **A detached owner gets one spawn request.** When the owner holds no
 *    stream, the frame that can help goes to the SPAWNER instead — the one
 *    session on this server that starts others, named by id
 *    (`spawnerAgentId`, the fleet's Team Lead) and reached on whichever board
 *    it is attached to. ONE per instance: a second ask before the first is
 *    acted on is noise, and the spawned session claiming the row is the
 *    answer both are waiting for.
 *  - **Attempts are bounded, then a person is asked.** `schedule-wake.ts`
 *    holds the backoff. When the last attempt has gone unanswered the board
 *    files one review item on the instance — the row's owner's row, on the
 *    reader's Home queue — and stops. Every attempt, whoever it reached, is
 *    written on the rule so the run record can say whether the wake was
 *    answered rather than infer it from silence.
 *
 * Answered means the instance left `todo` (or was archived): whoever moved
 * it, the wake's job is done, and the name on that transition is recorded.
 */
import type { TaskReviewItem } from '@claude-workspaces/core';
import {
  type ScheduleWake,
  WAKE_MAX_ATTEMPTS,
  type WakeAttempt,
  describeAttempts,
  wakeStep,
} from '@claude-workspaces/core/schedule-wake';
import type { Task } from '@claude-workspaces/core/task-wire';
import { taskDeepLink } from './home-brief.ts';
import type { AddReviewItemResult } from './review-items/types.ts';
import type { RunRecordObserver } from './task-run-record.ts';

export const SCHEDULED_RUN_EVENT = 'task.scheduled_run';
export const SPAWN_REQUESTED_EVENT = 'task.spawn_requested';
/** The fleet's Team Lead — the session that spawns the others. */
export const DEFAULT_SPAWNER_AGENT_ID = 'agent-team-lead';

/** The frame an attached owner receives. Flat, like every other frame. */
export interface ScheduledRunFrame {
  event: typeof SCHEDULED_RUN_EVENT;
  workspaceId: string;
  /** The INSTANCE — the row to take. */
  taskId: string;
  title: string;
  ruleId: string;
  occurrenceAt: number;
  attempt: number;
  attempts: number;
  ts: number;
}

/** The frame the spawner receives for an owner that holds no stream. */
export interface SpawnRequestedFrame {
  event: typeof SPAWN_REQUESTED_EVENT;
  /** The board the RUN is on — not the board the spawner was reached on. */
  workspaceId: string;
  taskId: string;
  title: string;
  ruleId: string;
  /** The detached owner, by id and by name. */
  agentId: string;
  agentName?: string;
  ts: number;
}

export interface WakeStore {
  getTask(taskId: string): Task | undefined;
  listWorkspaces(): readonly { id: string }[];
  ownerIdOf(task: Pick<Task, 'assignee' | 'assigneeId'>): string | undefined;
  listReviewItems(taskId: string): TaskReviewItem[];
  addReviewItem(
    taskId: string,
    review: unknown,
    opts: { actor: { id: string; name: string; kind?: string } },
  ): AddReviewItemResult;
  appendNote(
    taskId: string,
    input: { kind: 'turn' | 'denial' | 'status'; text: string; agent: string; ts: number },
  ): unknown;
  scheduleSave(workspaceId: string): void;
}

export interface WakeDelivery {
  /** Does that agent hold a stream on that board right now? */
  canReach(workspaceId: string, agentId: string): boolean;
  /** Addressed delivery; returns how many streams took the frame. */
  send(
    workspaceId: string,
    agentId: string,
    frame: ScheduledRunFrame | SpawnRequestedFrame,
  ): number;
  /** The session that starts other sessions. Absent → no spawn requests. */
  spawnerAgentId?: string;
  report: (message: string) => void;
}

/** The exhausted item's words. Exported so a test reads what a person would see. */
export function buildUnansweredReview(input: {
  workspaceId: string;
  instance: Task;
  wake: ScheduleWake;
  now: number;
}): Record<string, unknown> {
  const { workspaceId, instance, wake, now } = input;
  const title = instance.title.replace(/[[\]]/g, '');
  const first = wake.attempts[0]?.at ?? now;
  const owner = instance.assignee ?? 'its owner';
  const spawner = wake.attempts.some((a) => a.via === 'spawner');
  const detail = [
    `The board filed [${title}](${taskDeepLink(workspaceId, instance.id)}) for ${owner} and tried ${wake.attempts.length} times over ${Math.round((now - first) / 60_000)} minutes to get a session onto it (${describeAttempts(wake)}). Nobody took it.`,
    '',
    spawner
      ? 'A spawn request went out once for the detached owner and was not acted on.'
      : 'No session that could start the owner was attached, so nobody could be asked to.',
    '',
    'Start the session yourself, hand the task to somebody else, or answer here to say it can wait. The board asks once per run.',
  ].join('\n');
  return {
    review_type: 'question',
    headline: `Nobody picked up “${title}”, the scheduled run for ${owner}`,
    detail,
  };
}

function answeredBy(instance: Task): string | undefined {
  const last = instance.transitions?.at(-1);
  return last?.by?.name;
}

/** Where the spawner is attached — the run's own board first. */
function spawnerBoard(store: WakeStore, delivery: WakeDelivery, workspaceId: string) {
  const id = delivery.spawnerAgentId;
  if (id === undefined) return undefined;
  if (delivery.canReach(workspaceId, id)) return workspaceId;
  return store.listWorkspaces().find((ws) => delivery.canReach(ws.id, id))?.id;
}

/**
 * The per-rule pass, built once and called by the scheduler for every rule on
 * every tick, after the run record has looked. Mutates the live rule row and
 * hands it to `scheduleSave`, the store's own pattern.
 */
export function observeScheduledWake(
  store: WakeStore,
  delivery: WakeDelivery,
  actor: { id: string; name: string; kind?: string },
): RunRecordObserver {
  const note = (ruleId: string, text: string, ts: number) =>
    store.appendNote(ruleId, { kind: 'status', text, agent: actor.name, ts });

  return (row, now) => {
    const rule = store.getTask(row.taskId);
    const state = rule?.schedule?.state;
    const instanceId = state?.lastInstanceId;
    if (!rule || !state || instanceId === undefined) return;
    const instance = store.getTask(instanceId);
    if (!instance) return;
    const wake: ScheduleWake =
      state.wake?.instanceId === instanceId ? state.wake : { instanceId, attempts: [] };
    const save = () => {
      state.wake = wake;
      store.scheduleSave(row.workspaceId);
    };

    const taken = instance.status !== 'todo' || instance.archivedAt !== undefined;
    if (taken) {
      if (wake.attempts.length > 0 && wake.answeredAt === undefined) {
        wake.answeredAt = now;
        const by = answeredBy(instance);
        if (by !== undefined) wake.answeredBy = by;
        note(
          rule.id,
          `Wake answered — ${by ?? 'somebody'} took ${instanceId} after ${wake.attempts.length} attempt(s)`,
          now,
        );
        save();
      }
      return;
    }

    const step = wakeStep(wake, now);
    if (step === 'wait') return;

    if (step === 'exhausted') {
      if (wake.exhaustedItemId !== undefined) return;
      const res = store.addReviewItem(
        instance.id,
        buildUnansweredReview({ workspaceId: row.workspaceId, instance, wake, now }),
        { actor },
      );
      if (res.ok) {
        wake.exhaustedItemId = res.item.id;
        note(
          rule.id,
          `Wake unanswered after ${wake.attempts.length} attempts — asked on ${instanceId}`,
          now,
        );
        save();
        delivery.report(
          `[scheduler] wake for ${instanceId} unanswered; filed review item ${res.item.id}`,
        );
      } else {
        delivery.report(
          `[scheduler] wake for ${instanceId} unanswered but the item was refused: ${res.error}`,
        );
      }
      return;
    }

    const n = wake.attempts.length + 1;
    const ownerId = store.ownerIdOf(instance);
    let attempt: WakeAttempt;
    if (ownerId !== undefined && delivery.canReach(row.workspaceId, ownerId)) {
      delivery.send(row.workspaceId, ownerId, {
        event: SCHEDULED_RUN_EVENT,
        workspaceId: row.workspaceId,
        taskId: instance.id,
        title: instance.title,
        ruleId: rule.id,
        occurrenceAt: instance.recurrenceOf?.occurrenceAt ?? now,
        attempt: n,
        attempts: WAKE_MAX_ATTEMPTS,
        ts: now,
      });
      attempt = { at: now, via: 'owner', to: ownerId };
      note(
        rule.id,
        `Wake ${n}/${WAKE_MAX_ATTEMPTS} — told ${instance.assignee ?? ownerId} about ${instanceId}`,
        now,
      );
    } else {
      const asked = wake.attempts.some((a) => a.via === 'spawner');
      const board =
        ownerId !== undefined && !asked
          ? spawnerBoard(store, delivery, row.workspaceId)
          : undefined;
      if (board !== undefined && ownerId !== undefined && delivery.spawnerAgentId !== undefined) {
        delivery.send(board, delivery.spawnerAgentId, {
          event: SPAWN_REQUESTED_EVENT,
          workspaceId: row.workspaceId,
          taskId: instance.id,
          title: instance.title,
          ruleId: rule.id,
          agentId: ownerId,
          ...(instance.assignee !== undefined ? { agentName: instance.assignee } : {}),
          ts: now,
        });
        attempt = { at: now, via: 'spawner', to: delivery.spawnerAgentId };
        note(
          rule.id,
          `Wake ${n}/${WAKE_MAX_ATTEMPTS} — ${instance.assignee ?? ownerId} is not attached; asked ${delivery.spawnerAgentId} to spawn it for ${instanceId}`,
          now,
        );
      } else {
        attempt = { at: now, via: 'nobody' };
        note(
          rule.id,
          `Wake ${n}/${WAKE_MAX_ATTEMPTS} — nobody reachable for ${instanceId}${ownerId === undefined ? ' (no owner id)' : ''}`,
          now,
        );
      }
    }
    wake.attempts.push(attempt);
    save();
  };
}
