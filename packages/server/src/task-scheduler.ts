/**
 * The board starting a scheduled row at its time, so no session has to watch
 * the clock (docs/architecture/scheduled-tasks.md).
 *
 * A row carrying a `schedule` is the RULE, not the work. Each occurrence the
 * rule comes due for creates an ordinary task — the INSTANCE — in the rule's
 * own goal band, owned by the rule's owner, marked `recurrenceOf`. The rule
 * row itself never changes status: it is the thing that keeps producing work,
 * and a rule that read as `in-progress` would be a row nobody could ever
 * close.
 *
 * The arithmetic is not here. `@claude-workspaces/core/task-schedule` holds every
 * question about WHEN — the rule shapes, the timezone math, the collapse of a
 * missed run — as pure functions of an injected `now`. This file holds the
 * three things that arithmetic cannot be pure about: reading the board,
 * creating the instance, and writing the cursor back.
 *
 * ── Exactly once, across a restart ─────────────────────────────────────
 *
 * The guarantee the ticket asks for is that a rule "neither loses an
 * occurrence nor fires one twice", and it rests on two facts:
 *
 *  - **The cursor is the occurrence, not the wall clock.** `lastOccurrenceAt`
 *    records the instant the fire was FOR, so a catch-up long after downtime
 *    still lands on the right side of every comparison. An occurrence at or
 *    before it can never come due again (`nextOccurrence` is strictly-after);
 *    every later one still can.
 *  - **The instance and the cursor land in ONE write.** Both the rule row and
 *    the instance live in the same workspace sidecar, which is persisted
 *    write-then-rename. The tick creates the instance, advances the cursor,
 *    and records the activity as three in-memory mutations behind a single
 *    debounced save — so a crash inside that window loses BOTH, and the next
 *    boot re-fires the occurrence rather than duplicating it. There is no
 *    ordering of two separate writes that does better; there is one that does
 *    worse, which is why the cursor is committed the instant the create
 *    returns and not after the activity note.
 *
 * A create that is REFUSED (a retired board, a goal that has since been
 * deleted) leaves the cursor exactly where it was, so the occurrence is still
 * owed on the next tick. That is deliberate: a refusal is a condition
 * somebody fixes, and swallowing the occurrence would hide it.
 *
 * ── The seam later rows plug into ──────────────────────────────────────
 *
 * `tick()` returns what it fired. The Scheduled board section reads
 * `nextOccurrence` off the same rule; the missed-run policy reads
 * `DueOccurrence.missed`, already counted and already on the instance; the
 * run record reads the activity note this writes; and the wake path wakes
 * `instance.assignee`. None of them needs a second reading of when a row is
 * owed, which is the whole reason the arithmetic sits in `core`.
 */
import { type MissedRunOutcome, missedRunOutcome } from '@claude-workspaces/core/schedule-missed';
import {
  type DueOccurrence,
  type ScheduleCursor,
  type ScheduleState,
  type TaskSchedule,
  dueOccurrence,
} from '@claude-workspaces/core/task-schedule';
import type { Task } from '@claude-workspaces/core/task-wire';
import { type RunRecordStore, observeRunRecord } from './task-run-record.ts';
import type { BoardWorkspace, CreateTaskOpts, CreateTaskResult } from './tasks.ts';
import { isRetired } from './workspace-store.ts';

/**
 * How often the loop looks. Thirty seconds: the finest rule anybody writes in
 * a phrase is minutes, so a tick an order of magnitude under that makes the
 * lateness of a fire invisible, and the pass is a walk over rows already in
 * memory. Nothing here is a timer per rule — one loop reads them all, so the
 * cost does not grow with the number of schedules.
 */
export const SCHEDULER_TICK_DEFAULT_MS = 30_000;

/** Who a scheduled fire is attributed to. An agent rather than a person, for
 *  the same reason the park migration's actor is one: no human decided
 *  anything at this instant, and putting a person's name on it would credit
 *  them with a row they did not file. */
export const SCHEDULER_ACTOR = {
  id: 'agent-workspaces-scheduler',
  name: 'Claude Workspaces Scheduler',
  kind: 'agent',
} as const;

/** One rule row, as the loop needs to see it. */
export interface ScheduledRow {
  taskId: string;
  workspaceId: string;
  /** The rule and the scheduler's own bookkeeping. */
  schedule: TaskSchedule;
  /** What the rule cannot hold: whether its last instance has finished. */
  cursor: ScheduleCursor;
}

/** One occurrence this pass acted on. */
export interface FiredOccurrence {
  /** The RULE row. */
  taskId: string;
  /** The live instance: the one this occurrence created, or the open
   *  catch-up it folded into. Absent when the occurrence was skipped. */
  instanceId?: string;
  /** The occurrence's own instant — not when it fired. */
  at: number;
  /** Occurrences that got no row of their own out of this pass. */
  missed: number;
  /** What the missed-run policy made of it (`schedule-missed.ts`). */
  outcome: MissedRunOutcome['kind'];
}

export interface TaskSchedulerOptions {
  /** Every live rule row, rebuilt each tick. */
  rows: () => readonly ScheduledRow[];
  /** Create the live instance, flagged as a catch-up when it stands in for
   *  missed work. Returns its task id, or `undefined` when the create was
   *  refused — which leaves the occurrence owed. */
  createInstance: (row: ScheduledRow, due: DueOccurrence, catchUp: boolean) => string | undefined;
  /** Add `missed` more occurrences to the open catch-up row's count. */
  fold: (row: ScheduledRow, instanceId: string, missed: number) => void;
  /** Write the advanced cursor back onto the rule row. */
  commit: (row: ScheduledRow, state: ScheduleState) => void;
  /** Put one line in the rule row's activity. */
  record: (row: ScheduledRow, text: string) => void;
  /** Read the rule's last run back after the fire (`task-run-record.ts`). */
  observe?: (row: ScheduledRow, now: number) => void;
  /** The injected clock. The whole subsystem is driven by it — a test moves
   *  the number, never the wall clock. */
  now?: () => number;
  /** Where a refused or throwing fire is written. Defaults to `console.error`. */
  report?: (message: string) => void;
}

/**
 * The loop. Built by `createTaskScheduler` below in the server; constructed
 * directly with fakes in a unit test.
 */
export class TaskScheduler {
  private readonly opts: TaskSchedulerOptions;
  private readonly now: () => number;
  private readonly report: (message: string) => void;
  private timer: ReturnType<typeof setInterval> | null = null;
  private fired = 0;

  constructor(opts: TaskSchedulerOptions) {
    this.opts = opts;
    this.now = opts.now ?? Date.now;
    this.report = opts.report ?? ((message) => console.error(message));
  }

  /** One pass over every rule. Never throws — this runs on a timer, and a
   *  board it cannot read must not take the server down with it. */
  tick(): FiredOccurrence[] {
    let rows: readonly ScheduledRow[];
    try {
      rows = this.opts.rows();
    } catch (err) {
      this.report(`[scheduler] could not read the board: ${String(err)}`);
      return [];
    }
    const now = this.now();
    const out: FiredOccurrence[] = [];
    for (const row of rows) {
      try {
        const fire = this.fire(row, now);
        if (fire) out.push(fire);
        this.opts.observe?.(row, now);
      } catch (err) {
        // One bad rule must not stop the rules after it. The cursor is
        // untouched by a throw before the commit, so the occurrence is still
        // owed and the next tick tries again.
        this.report(`[scheduler] ${row.taskId} failed to fire: ${String(err)}`);
      }
    }
    return out;
  }

  /**
   * At most ONE occurrence per rule per pass — the collapse lives in
   * `dueOccurrence`, so a rule owed forty runs produces one instance carrying
   * the count, never forty rows or one row per tick.
   */
  private fire(row: ScheduledRow, now: number): FiredOccurrence | undefined {
    const due = dueOccurrence(row.schedule, now, row.cursor);
    if (!due) return undefined;
    const outcome = missedRunOutcome(row.schedule, due, now, row.cursor);
    const prev = row.schedule.state ?? {};
    const fired: FiredOccurrence = {
      taskId: row.taskId,
      at: due.at,
      missed: 0,
      outcome: outcome.kind,
    };

    // The two outcomes that file nothing. The cursor still advances — that is
    // what makes a skipped or folded occurrence spent rather than owed — and
    // the note is what a reader has instead of a row.
    if (outcome.kind === 'skip' || outcome.kind === 'fold') {
      if (outcome.kind === 'fold') {
        this.opts.fold(row, outcome.into, outcome.missed);
        fired.instanceId = outcome.into;
      }
      this.opts.commit(row, {
        ...prev,
        lastOccurrenceAt: due.at,
        missedTotal: (prev.missedTotal ?? 0) + outcome.missed,
        ...(outcome.kind === 'skip'
          ? { skippedTotal: (prev.skippedTotal ?? 0) + outcome.missed }
          : {}),
      });
      this.opts.record(
        row,
        outcome.kind === 'skip' ? skipNote(due) : foldNote(due, outcome.into, outcome.missed),
      );
      fired.missed = outcome.missed;
      return fired;
    }

    const catchUp = outcome.kind === 'catch-up';
    const instanceId = this.opts.createInstance(row, due, catchUp);
    if (instanceId === undefined) {
      this.report(
        `[scheduler] ${row.taskId} is owed ${new Date(due.at).toISOString()} but the instance was refused`,
      );
      return undefined;
    }
    // Committed BEFORE the activity note: an exception writing the note must
    // not leave a fired occurrence uncommitted, which is the one ordering
    // that could fire it twice.
    this.opts.commit(row, {
      ...prev,
      lastOccurrenceAt: due.at,
      lastFiredAt: now,
      lastInstanceId: instanceId,
      fireCount: (prev.fireCount ?? 0) + 1,
      missedTotal: (prev.missedTotal ?? 0) + due.missed,
    });
    this.opts.record(row, occurrenceNote(due, instanceId, catchUp));
    this.fired++;
    fired.instanceId = instanceId;
    fired.missed = due.missed;
    return fired;
  }

  start(tickMs: number = SCHEDULER_TICK_DEFAULT_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), tickMs);
    this.timer.unref?.();
  }

  /** Idempotent: a shutdown path that already stopped must not throw. */
  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  running(): boolean {
    return this.timer !== null;
  }

  /** How many occurrences this process has fired. A test surface, and the
   *  number an ops readout would show. */
  firedCount(): number {
    return this.fired;
  }
}

// ── Wiring the loop to a real board ───────────────────────────────────────
//
// Everything below reads or writes a `TaskStore` through the narrowest shape
// it actually needs — the same seam `task-persistence.ts` uses, so the store
// keeps its signatures and a test can drive the real thing.

/** What the wiring reaches in the store. `TaskStore` satisfies it. */
export interface SchedulerStore extends RunRecordStore {
  listWorkspaces(): BoardWorkspace[];
  listTasks(workspaceId: string): Task[];
  getTask(taskId: string): Task | undefined;
  createTask(workspaceId: string, opts: CreateTaskOpts): CreateTaskResult;
  appendNote(
    taskId: string,
    input: { kind: 'turn' | 'denial' | 'status'; text: string; agent: string; ts: number },
  ): unknown;
  scheduleSave(workspaceId: string): void;
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

/** How an occurrence reads in the rule row's activity. One line, naming the
 *  occurrence it was for and the instance it produced, because a catch-up
 *  fires long after the instant it stands for and a reader has to be able to
 *  tell those two apart. */
export function occurrenceNote(due: DueOccurrence, instanceId: string, catchUp = false): string {
  const when = new Date(due.at).toISOString();
  const stood = due.missed > 0 ? `, standing in for ${due.missed} missed` : '';
  const head = catchUp ? 'Catch-up for missed occurrence' : 'Scheduled occurrence';
  return `${head} ${when}${stood} — started ${instanceId}`;
}

/** The skip policy declined the work: which occurrence, how many with it. */
export function skipNote(due: DueOccurrence): string {
  const when = new Date(due.at).toISOString();
  const more = due.missed > 0 ? ` and ${due.missed} before it` : '';
  return `Skipped missed occurrence ${when}${more} — the rule skips if missed`;
}

/** An open catch-up row took this occurrence too. */
export function foldNote(due: DueOccurrence, instanceId: string, missed: number): string {
  const when = new Date(due.at).toISOString();
  const more = missed > 1 ? ` and ${missed - 1} before it` : '';
  return `Occurrence ${when}${more} folded into open catch-up ${instanceId}`;
}

/**
 * Build the loop over a real store.
 *
 * The instance is created through `createTask`, the SAME door every other
 * filing path uses, rather than by minting a row here — so its owner, its
 * goal band, its ordering and its `task.created` event all behave exactly as
 * a row somebody filed by hand. That is the difference between a scheduled
 * row appearing on the board and a scheduled row appearing on the board
 * correctly, and it is why `CreateTaskOpts` grew `recurrenceOf` instead.
 */
export function createTaskScheduler(
  store: SchedulerStore,
  opts: { now?: () => number; report?: (message: string) => void } = {},
): TaskScheduler {
  const clock = opts.now ?? Date.now;
  return new TaskScheduler({
    ...(opts.now !== undefined ? { now: opts.now } : {}),
    ...(opts.report !== undefined ? { report: opts.report } : {}),
    rows: () => scheduledRows(store),
    createInstance: (row, due, catchUp) => {
      const rule = store.getTask(row.taskId);
      if (!rule) return undefined;
      const res = store.createTask(row.workspaceId, {
        title: rule.title,
        ...(rule.body !== undefined ? { body: rule.body } : {}),
        // The rule's owner owns every instance of it. The wake path (a later
        // row) wakes this name; a scheduled row with nobody on it would be a
        // run nobody is answerable for.
        assignee: rule.assignee,
        ...(rule.assigneeKind !== undefined ? { assigneeKind: rule.assigneeKind } : {}),
        // Explicit, so the instance is a PLACED row rather than one that fell
        // into Backlog unjudged — the rule's band is a judgement somebody
        // already made.
        goal: rule.goal,
        ...(rule.needs !== undefined ? { needs: rule.needs } : {}),
        actor: SCHEDULER_ACTOR,
        recurrenceOf: {
          taskId: row.taskId,
          occurrenceAt: due.at,
          ...(due.missed > 0 ? { missed: due.missed } : {}),
          // The FLAG: the board draws a catch-up differently from an
          // ordinary run, and the cursor reads it back as the lock.
          ...(catchUp ? { catchUp: true as const } : {}),
        },
      });
      return res.ok ? res.task.id : undefined;
    },
    fold: (row, instanceId, missed) => {
      // The open catch-up's own count grows, so the row keeps saying how
      // much it stands in for. Same debounced save as the cursor commit.
      const instance = store.getTask(instanceId);
      if (!instance?.recurrenceOf) return;
      instance.recurrenceOf.missed = (instance.recurrenceOf.missed ?? 0) + missed;
      instance.updatedAt = clock();
      store.scheduleSave(row.workspaceId);
    },
    commit: (row, state) => {
      // The LIVE row, mutated in place and handed to `scheduleSave` — the
      // store's own pattern, and what puts this write in the same debounced
      // save as the instance created a moment ago. See the header.
      const rule = store.getTask(row.taskId);
      if (!rule?.schedule) return;
      rule.schedule.state = state;
      store.scheduleSave(row.workspaceId);
    },
    observe: observeRunRecord(store, SCHEDULER_ACTOR, opts.report ?? console.error),
    record: (row, text) => {
      store.appendNote(row.taskId, {
        kind: 'status',
        text,
        agent: SCHEDULER_ACTOR.name,
        ts: clock(),
      });
    },
  });
}

// ── Setting a rule ────────────────────────────────────────────────────────

export type SetScheduleResult =
  | { ok: true; task: Task; schedule?: TaskSchedule }
  | { ok: false; error: 'not-found' };

/**
 * Store or clear the rule on a row. The one writer, so the phrase editor, the
 * REST route and any later MCP verb all arm a schedule the same way.
 *
 * **The cursor is kept only when the rule is unchanged.** Re-arming the same
 * rule — the phrase editor rewriting it, a timezone edit — must not replay
 * history, and changing the rule must not let the OLD rule's last occurrence
 * act as a floor for a new one that means something different. Comparing the
 * rules is what tells those two apart; `armedAt` is the floor in the second
 * case, which is why a fresh rule can never fire for the past.
 */
export function setTaskSchedule(
  store: Pick<SchedulerStore, 'getTask' | 'scheduleSave'>,
  taskId: string,
  schedule: TaskSchedule | null,
): SetScheduleResult {
  const task = store.getTask(taskId);
  if (!task) return { ok: false, error: 'not-found' };
  if (schedule === null) {
    // The rule is removed; nothing else about the row is. Clearing a schedule
    // is not a delete of the row's history — the activity notes each fire
    // wrote stay exactly where they are.
    task.schedule = undefined;
    task.updatedAt = Date.now();
    store.scheduleSave(task.workspaceId);
    return { ok: true, task };
  }
  const prior = task.schedule;
  const sameRule =
    prior !== undefined && JSON.stringify(prior.rule) === JSON.stringify(schedule.rule);
  const next: TaskSchedule = {
    ...schedule,
    ...(sameRule && prior.state !== undefined ? { state: prior.state } : {}),
  };
  task.schedule = next;
  task.updatedAt = Date.now();
  store.scheduleSave(task.workspaceId);
  return { ok: true, task, schedule: next };
}
