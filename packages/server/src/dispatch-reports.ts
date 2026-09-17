/**
 * A builder's ONE closing report on the build it just finished, as a board
 * record rather than as prose in a chat message.
 *
 * WHY IT IS DATA. A dispatch ends with the builder saying what it shipped —
 * the PR, the commit that PR's checks actually ran on, which gates passed, and
 * what it found against each done-when line. Until now that arrived only as
 * the builder's closing message, which the lead had to read and summarise. Two
 * failure modes came with that: a report the harness dropped left the lead
 * guessing whether the build finished, and a builder nudged for a missing
 * report often sent its whole closing message a second time, which read as new
 * work. Both are questions about STATE, and neither can be answered by reading
 * prose. So the report is submitted once, validated, and kept against the task.
 *
 * Shape decisions, each with its reason:
 *
 * - **A sibling of `dispatch-registry.ts`, not a member of it.** The registry
 *   is about a lane being HELD — a worktree, a watcher, a slot against the
 *   cap — and it closes a dispatch the moment the worktree or the task is
 *   gone. A report is the opposite clock: it is written at the end and has to
 *   outlive the dispatch it describes, because the lead reads it after the
 *   builder has stopped. Folding it in would also have taken that file past
 *   the 500-line budget with two unrelated lifetimes in one class.
 * - **No open dispatch is required.** A builder that closed its own dispatch
 *   before reporting, or whose row the board already moved to done (which
 *   closes the dispatch in the registry), must still be able to file. The
 *   report is keyed on the TASK, and the board's membership check on the path
 *   is what ties it to a board.
 * - **A repeat is silent, and silence is the STORE's decision.** The second
 *   report for one build is recorded (its wording may be better than the
 *   first) and answered with `repeat: true`, but no event is emitted — so
 *   nothing reaches the SSE fan-out and no attached session spends a turn on
 *   it. Filtering downstream would mean each relay learning the rule, and a
 *   frame the server already sent cannot be unsent for a session on an older
 *   bundle.
 * - **"The same build" is the task plus the head commit.** A builder that
 *   reworks and commits again has a genuinely new build and SHOULD wake the
 *   lead; one that re-sends the same report has not. Keying on the task alone
 *   would silence the rework, and keying on the report's whole content would
 *   let a one-word edit ring the bell again.
 * - **Every part is required, and a refusal names the part.** The whole value
 *   of the record is that the lead does not have to ask follow-up questions.
 *   A report with no commit, no checks, or a verdict on four of five lines is
 *   worse than none, because it reads as complete. The refusal is a 400 whose
 *   `error` is a stable slug and whose `message` names what is missing, so a
 *   builder can fix and resend without reading this file.
 * - **One JSON file rewritten whole via write-temp-then-rename**, the
 *   `dispatch-registry.ts` / `agent-watches.ts` pattern, bounded by a ring cap.
 *   Reports are coordination state a lead reads within the day, not user
 *   content: the oldest falling off the end is correct, and no soft-delete
 *   concern applies.
 * - **A corrupt file is renamed aside, never overwritten** — same reason the
 *   registry gives: losing the set is recoverable, destroying the evidence of
 *   what went wrong is not.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DONE_WHEN_VERDICTS, type DoneWhenVerdict } from '@claude-workspaces/core/done-when';
import { isValidDispatchTaskId } from './dispatch-registry.ts';
import type { DispatchReportedEvent, TaskActor, TaskStoreEvent } from './tasks.ts';

const FILENAME = 'dispatch-reports.json';
const FORMAT_VERSION = 1;

/** How many reports are kept. A board runs a handful of builders a day, so
 *  this is weeks of history and a few tens of KB. */
const RING_CAP = 200;

/** Longest a check name may be — long enough for `check:meeting-smoke`. */
const CHECK_NAME_MAX = 120;
/** Longest free text (a check's detail, a verdict's note) may be. */
const DETAIL_MAX = 500;
/** Ceilings on the two lists, matching `DONE_WHEN_LINES_MAX`. */
const LIST_MAX = 50;

/** A gate's outcome as a builder reports it. `held` is the one a local
 *  `bun run verify` produces for a browser-gated member: it did not run, and
 *  that is neither a pass nor a failure. */
export type DispatchCheckStatus = 'pass' | 'fail' | 'held';

const CHECK_STATUSES: readonly DispatchCheckStatus[] = ['pass', 'fail', 'held'];

/** One gate and what it did. */
export interface DispatchCheck {
  name: string;
  status: DispatchCheckStatus;
  /** The line a reader would otherwise have to open the log for. */
  detail?: string;
}

/** One done-when line and the builder's verdict on it. The vocabulary is the
 *  board's own (`DoneWhenVerdict`) rather than a second one invented here, so
 *  a report and a `report_done_when` call cannot disagree about what `owner`
 *  or `unchecked` mean. */
export interface DispatchDoneWhenVerdict {
  id: string;
  verdict: DoneWhenVerdict;
  /** Why — the proof, or why the line could not be checked. Required: a bare
   *  `unchecked` is the empty report this record exists to stop. */
  note: string;
}

/** What is kept, and what a reader gets back. */
export interface DispatchReport {
  taskId: string;
  workspaceId: string;
  /** The pull request this build is on. */
  prNumber: number;
  /** The commit the checks below actually ran on, lowercased. */
  headCommit: string;
  checks: DispatchCheck[];
  doneWhen: DispatchDoneWhenVerdict[];
  /** Who reported, when the caller named itself. */
  agentName?: string;
  actor?: TaskActor;
  /** When this submission arrived (ms epoch). */
  at: number;
  /** 1 for the first report on this build, 2+ for each repeat. */
  attempt: number;
}

export type DispatchReportError =
  | 'bad-task-id'
  | 'missing-pr-number'
  | 'missing-head-commit'
  | 'missing-checks'
  | 'bad-check'
  | 'missing-done-when'
  | 'missing-done-when-id'
  | 'bad-done-when-verdict'
  | 'missing-done-when-note'
  | 'missing-done-when-line'
  | 'unknown-done-when-line';

export type SubmitResult =
  | { ok: true; report: DispatchReport; repeat: boolean }
  | { ok: false; error: DispatchReportError; message: string };

/** What a caller sends. Every field is `unknown` because it arrives off a
 *  request body and is validated here — one definition of a usable report,
 *  rather than one at the route and another at the MCP verb. */
export interface DispatchReportInput {
  workspaceId: string;
  taskId: unknown;
  prNumber: unknown;
  headCommit: unknown;
  checks: unknown;
  doneWhen: unknown;
  agentName?: unknown;
  actor?: TaskActor;
}

/** Just enough of the task store to wake the lead. Narrower than `TaskStore`
 *  so the unit test needs no store at all. */
export interface DispatchReportSink {
  emit(event: TaskStoreEvent): void;
}

/** One done-when line as this module needs to see it. */
export interface DoneWhenLineRef {
  id: string;
  text: string;
}

export interface DispatchReportStoreOptions {
  dataDir: string;
  now?: () => number;
  /** Where the wake goes. Omitted, nothing is emitted and the store is a
   *  plain record — which is what the unit test drives. */
  sink?: DispatchReportSink;
  /**
   * The done-when lines a task carries, so a report missing a verdict on one
   * of them can be refused by NAME. Absent (a unit test, a task with no
   * lines), the completeness check does not run and any non-empty list of
   * verdicts is accepted.
   */
  doneWhenLinesOf?: (taskId: string) => readonly DoneWhenLineRef[];
}

interface FileShape {
  version: number;
  reports: DispatchReport[];
}

/** The key that decides whether two reports are about the same build. */
function buildKey(taskId: string, headCommit: string): string {
  return `${taskId} ${headCommit}`;
}

/** A git object name. Seven is the shortest abbreviation git itself prints;
 *  forty is a full sha. Anything else is not a commit. */
const COMMIT_RE = /^[0-9a-f]{7,40}$/i;

function trimmed(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (text.length === 0) return undefined;
  return text.slice(0, max);
}

/** Validate the checks list, or say what is wrong with it. */
function readChecks(
  raw: unknown,
):
  | { ok: true; checks: DispatchCheck[] }
  | { ok: false; error: DispatchReportError; message: string } {
  if (!Array.isArray(raw) || raw.length === 0) {
    return {
      ok: false,
      error: 'missing-checks',
      message: 'checks: name at least one gate you ran and what it did',
    };
  }
  const checks: DispatchCheck[] = [];
  for (const [i, entry] of raw.slice(0, LIST_MAX).entries()) {
    const rec = (entry ?? {}) as { name?: unknown; status?: unknown; detail?: unknown };
    const name = trimmed(rec.name, CHECK_NAME_MAX);
    if (name === undefined) {
      return { ok: false, error: 'bad-check', message: `checks[${i}]: needs a name` };
    }
    const status = rec.status;
    if (typeof status !== 'string' || !CHECK_STATUSES.includes(status as DispatchCheckStatus)) {
      return {
        ok: false,
        error: 'bad-check',
        message: `checks[${i}] ("${name}"): status must be one of ${CHECK_STATUSES.join(', ')}`,
      };
    }
    const detail = trimmed(rec.detail, DETAIL_MAX);
    checks.push({
      name,
      status: status as DispatchCheckStatus,
      ...(detail !== undefined ? { detail } : {}),
    });
  }
  return { ok: true, checks };
}

/** Validate the verdict list's own shape. Completeness against the task's
 *  lines is a separate question, asked by the store, which is the only side
 *  that can see them. */
function readVerdicts(
  raw: unknown,
):
  | { ok: true; doneWhen: DispatchDoneWhenVerdict[] }
  | { ok: false; error: DispatchReportError; message: string } {
  if (!Array.isArray(raw) || raw.length === 0) {
    return {
      ok: false,
      error: 'missing-done-when',
      message: 'doneWhen: give a verdict on each done-when line',
    };
  }
  const doneWhen: DispatchDoneWhenVerdict[] = [];
  for (const [i, entry] of raw.slice(0, LIST_MAX).entries()) {
    const rec = (entry ?? {}) as { id?: unknown; verdict?: unknown; note?: unknown };
    const id = trimmed(rec.id, CHECK_NAME_MAX);
    if (id === undefined) {
      return {
        ok: false,
        error: 'missing-done-when-id',
        message: `doneWhen[${i}]: needs the done-when line's id`,
      };
    }
    const verdict = rec.verdict;
    if (typeof verdict !== 'string' || !DONE_WHEN_VERDICTS.includes(verdict as DoneWhenVerdict)) {
      return {
        ok: false,
        error: 'bad-done-when-verdict',
        message: `doneWhen[${i}] (${id}): verdict must be one of ${DONE_WHEN_VERDICTS.join(', ')}`,
      };
    }
    const note = trimmed(rec.note, DETAIL_MAX);
    if (note === undefined) {
      return {
        ok: false,
        error: 'missing-done-when-note',
        message: `doneWhen[${i}] (${id}): needs a note saying what you measured, or why you could not`,
      };
    }
    doneWhen.push({ id, verdict: verdict as DoneWhenVerdict, note });
  }
  return { ok: true, doneWhen };
}

export class DispatchReportStore {
  private readonly path: string;
  private readonly now: () => number;
  private readonly sink: DispatchReportSink | undefined;
  private readonly doneWhenLinesOf: (taskId: string) => readonly DoneWhenLineRef[];
  /** Newest last, so the ring drops from the front. */
  private reports: DispatchReport[] = [];
  /** Set when the file on disk was unreadable and moved aside. */
  readonly loadError: string | null = null;

  constructor(opts: DispatchReportStoreOptions) {
    this.path = join(opts.dataDir, FILENAME);
    this.now = opts.now ?? Date.now;
    this.sink = opts.sink;
    this.doneWhenLinesOf = opts.doneWhenLinesOf ?? (() => []);
    if (!existsSync(this.path)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<FileShape>;
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.reports)) {
        throw new Error('missing "reports" array');
      }
      this.reports = parsed.reports.filter(
        (r): r is DispatchReport =>
          r !== null &&
          typeof r === 'object' &&
          typeof r.taskId === 'string' &&
          typeof r.headCommit === 'string' &&
          Array.isArray(r.checks) &&
          Array.isArray(r.doneWhen),
      );
    } catch (err) {
      const aside = `${this.path}.corrupt-${this.now()}`;
      try {
        renameSync(this.path, aside);
      } catch {
        // If even the rename fails the next save overwrites; loadError still
        // says what happened.
      }
      this.loadError = `${err instanceof Error ? err.message : String(err)} (moved to ${aside})`;
    }
  }

  /**
   * Take one report, or refuse it naming what is missing.
   *
   * The wake is emitted here and only for a first report — see the header. A
   * repeat still lands in the record, because the second telling is often the
   * clearer one and the lead reads the record, not the frame.
   */
  submit(input: DispatchReportInput): SubmitResult {
    if (!isValidDispatchTaskId(input.taskId)) {
      return { ok: false, error: 'bad-task-id', message: 'taskId: not a usable task id' };
    }
    const taskId = input.taskId;
    const prNumber = input.prNumber;
    if (typeof prNumber !== 'number' || !Number.isInteger(prNumber) || prNumber <= 0) {
      return {
        ok: false,
        error: 'missing-pr-number',
        message: 'prNumber: give the pull request number this build is on',
      };
    }
    const commit = trimmed(input.headCommit, 64);
    if (commit === undefined || !COMMIT_RE.test(commit)) {
      return {
        ok: false,
        error: 'missing-head-commit',
        message: 'headCommit: give the commit sha the checks ran on',
      };
    }
    const headCommit = commit.toLowerCase();
    const checks = readChecks(input.checks);
    if (!checks.ok) return { ok: false, error: checks.error, message: checks.message };
    const verdicts = readVerdicts(input.doneWhen);
    if (!verdicts.ok) return { ok: false, error: verdicts.error, message: verdicts.message };
    const complete = this.checkCompleteness(taskId, verdicts.doneWhen);
    if (complete) return complete;

    const key = buildKey(taskId, headCommit);
    const previous = this.reports.filter((r) => buildKey(r.taskId, r.headCommit) === key);
    const repeat = previous.length > 0;
    const agentName = trimmed(input.agentName, CHECK_NAME_MAX);
    const report: DispatchReport = {
      taskId,
      workspaceId: input.workspaceId,
      prNumber,
      headCommit,
      checks: checks.checks,
      doneWhen: verdicts.doneWhen,
      ...(agentName !== undefined ? { agentName } : {}),
      ...(input.actor ? { actor: input.actor } : {}),
      at: this.now(),
      attempt: previous.length + 1,
    };
    this.reports.push(report);
    if (this.reports.length > RING_CAP) this.reports = this.reports.slice(-RING_CAP);
    this.save();
    // The one line that makes a repeat silent. Nothing downstream filters —
    // no event is built at all, so the fan-out never sees one.
    if (!repeat) this.emit(report);
    return { ok: true, report, repeat };
  }

  /** Every report on one task, newest first. */
  forTask(taskId: string): DispatchReport[] {
    return this.reports.filter((r) => r.taskId === taskId).sort((a, b) => b.at - a.at);
  }

  /** Every report on one board, newest first. */
  forWorkspace(workspaceId: string): DispatchReport[] {
    return this.reports.filter((r) => r.workspaceId === workspaceId).sort((a, b) => b.at - a.at);
  }

  /**
   * Refuse a report that leaves one of the task's own done-when lines without
   * a verdict, or that names a line the task does not have — naming the line
   * either way, because "which one" is the only question the builder then has.
   */
  private checkCompleteness(
    taskId: string,
    doneWhen: readonly DispatchDoneWhenVerdict[],
  ): { ok: false; error: DispatchReportError; message: string } | undefined {
    const lines = this.doneWhenLinesOf(taskId);
    if (lines.length === 0) return undefined;
    const known = new Map(lines.map((l) => [l.id, l.text]));
    const reported = new Set(doneWhen.map((v) => v.id));
    for (const v of doneWhen) {
      if (known.has(v.id)) continue;
      return {
        ok: false,
        error: 'unknown-done-when-line',
        message: `doneWhen: ${v.id} is not a done-when line on ${taskId}`,
      };
    }
    const missing = lines.filter((l) => !reported.has(l.id));
    if (missing.length === 0) return undefined;
    const named = missing.map((l) => `${l.id} ("${l.text}")`).join(', ');
    return {
      ok: false,
      error: 'missing-done-when-line',
      message: `doneWhen: no verdict on ${named}`,
    };
  }

  /** The wake. Counts rather than the lists themselves: the frame is one line
   *  in a reader's context, and the record is where the detail is read. */
  private emit(report: DispatchReport): void {
    if (!this.sink) return;
    const event: DispatchReportedEvent = {
      type: 'dispatch.reported',
      workspaceId: report.workspaceId,
      taskId: report.taskId,
      prNumber: report.prNumber,
      headCommit: report.headCommit,
      checksTotal: report.checks.length,
      checksFailed: report.checks.filter((c) => c.status === 'fail').length,
      checksHeld: report.checks.filter((c) => c.status === 'held').length,
      doneWhenTotal: report.doneWhen.length,
      doneWhenMet: report.doneWhen.filter((v) => v.verdict === 'met').length,
      ...(report.agentName !== undefined ? { agentName: report.agentName } : {}),
      ...(report.actor ? { actor: report.actor } : {}),
      ts: report.at,
    };
    try {
      this.sink.emit(event);
    } catch (err) {
      // The record is already written. A wake that could fail the submission
      // would mean a builder retrying — and its retry would then be a repeat,
      // which is silent, so the lead would never hear about the build at all.
      console.error('[dispatch] failed to emit dispatch.reported:', err);
    }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      writeFileSync(
        tmp,
        `${JSON.stringify({ version: FORMAT_VERSION, reports: this.reports }, null, 2)}\n`,
      );
      renameSync(tmp, this.path);
    } catch (err) {
      // Same trade the registry makes: the in-memory set is still right, and
      // a full disk must not turn a filed report into an error the builder
      // would retry (and have silenced as a repeat).
      console.error('[dispatch] failed to persist dispatch reports:', err);
    }
  }
}
