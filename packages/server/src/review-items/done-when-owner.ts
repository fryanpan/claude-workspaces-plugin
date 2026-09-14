import { reviewWithdrawn } from '@claude-workspaces/core';
/**
 * A done-when line marked `owner` is a question for a person, so it is a
 * review item on their queue.
 *
 * Before this, `owner` drew two buttons on the task page and nothing else: a
 * reader working from Home never saw the line, and seven such lines across six
 * open tasks were found waiting on somebody who had no item for any of them
 * (2026-09-14). This module keeps one open item per owner line and turns the
 * item's answer into the line's verdict — `Looks right` meets the line, any
 * other answer leaves it not met with the reader's words on the task.
 *
 * FILED BY THE SERVER, NOT THROUGH THE QUALITY GATE. The words come from a
 * fixed template over the line and its proof, so a judge could only hold the
 * template, and a hold is addressed back to a filer who revises — there is no
 * filer here to revise. Same reasoning as the board's stall escalation, which
 * files through `addReviewItem` for the same reason.
 *
 * It holds no state. The link from item to line is `doneWhenLineId` on the
 * stored item, so `sync` is idempotent by reading the row: a line with an
 * open linked item gets nothing, which is what makes the boot backfill safe to
 * run on every start.
 */
import type { DoneWhenLine } from '@claude-workspaces/core/done-when';
import type { StoredReviewItem, Task } from '@claude-workspaces/core/task-wire';
import { classifyActor } from '../actor-identity.ts';

/** The option that meets the line. Every other answer leaves it not met. */
export const OWNER_CHECK_MET = 'looks-right';
export const OWNER_CHECK_NOT_MET = 'not-met';

/** Who the item is filed as when the line does not say who handed it over.
 *  Deliberately NOT the stall escalation's name: the stall loop skips that
 *  name as "not the row's ask", and an owner check is exactly the row's ask. */
export const OWNER_CHECK_FILER = 'Done-when check';

type Actor = { id: string; name: string; kind?: string };

export interface OwnerItemDeps {
  getTask(taskId: string): Task | undefined;
  addReviewItem(
    taskId: string,
    review: unknown,
    opts: { actor: Actor; doneWhenLineId: string },
  ): { ok: true; item: { id: string } } | { ok: false; error: string };
  withdrawReviewItem(
    taskId: string,
    reviewItemId: string,
    opts: { actor: Actor; reason: string },
  ): { ok: boolean };
  ownerCheck(
    taskId: string,
    lineId: string,
    verdict: 'met' | 'not-met',
    actor: Actor,
  ): { ok: boolean };
  appendNote(
    taskId: string,
    input: { kind: 'status'; text: string; agent: string; ts: number },
  ): unknown;
}

const SERVER_ID = 'agent-workspaces-server';

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** The item for one owner line: the existing decision card with two options. */
export function ownerCheckReview(task: Task, line: DoneWhenLine): unknown {
  const proof = (line.proof ?? []).slice(0, 3).map((p) => {
    const label = p.text.replace(/[[\]]/g, '');
    return p.url && /^https?:\/\//.test(p.url) ? `[${label}](${p.url})` : label;
  });
  const handedBy = line.by ? `${line.by} marked this line of "${task.title}" for you` : '';
  const detail = [
    handedBy || `A line of "${task.title}" is waiting on you`,
    proof.length > 0 ? `. Proof: ${proof.join('; ')}.` : ' — no proof is attached.',
    ' Looks right marks it met; anything else sends it back with your words.',
  ].join('');
  return {
    shape: 'decision',
    headline: clip(`Check: ${line.text}`, 500),
    detail,
    options: [
      {
        id: OWNER_CHECK_MET,
        label: 'Looks right',
        detail: 'Marks this line met. The task closes once every line is.',
      },
      {
        id: OWNER_CHECK_NOT_MET,
        label: 'Not met',
        detail: 'Sends it back to the builder with what you write.',
      },
    ],
  };
}

function isOpen(item: StoredReviewItem): boolean {
  return item.answer === undefined && !reviewWithdrawn(item.review);
}

/** The stored item linked to a line, if this item is one. */
export function linkedLineOf(task: Task, reviewItemId: string): DoneWhenLine | undefined {
  const item = task.reviews?.find((r) => r.id === reviewItemId);
  if (!item?.doneWhenLineId) return undefined;
  return (task.doneWhen ?? []).find((l) => l.id === item.doneWhenLineId);
}

/**
 * Bring the row's owner items in line with its owner lines: one open item per
 * owner line, none for a line that is no longer the owner's. Returns what it
 * did, so the boot pass can say so.
 */
export function syncOwnerItems(
  taskId: string,
  deps: OwnerItemDeps,
): { filed: number; withdrawn: number } {
  const task = deps.getTask(taskId);
  if (!task) return { filed: 0, withdrawn: 0 };
  let filed = 0;
  let withdrawn = 0;
  const lines = task.doneWhen ?? [];
  const linked = (task.reviews ?? []).filter((r) => r.doneWhenLineId !== undefined);

  for (const item of linked) {
    if (!isOpen(item)) continue;
    const line = lines.find((l) => l.id === item.doneWhenLineId);
    if (line?.verdict === 'owner' && task.status !== 'done') continue;
    const res = deps.withdrawReviewItem(task.id, item.id, {
      actor: { id: SERVER_ID, name: item.createdBy || OWNER_CHECK_FILER, kind: 'agent' },
      reason: !line
        ? 'The done-when line it asked about was removed.'
        : task.status === 'done'
          ? 'The task is done.'
          : 'The line is no longer waiting on you — it was answered on the task or reported again.',
    });
    if (res.ok) withdrawn++;
  }

  if (task.status === 'done') return { filed, withdrawn };
  for (const line of lines) {
    if (line.verdict !== 'owner') continue;
    if (linked.some((r) => r.doneWhenLineId === line.id && isOpen(r))) continue;
    const res = deps.addReviewItem(task.id, ownerCheckReview(task, line), {
      actor: { id: SERVER_ID, name: line.by || OWNER_CHECK_FILER, kind: 'agent' },
      doneWhenLineId: line.id,
    });
    if (res.ok) filed++;
  }
  return { filed, withdrawn };
}

/** Why this actor may not answer this item, or undefined when they may. Only
 *  a person answers an owner line — the rule `ownerCheck` keeps — so an agent
 *  cannot record an answer on the item that the line would then refuse. */
export function refuseOwnerAnswer(
  task: Task,
  reviewItemId: string,
  actor: Actor,
): string | undefined {
  if (!linkedLineOf(task, reviewItemId)) return undefined;
  if (classifyActor(actor) === 'person') return undefined;
  return 'only a person can answer a done-when line marked for the owner — report it with proof, or leave it to them';
}

/**
 * The answer just recorded on a linked item, applied to its line: `Looks
 * right` meets it; anything else leaves it not met, with the words on the
 * task's Activity so the builder reads what to fix.
 */
export function applyOwnerAnswer(
  taskId: string,
  reviewItemId: string,
  answer: { text: string; answeredWith?: string },
  actor: Actor,
  deps: OwnerItemDeps,
): void {
  const task = deps.getTask(taskId);
  if (!task) return;
  const line = linkedLineOf(task, reviewItemId);
  if (!line || line.verdict !== 'owner') return;
  const met = answer.answeredWith === OWNER_CHECK_MET;
  const res = deps.ownerCheck(taskId, line.id, met ? 'met' : 'not-met', actor);
  if (!res.ok || met) return;
  const words = answer.text.trim();
  deps.appendNote(taskId, {
    kind: 'status',
    text: `"${clip(line.text, 200)}" is not met — ${actor.name}${words ? `: “${words}”` : ''}`,
    agent: actor.name,
    ts: Date.now(),
  });
}
