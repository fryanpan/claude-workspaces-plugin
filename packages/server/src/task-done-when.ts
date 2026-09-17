import { isReviewItemHeld, readTaskReviewItem, reviewWithdrawn } from '@claude-workspaces/core';
/**
 * The done-when verbs: the list somebody writes, the report a builder files
 * against it, and the owner's word on a line only a person can judge.
 *
 * One module because the three are one contract. The list is what the gate
 * reads, the report is the only door that can set a verdict of `met`, and the
 * owner's check is the same write with a different actor rule — split across
 * three files, the proof requirement would sit in one and the gate that trusts
 * it in another.
 *
 * It owns no state. Like `TaskNotesStore` and the other verb families it takes
 * a narrow persistence interface and mutates the LIVE row the store handed it.
 * The one thing it does that a note verb does not is close the ticket: when
 * the last line becomes met, `closeIfComplete` moves the row to done through
 * the SAME transition gate a person's click goes through, so the trail, the
 * event and the unblocking of dependants all happen exactly once and in one
 * place.
 */
import {
  DONE_WHEN_LINES_MAX,
  DONE_WHEN_VERDICTS,
  type DoneWhenLine,
  type DoneWhenProof,
  type DoneWhenVerdict,
  doneWhenComplete,
  firstOpenDoneWhen,
} from '@claude-workspaces/core/done-when';
import { proofReportsRefusal } from '@claude-workspaces/core/done-when-refusal';
import type { Task } from '@claude-workspaces/core/task-wire';
import { classifyActor } from './actor-identity.ts';
import { type DoneWhenInput, buildDoneWhenLines } from './task-done-when-input.ts';
import { readDoneWhenProof } from './task-helpers.ts';

/** An actor as every task verb takes one. */
export interface DoneWhenActor {
  id: string;
  name: string;
  kind?: string;
}

/** What a done-when verb may reach. Every row handed back is LIVE. */
export interface DoneWhenPersistence {
  getTask(taskId: string): Task | undefined;
  scheduleSave(workspaceId: string): void;
  /** Move the row to done — the ordinary transition gate, so the auto-close
   *  writes the same trail a person's click does. */
  transition(
    taskId: string,
    to: 'done',
    opts: { actor: DoneWhenActor; note?: string },
  ): { ok: boolean };
  /** Pin the one-liner that says which line closed the ticket. */
  appendNote(
    taskId: string,
    input: { kind: 'status'; text: string; agent: string; ts: number },
  ): unknown;
}

export {
  type DoneWhenInput,
  buildDoneWhenLines,
  parseDoneWhenInput,
} from './task-done-when-input.ts';

export type DoneWhenError =
  | 'not-found'
  | 'bad-lines'
  | 'too-many-lines'
  | 'bad-verdict'
  | 'unknown-line'
  | 'proof-required'
  | 'link-required'
  | 'absolute-url-required'
  | 'not-a-person'
  | 'not-yours'
  | 'task-done'
  | 'no-lines';

export type DoneWhenResult =
  | {
      ok: true;
      task: Task;
      lines: DoneWhenLine[];
      closed: boolean;
      /** Owner items this write filed or revised, not yet judged — set by
       *  `TaskStore`, which keeps the items in step with the lines. */
      ownerItemsToJudge?: string[];
    }
  | { ok: false; error: DoneWhenError; message: string };

/** One line of a builder's report. */
export interface DoneWhenReportInput {
  id: string;
  verdict: DoneWhenVerdict;
  proof?: DoneWhenProof[];
}

/**
 * The one line the Activity tab gets when the ticket closes itself.
 *
 * It names the lines THIS call closed rather than the last element of the
 * array: reporting line 1 when lines 2 and 3 were already met closes the
 * ticket on line 1, and a note that said "line 3" would be a false record of
 * what finished the work. A call that closed nothing by name — a list edit
 * that dropped the open lines — says so by saying nothing more.
 */
function closingNote(closedBy: readonly DoneWhenLine[]): string {
  const head = 'Done: every done-when line is met.';
  if (closedBy.length === 0) return head;
  if (closedBy.length === 1) return `${head} The last one open was "${closedBy[0]?.text}".`;
  return `${head} The last ones open were ${closedBy.map((l) => `"${l.text}"`).join(', ')}.`;
}

/** Is the open review item for this owner line being held by the gate? */
function ownerItemHeld(task: Task, lineId: string): boolean {
  return (task.reviews ?? []).some((raw) => {
    if (raw.doneWhenLineId !== lineId || reviewWithdrawn(raw.review)) return false;
    const item = readTaskReviewItem(raw);
    return item !== undefined && isReviewItemHeld(item);
  });
}

/** The done-when verbs. One per `TaskStore`, holding no state of its own. */
export class TaskDoneWhenStore {
  constructor(private readonly p: DoneWhenPersistence) {}

  /**
   * Write the whole list — the panel's add, edit and remove, and the create
   * and rewrite paths.
   *
   * Deliberately not three verbs. The list is ordered and the order is what a
   * reader counts by, so every edit is a rewrite of the sequence; an
   * `addLine` that appended and a `removeLine` that spliced would be two more
   * ways to get the order wrong, and the panel would still have to send the
   * whole list to reorder.
   */
  setLines(taskId: string, inputs: readonly DoneWhenInput[], actor: DoneWhenActor): DoneWhenResult {
    const task = this.p.getTask(taskId);
    if (!task) return { ok: false, error: 'not-found', message: 'no task with that id' };
    if (inputs.length > DONE_WHEN_LINES_MAX) {
      return {
        ok: false,
        error: 'too-many-lines',
        message: `a task may carry at most ${DONE_WHEN_LINES_MAX} done-when lines`,
      };
    }
    const lines = buildDoneWhenLines(inputs, task.doneWhen);
    // A FINISHED ticket may not be handed an open criterion. The panel hides
    // the list on a done task, but this verb is reachable from `rewrite_task`
    // and from REST, and a list written there would leave the row sitting in
    // Done with something still unmet — the one state this whole feature says
    // cannot exist. Editing the words of a met line, or clearing the list, is
    // still fine. Moving the ticket back out of Done is how you reopen the
    // question.
    const open = firstOpenDoneWhen(lines);
    if (open !== undefined && task.status === 'done') {
      return {
        ok: false,
        error: 'task-done',
        message: `"${task.title}" is already done, so "${open.text}" cannot be added as an open line — move the task out of Done first`,
      };
    }
    // The FIELD goes away when the list is emptied rather than becoming `[]`:
    // a stored empty array would read as "this task has criteria" everywhere
    // that asks whether the field is present.
    if (lines.length === 0) task.doneWhen = undefined;
    else task.doneWhen = lines;
    task.updatedAt = Date.now();
    this.p.scheduleSave(task.workspaceId);
    // Editing the list can complete it — the last OPEN line removed leaves a
    // list that is entirely met. Same close as a report's, through the same
    // door, so "the ticket moves itself" holds whichever write finished it.
    // No line is named: an edit that completes a list did it by REMOVING the
    // lines that were open, and naming one of the survivors would credit a
    // line nobody reported today.
    const closed = this.closeIfComplete(task, actor, []);
    return { ok: true, task, lines, closed };
  }

  /**
   * The builder's report: a verdict per line, with the proof behind it.
   *
   * Partial by design — a report names the lines it has something to say
   * about and leaves the rest alone, because a builder that has proved two of
   * four should not have to restate the two it has not reached.
   *
   * `met` WITHOUT PROOF IS REFUSED, and the refusal names the line. That is
   * the one rule this verb exists to enforce: a line asserted met with nothing
   * attached reads on the panel exactly like one somebody measured, and the
   * auto-close would then finish a ticket on an unproved claim.
   *
   * `baseUrl` is what a proof's board path ("/workspaces/…") is resolved
   * against; without one such a path is refused, naming the line.
   */
  report(
    taskId: string,
    entries: readonly DoneWhenReportInput[],
    actor: DoneWhenActor,
    baseUrl?: string,
  ): DoneWhenResult {
    const task = this.p.getTask(taskId);
    if (!task) return { ok: false, error: 'not-found', message: 'no task with that id' };
    const lines = task.doneWhen;
    if (!lines || lines.length === 0) {
      return {
        ok: false,
        error: 'no-lines',
        message: `"${task.title}" has no done-when lines to report on — file them on the task first, then report`,
      };
    }
    const byId = new Map(lines.map((l) => [l.id, l]));
    const proofs = new Map<string, DoneWhenProof[] | undefined>();
    // Validate the WHOLE report before writing any of it: a half-applied
    // report leaves the panel showing verdicts from a call the caller was
    // told had failed.
    for (const entry of entries) {
      const line = byId.get(entry.id);
      if (!line) {
        return {
          ok: false,
          error: 'unknown-line',
          message: `"${task.title}" has no done-when line ${entry.id} — read the task to get the current ids`,
        };
      }
      if (!DONE_WHEN_VERDICTS.includes(entry.verdict)) {
        return {
          ok: false,
          error: 'bad-verdict',
          message: `verdict must be one of ${DONE_WHEN_VERDICTS.join(', ')}`,
        };
      }
      // A line the builder HANDED OVER stays the person's to meet. Without
      // this the delegation is decorative: the same agent that wrote `owner`
      // could report the line met with proof of its own and the task would
      // close itself with a Verified chip, which is the proof rule and the
      // person's judgement both gone in one call. `not-met` and `unchecked`
      // are still reportable — a builder that later finds the line broken
      // should say so rather than leave it waiting on somebody.
      //
      // Except while the gate is HOLDING the line's item. A held check never
      // reached the person, and the commonest hold is "an agent could read
      // this itself" — so the builder's own report, with proof, is the fix
      // the hold asks for, and refusing it would leave the line nowhere.
      if (
        line.verdict === 'owner' &&
        entry.verdict === 'met' &&
        classifyActor(actor) !== 'person' &&
        !ownerItemHeld(task, line.id)
      ) {
        return {
          ok: false,
          error: 'not-yours',
          message: `"${line.text}" is waiting on the owner — you marked it theirs, so their Looks right is what meets it`,
        };
      }
      const { proof, unresolved } = readDoneWhenProof(entry.proof, baseUrl);
      if (unresolved !== undefined) {
        return {
          ok: false,
          error: 'absolute-url-required',
          message: `"${line.text}" has a proof url "${unresolved}" this server has no address to resolve — send an absolute http(s) url`,
        };
      }
      proofs.set(entry.id, proof);
      // A line handed to the owner carries a link, because the link is what
      // the reader opens: the first owner items reached the queue with none,
      // and the owner's answer was "Where's the mock?" (2026-09-14). Read off
      // the proof this report leaves on the line — new proof replaces the old.
      // A REFUSED check is the exception, and it is the whole reason the flag
      // exists: the agent was denied permission to run the thing, so there is
      // nothing for it to link — demanding a url would leave a line that
      // cannot be reported at all. What the reader opens is the line itself.
      if (
        entry.verdict === 'owner' &&
        !(proof ?? line.proof ?? []).some((p) => p.url || proofReportsRefusal(p))
      ) {
        return {
          ok: false,
          error: 'link-required',
          message: `"${line.text}" is handed to the owner with no link — attach proof with a url they can open (the mock, the page, the screenshot), or check it yourself and report it`,
        };
      }
      if (entry.verdict === 'met' && proof === undefined && (line.proof ?? []).length === 0) {
        return {
          ok: false,
          error: 'proof-required',
          message: `"${line.text}" is reported met with no proof — attach what you ran or what you looked at, or report it unchecked`,
        };
      }
    }
    // Which lines this call CLOSES, read before the write: the note must not
    // claim a line that was already met, and the array's last element is not
    // the same thing as the last one still open.
    const closedByThis = lines.filter(
      (l) => l.verdict !== 'met' && entries.some((e) => e.id === l.id && e.verdict === 'met'),
    );
    const ts = Date.now();
    for (const entry of entries) {
      const line = byId.get(entry.id);
      if (!line) continue;
      const proof = proofs.get(entry.id);
      line.verdict = entry.verdict;
      if (proof !== undefined) line.proof = proof;
      line.by = actor.name;
      line.at = ts;
    }
    task.updatedAt = ts;
    this.p.scheduleSave(task.workspaceId);
    const closed = this.closeIfComplete(task, actor, closedByThis);
    return { ok: true, task, lines: task.doneWhen ?? [], closed };
  }

  /**
   * The owner's word on one line: `Looks right` makes it met, `Not met` sends
   * it back.
   *
   * ONLY A PERSON. `owner` means "a test cannot answer this", so an agent
   * answering its own owner line would be the whole point of the state gone —
   * the same actor rule the review-item answer routes keep, asked the same way
   * (`classifyActor`), so the two surfaces cannot disagree about who counts as
   * a person.
   *
   * A person's `met` needs no proof: their word IS the evidence, which is why
   * the line was theirs to judge.
   */
  ownerCheck(
    taskId: string,
    lineId: string,
    verdict: 'met' | 'not-met',
    actor: DoneWhenActor,
  ): DoneWhenResult {
    const task = this.p.getTask(taskId);
    if (!task) return { ok: false, error: 'not-found', message: 'no task with that id' };
    if (classifyActor(actor) !== 'person') {
      return {
        ok: false,
        error: 'not-a-person',
        message:
          'only a person can answer a line marked for the owner — report it met with proof, or leave it to them',
      };
    }
    const line = (task.doneWhen ?? []).find((l) => l.id === lineId);
    if (!line) {
      return { ok: false, error: 'unknown-line', message: 'no done-when line with that id' };
    }
    // ONLY a line the builder handed over. This door takes a person's word
    // with no proof behind it, which is right for a line whose whole point is
    // that no test can answer it — and would be a way around the proof rule
    // on every other line. A reader who disagrees with a verdict says so on
    // the task; they do not overwrite it here.
    if (line.verdict !== 'owner') {
      return {
        ok: false,
        error: 'not-yours',
        message: `"${line.text}" is not waiting on you — only a line the builder marked for the owner is answered here`,
      };
    }
    if (verdict !== 'met' && verdict !== 'not-met') {
      return { ok: false, error: 'bad-verdict', message: 'verdict must be met or not-met' };
    }
    // The line was open by construction — the guard above let only `owner`
    // through, and `owner` is not `met` — so the owner's yes is what closed
    // it, and their no leaves it open.
    line.verdict = verdict;
    line.by = actor.name;
    line.at = Date.now();
    task.updatedAt = line.at;
    this.p.scheduleSave(task.workspaceId);
    const closed = this.closeIfComplete(task, actor, verdict === 'met' ? [line] : []);
    return { ok: true, task, lines: task.doneWhen ?? [], closed };
  }

  /**
   * Every line met and the row still open → move it to done, and say which
   * line closed it.
   *
   * Through the ordinary transition gate, so a row an enforced dependency
   * still blocks is NOT dragged closed behind that gate's back: the gate
   * refuses, this reports `closed: false`, and the ticket stays open with
   * every line met — which is the honest state and is visible on the panel.
   *
   * The note is one line on the Activity tab (`post_status`'s own kind), not
   * a comment: "the ticket closed itself" is where the work stands, and
   * comments are for asks and decisions.
   */
  private closeIfComplete(
    task: Task,
    actor: DoneWhenActor,
    closedBy: readonly DoneWhenLine[],
  ): boolean {
    if (!doneWhenComplete(task.doneWhen)) return false;
    if (task.status === 'done') return false;
    const moved = this.p.transition(task.id, 'done', {
      actor,
      note: 'every done-when line is met',
    });
    if (!moved.ok) return false;
    this.p.appendNote(task.id, {
      kind: 'status',
      text: closingNote(closedBy),
      agent: actor.name,
      ts: Date.now(),
    });
    return true;
  }
}
