/**
 * A line written as needing a person (`needs: 'owner'`) files nothing until
 * its builder says it is ready — the builder's `owner` report is that signal.
 * This module is the reminder for the one moment a builder is likely to
 * forget it: every line an agent can meet is met, the task is still in
 * progress, and the person's line has not been handed over. The task cannot close, and nothing
 * on anybody's queue says why.
 *
 * WHO IS TOLD: the task's agent — the roster id of its assignee — and, when
 * that agent holds no stream, the board's lead. Never the person: the owner
 * asked not to be flagged before the work is ready (2026-09-14), and this is
 * exactly the state in which it is not yet ready for them.
 *
 * ONCE PER LINE WHILE IT STANDS. Told means delivered, the rule the held-item
 * filer nudge keeps: a nudge nobody received is not recorded, so a later
 * tick with somebody listening still sends it. A line that stops awaiting
 * (reported, met, removed, the task moved) is forgotten, so the same line
 * coming round again — a person's Not met sending it back — is told afresh.
 * In memory, like `filersTold`: a restart re-sends at most one per line.
 */
import type { DoneWhenLine } from '@claude-workspaces/core/done-when';
import type { Task } from '@claude-workspaces/core/task-wire';
import { isArchived } from '../task-fields.ts';

/** The addressed frame's event name. */
export const DONE_WHEN_READY_EVENT = 'workspace.done_when_ready';

/**
 * The person's lines still waiting on the builder's ready, on a task where
 * nothing else is: in progress, every line that does not need a person met,
 * and at least one that does neither handed over (`owner`) nor met. Empty
 * for every other task — including one with an ordinary line still open,
 * because then the builder has work left and the reminder would be early.
 */
export function linesAwaitingReady(task: Task): DoneWhenLine[] {
  if (task.status !== 'in-progress' || isArchived(task)) return [];
  const lines = task.doneWhen ?? [];
  if (lines.some((l) => l.needs !== 'owner' && l.verdict !== 'met')) return [];
  return lines.filter((l) => l.needs === 'owner' && l.verdict !== 'owner' && l.verdict !== 'met');
}

export interface DoneWhenReadyDeps {
  /** Every board, with its lead when it has one. */
  workspaces(): Array<{ id: string; leadAgentId?: string }>;
  tasks(workspaceId: string): Task[];
  /** The roster id of the task's assignee, when it is an agent. */
  ownerIdOf(task: Task): string | undefined;
  canReach(workspaceId: string, agentId: string): boolean;
  /** Returns how many streams took the frame. */
  send(
    workspaceId: string,
    agentId: string,
    frame: { event: string; [k: string]: unknown },
  ): number;
  /** The link that opens the task, when the server knows its own address. */
  taskUrl?(workspaceId: string, taskId: string): string;
}

export class DoneWhenReadyNudger {
  private readonly told = new Set<string>();

  constructor(private readonly deps: DoneWhenReadyDeps) {}

  /** One pass over every board. Returns how many nudges were delivered. */
  tick(now: number): number {
    let delivered = 0;
    const live = new Set<string>();
    for (const workspace of this.deps.workspaces()) {
      for (const task of this.deps.tasks(workspace.id)) {
        for (const line of linesAwaitingReady(task)) {
          const key = `${workspace.id}|${task.id}|${line.id}`;
          live.add(key);
          if (this.told.has(key)) continue;
          if (this.nudge(workspace, task, line, now)) {
            this.told.add(key);
            delivered++;
          }
        }
      }
    }
    for (const key of this.told) if (!live.has(key)) this.told.delete(key);
    return delivered;
  }

  private nudge(
    workspace: { id: string; leadAgentId?: string },
    task: Task,
    line: DoneWhenLine,
    now: number,
  ): boolean {
    const owner = this.deps.ownerIdOf(task);
    const to = [owner, workspace.leadAgentId].find(
      (id): id is string => id !== undefined && this.reachable(workspace.id, id),
    );
    if (to === undefined) return false;
    const url = this.deps.taskUrl?.(workspace.id, task.id);
    try {
      return (
        this.deps.send(workspace.id, to, {
          event: DONE_WHEN_READY_EVENT,
          workspaceId: workspace.id,
          taskId: task.id,
          title: task.title,
          lineId: line.id,
          line: line.text,
          ...(url !== undefined ? { url } : {}),
          ...(to !== owner ? { forAssignee: task.assignee } : {}),
          ts: now,
        }) > 0
      );
    } catch (err) {
      console.error('[done-when-ready] nudge failed:', err);
      return false;
    }
  }

  private reachable(workspaceId: string, agentId: string): boolean {
    try {
      return this.deps.canReach(workspaceId, agentId);
    } catch {
      return false;
    }
  }
}
