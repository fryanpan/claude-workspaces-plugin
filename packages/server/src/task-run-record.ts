/**
 * Reading each scheduled rule's last run back, on the scheduler's own pass
 * (docs/architecture/scheduled-tasks.md, "The run record").
 *
 * `task-scheduler.ts` fires occurrences; this module is what looks at what
 * became of them. Two things happen here and nowhere else:
 *
 *  - **A success is recorded.** When the rule's last instance has closed
 *    `done`, the close is written onto the rule (`state.lastSuccessAt`) and
 *    one line goes in its activity naming the instance the work landed in.
 *    Written onto the rule because the instance is not a durable witness — it
 *    can be reopened, archived or aged off a board — and a run record that
 *    forgot a success every time somebody touched the row would be worse
 *    than none.
 *  - **Stale files ONE review item.** When the rule's last success is older
 *    than its cadence allows (`schedule-run-record.ts` decides), the server
 *    files a review item on the rule row — the reader's Home queue is the
 *    only surface a person actually reads — and remembers it on the rule so
 *    the next tick, and every tick after, files nothing. The item is
 *    withdrawn the moment a run succeeds. Answering it also closes it, and an
 *    answered item is not filed again until the rule has succeeded and gone
 *    stale AGAIN: an item re-filed against the same silence the reader just
 *    acknowledged is the log nobody reads, wearing a queue's clothes.
 *
 * Both writes go through the store as the scheduler's own actor, the way the
 * stall escalation writes as the server: no session decided this, the board
 * did, and the quality judge that guards the route is skipped for the same
 * reason it is there — words generated from board state have no author to
 * send them back to.
 */
import { type TaskReviewItem, isReviewItemOpen, reviewWithdrawn } from '@claude-workspaces/core';
import {
  type LastInstance,
  type RunRecord,
  ageWord,
  runRecord,
} from '@claude-workspaces/core/schedule-run-record';
import type { TaskSchedule } from '@claude-workspaces/core/task-schedule';
import type { Task } from '@claude-workspaces/core/task-wire';
import { taskDeepLink } from './home-brief.ts';
import type { AddReviewItemResult, WithdrawReviewItemResult } from './review-items/types.ts';

/** What this module reaches in the store. `TaskStore` satisfies it. */
export interface RunRecordStore {
  getTask(taskId: string): Task | undefined;
  listReviewItems(taskId: string): TaskReviewItem[];
  addReviewItem(
    taskId: string,
    review: unknown,
    opts: { actor: { id: string; name: string; kind?: string } },
  ): AddReviewItemResult;
  withdrawReviewItem(
    taskId: string,
    reviewItemId: string,
    opts: { actor: { id: string; name: string; kind?: string }; reason?: string },
  ): WithdrawReviewItemResult;
  appendNote(
    taskId: string,
    input: { kind: 'turn' | 'denial' | 'status'; text: string; agent: string; ts: number },
  ): unknown;
  scheduleSave(workspaceId: string): void;
}

/** The rule's last instance as `runRecord` wants it, read off the store. */
export function lastInstanceOf(
  store: Pick<RunRecordStore, 'getTask'>,
  schedule: TaskSchedule,
): LastInstance | undefined {
  const id = schedule.state?.lastInstanceId;
  if (id === undefined) return undefined;
  const instance = store.getTask(id);
  if (!instance) return { id, status: 'gone' };
  if (instance.archivedAt !== undefined) {
    return { id, status: 'archived', closedAt: instance.archivedAt };
  }
  if (instance.status !== 'done') return { id, status: 'open' };
  let closedAt: number | undefined;
  for (const t of instance.transitions ?? []) if (t.to === 'done') closedAt = t.ts;
  return { id, status: 'done', closedAt: closedAt ?? instance.updatedAt };
}

/** The record for one rule row, as the server sees it. */
export function ruleRunRecord(
  store: Pick<RunRecordStore, 'getTask'>,
  schedule: TaskSchedule,
  now: number,
): RunRecord {
  return runRecord(schedule, lastInstanceOf(store, schedule), now);
}

/** The activity line a success leaves on the rule, naming where the work is. */
export function successNote(record: RunRecord, closedAt: number): string {
  const took =
    record.startedAt !== undefined
      ? `, ${ageWord(closedAt - record.startedAt)} after it started`
      : '';
  return `Run finished — ${record.instanceId ?? 'its instance'} done${took}`;
}

/**
 * The stale item's words. Exported so a test reads what a person would see.
 * Links are relative and inline, like every other server-written item.
 */
export function buildStaleReview(input: {
  workspaceId: string;
  rule: Task;
  record: RunRecord;
  now: number;
}): Record<string, unknown> {
  const { workspaceId, rule, record, now } = input;
  const title = rule.title.replace(/[[\]]/g, '');
  const since =
    record.lastSuccessAt !== undefined
      ? `Its last success was ${ageWord(now - record.lastSuccessAt)} ago`
      : `It has never succeeded since it was set ${ageWord(now - rule.schedule!.armedAt)} ago`;
  const cadence =
    record.intervalMs !== undefined ? `it runs every ${ageWord(record.intervalMs)}` : '';
  const last =
    record.instanceId === undefined
      ? 'No run has been filed.'
      : `Last run: [${title}](${taskDeepLink(workspaceId, record.instanceId)}) — ${
          record.status === 'open' ? 'still open' : record.status
        }, ${ageWord(record.ageMs)} ago.`;
  const headline = `“${title}” has not succeeded in ${ageWord(
    now - (record.lastSuccessAt ?? rule.schedule!.armedAt),
  )}`;
  const detail = [
    `${since}${cadence ? `, and ${cadence}` : ''}. A scheduled job that stops is the failure every peer reported, so the board is saying so rather than waiting.`,
    '',
    last,
    '',
    `Open [the rule](${taskDeepLink(workspaceId, rule.id)}) to see its activity. Answering this closes it; it is filed again only after the rule succeeds and then goes quiet again.`,
  ].join('\n');
  return { review_type: 'question', headline, detail };
}

export type RunRecordObserver = (row: { taskId: string; workspaceId: string }, now: number) => void;

/**
 * The per-rule pass, built once and called by the scheduler for every rule
 * on every tick. Mutates the live rule row and hands it to `scheduleSave`,
 * the store's own pattern, so the record lands in the same debounced write
 * as the cursor.
 */
export function observeRunRecord(
  store: RunRecordStore,
  actor: { id: string; name: string; kind?: string },
  report: (message: string) => void,
): RunRecordObserver {
  return (row, now) => {
    const rule = store.getTask(row.taskId);
    const schedule = rule?.schedule;
    if (!rule || !schedule) return;
    const state = schedule.state ?? {};
    const record = ruleRunRecord(store, schedule, now);
    let changed = false;

    if (record.lastSuccessAt !== undefined && record.lastSuccessAt !== state.lastSuccessAt) {
      state.lastSuccessAt = record.lastSuccessAt;
      changed = true;
      store.appendNote(rule.id, {
        kind: 'status',
        text: successNote(record, record.lastSuccessAt),
        agent: actor.name,
        ts: now,
      });
    }

    const filed = state.staleItem;
    const item =
      filed === undefined
        ? undefined
        : store.listReviewItems(rule.id).find((i) => i.id === filed.id);
    const open = item !== undefined && isReviewItemOpen(item) && !reviewWithdrawn(item.review);

    if (record.stale) {
      // Same stretch of silence, already filed — open, answered or withdrawn
      // by a person — is one item, not one per tick.
      const sameStretch = filed !== undefined && filed.forSuccessAt === record.lastSuccessAt;
      if (!open && !sameStretch) {
        const res = store.addReviewItem(
          rule.id,
          buildStaleReview({ workspaceId: row.workspaceId, rule, record, now }),
          { actor },
        );
        if (res.ok) {
          state.staleItem = {
            id: res.item.id,
            ...(record.lastSuccessAt !== undefined ? { forSuccessAt: record.lastSuccessAt } : {}),
          };
          changed = true;
          report(`[scheduler] ${rule.id} is stale; filed review item ${res.item.id}`);
        } else {
          report(`[scheduler] ${rule.id} is stale but the review item was refused: ${res.error}`);
        }
      }
    } else if (open && filed !== undefined) {
      const res = store.withdrawReviewItem(rule.id, filed.id, {
        actor,
        reason: 'a run succeeded',
      });
      if (res.ok) {
        state.staleItem = undefined;
        changed = true;
      } else report(`[scheduler] ${rule.id} recovered but the withdraw was refused: ${res.error}`);
    }

    if (changed) {
      schedule.state = state;
      store.scheduleSave(row.workspaceId);
    }
  };
}
