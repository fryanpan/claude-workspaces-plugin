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
 * ONCE PER LINE UNTIL THE TASK CHANGES. Told means delivered, the rule the
 * held-item filer nudge keeps: a nudge nobody received is not recorded, so a
 * later tick with somebody listening still sends it. What is recorded is the
 * task's change stamp at the moment it was told — `updatedAt` (a line
 * reported, a transition) or its newest comment, whichever is later — and
 * the line is told again only once that stamp has moved. A line that stops
 * awaiting is forgotten, so a person's Not met sending it back is told
 * afresh. The record is persisted (`DONE_WHEN_READY_TOLD_FILENAME`): kept in
 * memory, every restart re-sent every standing line, and a day of deploys
 * woke one lead four times in ninety minutes over a line it could not move.
 *
 * NOTHING WHILE A WAIT IS DECLARED. A task carrying an unlapsed `declare_wait`
 * has said what it is waiting on, and the stall check already honours that;
 * this reminder does too. The line is neither told nor forgotten while the
 * wait stands, so a wait lapsing over a line already told stays quiet until
 * the task changes.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DoneWhenLine } from '@claude-workspaces/core/done-when';
import type { Task } from '@claude-workspaces/core/task-wire';
import { isArchived } from '../task-fields.ts';
import { externalWaitActive } from '../task-wait.ts';

/** The addressed frame's event name. */
export const DONE_WHEN_READY_EVENT = 'workspace.done_when_ready';

/** Where the told record lives, under the data dir. */
export const DONE_WHEN_READY_TOLD_FILENAME = 'done-when-ready-told.json';

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
  /** The newest comment on the task's own discussion, when there is one. */
  lastCommentAt?(task: Task): number | undefined;
  /** Where the told record is persisted. Absent keeps it in memory only. */
  toldPath?: string;
}

export class DoneWhenReadyNudger {
  /** Line key → the task's change stamp when it was told. */
  private readonly told: Map<string, number>;
  private lastPersisted: string | undefined;

  constructor(private readonly deps: DoneWhenReadyDeps) {
    this.told = loadTold(deps.toldPath);
    this.lastPersisted = this.serialize();
  }

  /** One pass over every board. Returns how many nudges were delivered. */
  tick(now: number): number {
    let delivered = 0;
    const live = new Set<string>();
    for (const workspace of this.deps.workspaces()) {
      for (const task of this.deps.tasks(workspace.id)) {
        const lines = linesAwaitingReady(task);
        if (lines.length === 0) continue;
        const waiting = externalWaitActive(task.externalWait, now);
        const stamp = waiting ? 0 : this.changeStamp(task);
        for (const line of lines) {
          const key = `${workspace.id}|${task.id}|${line.id}`;
          live.add(key);
          if (waiting) continue;
          const toldAt = this.told.get(key);
          if (toldAt !== undefined && stamp <= toldAt) continue;
          if (this.nudge(workspace, task, line, now)) {
            this.told.set(key, stamp);
            delivered++;
          }
        }
      }
    }
    for (const key of this.told.keys()) if (!live.has(key)) this.told.delete(key);
    this.save();
    return delivered;
  }

  /** The task's newest change a reader could act on: a field write
   *  (`updatedAt` — a report, a transition) or a comment on its thread. */
  private changeStamp(task: Task): number {
    let comment: number | undefined;
    try {
      comment = this.deps.lastCommentAt?.(task);
    } catch {
      comment = undefined;
    }
    return Math.max(task.updatedAt ?? 0, comment ?? 0);
  }

  private serialize(): string {
    const out: Record<string, number> = {};
    for (const key of [...this.told.keys()].sort()) out[key] = this.told.get(key) ?? 0;
    return `${JSON.stringify(out, null, 2)}\n`;
  }

  /** Never throws: this runs inside a timer tick. */
  private save(): void {
    const path = this.deps.toldPath;
    if (path === undefined) return;
    const next = this.serialize();
    if (next === this.lastPersisted) return;
    try {
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, next);
      renameSync(tmp, path);
      this.lastPersisted = next;
    } catch (err) {
      console.error('[done-when-ready] could not persist the told record:', err);
    }
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

/** A missing or unreadable record reads as empty: the failure direction is
 *  one repeat reminder, never a reminder suppressed for good. */
function loadTold(path: string | undefined): Map<string, number> {
  const told = new Map<string, number>();
  if (path === undefined) return told;
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (raw === null || typeof raw !== 'object') return told;
    for (const [key, value] of Object.entries(raw)) {
      if (typeof value === 'number' && Number.isFinite(value)) told.set(key, value);
    }
  } catch {
    // Absent on first boot; anything else is treated the same way.
  }
  return told;
}
