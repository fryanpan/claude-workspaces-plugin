import {
  type TaskReviewItem,
  isReviewItemHeld,
  readTaskReviewItem,
  reviewWithdrawn,
} from '@claude-workspaces/core';
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
 * FILED BY THE SERVER, JUDGED LIKE ANY OTHER ITEM. The words come from a
 * fixed template over the line and its proof, so the judge is not asked about
 * phrasing so much as whether a person should be asked at all — the first
 * items shipped with no link and with checks an agent could have read for
 * itself, and the owner's word on them was that they were not up to a
 * hand-written item's standard (2026-09-14). `gateOwnerItems` runs the same
 * gate a hand-written item runs; a hold goes to the agent that marked the
 * line, and its remedy is that agent's next report, not a revision of the
 * template — a revision would be written over by the next sync.
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
  reviseReviewItem(
    taskId: string,
    reviewItemId: string,
    patch: { headline: string; detail: string },
    opts: { actor: Actor },
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

function isHttp(url: string | undefined): url is string {
  return url !== undefined && /^https?:\/\//.test(url);
}

/**
 * The item for one owner line: the existing decision card with two options.
 *
 * The detail LEADS WITH THE LINK. The reader's first act is to open the thing
 * being checked, and the first owner items put the proof in a trailing
 * "Proof:" list, or had none — "Where's the mock? … Link the mock from the
 * review item" (owner, 2026-09-14). Then one sentence says what to check and
 * one says what each answer does, so the card needs nothing else open.
 */
export function ownerCheckReview(
  task: Task,
  line: DoneWhenLine,
): { shape: 'decision'; headline: string; detail: string; options: unknown[] } {
  const proofs = (line.proof ?? []).slice(0, 3);
  const label = (text: string) => text.replace(/[[\]]/g, '');
  const lead = proofs.find((p) => isHttp(p.url));
  const check = line.text.trim().replace(/[.!?]+$/, '');
  const opening = lead
    ? `Open [${label(lead.text)}](${lead.url}) and check: ${check}.`
    : `Nothing is linked to open, so find it first and check: ${check}.`;
  const also = proofs
    .filter((p) => p !== lead)
    .map((p) => (isHttp(p.url) ? `[${label(p.text)}](${p.url})` : label(p.text)));
  const detail = [
    opening,
    ` Looks right marks this line of “${task.title}” met, and the task closes once every line is; Not met sends it back to ${line.by || 'the builder'} with your words.`,
    also.length > 0 ? ` Also attached: ${also.join('; ')}.` : '',
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

/** What one sync did. `toJudge` names the items whose words are new — filed
 *  or revised — which are the ones the quality gate has not seen. */
export interface OwnerSyncResult {
  filed: number;
  withdrawn: number;
  revised: number;
  toJudge: string[];
}

/**
 * Bring the row's owner items in line with its owner lines: one open item per
 * owner line, carrying the line's current words and proof, and none for a
 * line that is no longer the owner's. Returns what it did, so the boot pass
 * can say so and the caller can put the new words through the gate.
 *
 * `actor` is whoever wrote the done-when change. An item it FILES is filed as
 * that actor when it is not a person — the agent that marked the line, which
 * is who a hold must reach.
 */
export function syncOwnerItems(
  taskId: string,
  deps: OwnerItemDeps,
  actor?: Actor,
): OwnerSyncResult {
  const task = deps.getTask(taskId);
  if (!task) return { filed: 0, withdrawn: 0, revised: 0, toJudge: [] };
  let filed = 0;
  let withdrawn = 0;
  let revised = 0;
  const toJudge: string[] = [];
  const lines = task.doneWhen ?? [];
  const linked = (task.reviews ?? []).filter((r) => r.doneWhenLineId !== undefined);

  for (const item of linked) {
    if (!isOpen(item)) continue;
    const line = lines.find((l) => l.id === item.doneWhenLineId);
    if (line?.verdict === 'owner' && task.status !== 'done') {
      // Same line, new words or new proof: the open item says what the line
      // says NOW, as a revision, so a question already asked on it stays.
      const { headline, detail } = ownerCheckReview(task, line);
      if (item.review.headline !== headline || item.review.detail !== detail) {
        const res = deps.reviseReviewItem(
          task.id,
          item.id,
          { headline, detail },
          { actor: { id: SERVER_ID, name: item.createdBy || OWNER_CHECK_FILER, kind: 'agent' } },
        );
        if (res.ok) {
          revised++;
          toJudge.push(item.id);
        }
      }
      continue;
    }
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

  if (task.status === 'done') return { filed, withdrawn, revised, toJudge };
  const filerId = actor && classifyActor(actor) !== 'person' ? actor.id : SERVER_ID;
  for (const line of lines) {
    if (line.verdict !== 'owner') continue;
    if (linked.some((r) => r.doneWhenLineId === line.id && isOpen(r))) continue;
    const res = deps.addReviewItem(task.id, ownerCheckReview(task, line), {
      actor: { id: filerId, name: line.by || OWNER_CHECK_FILER, kind: 'agent' },
      doneWhenLineId: line.id,
    });
    if (res.ok) {
      filed++;
      toJudge.push(res.item.id);
    }
  }
  return { filed, withdrawn, revised, toJudge };
}

/** What the gate needs from the server — structural, so this module imports
 *  nothing from the gate that imports the store that imports it. */
export interface OwnerGateDeps {
  getTask(taskId: string): Task | undefined;
  judgeReviewItem(
    task: Task,
    item: TaskReviewItem,
    author: Actor,
  ): Promise<{ held: boolean; item: TaskReviewItem; reason?: string; message?: string }>;
  announceTaskReview(task: Task, item: TaskReviewItem, author: Actor & { color: string }): void;
}

/** One owner item the gate held, as a done-when write reports it back. */
export interface OwnerCheckHold {
  lineId: string;
  reviewItemId: string;
  heldReason: string;
  message: string;
}

/**
 * Who a hold on this item goes to: the filer the gate last recorded, else
 * the agent that wrote this change, else the server under the line's name —
 * which reaches nobody live, and the hour's release still frees the item.
 * Never a person: a person editing a line's words did not hand it over.
 */
function ownerItemFiler(raw: StoredReviewItem, writer: Actor | undefined): Actor {
  if (raw.filedBy && raw.filedBy.id !== SERVER_ID) return raw.filedBy;
  if (writer && classifyActor(writer) !== 'person') return writer;
  return raw.filedBy ?? { id: SERVER_ID, name: raw.createdBy || OWNER_CHECK_FILER, kind: 'agent' };
}

/**
 * Put the owner items a sync filed or revised through the quality gate, and
 * announce each the moment it first reaches the reader's queue — a fresh
 * item that passes, or a held one this revision released — the same rule the
 * add and revise routes follow for a hand-written item.
 */
export async function gateOwnerItems(
  taskId: string,
  itemIds: readonly string[],
  writer: Actor | undefined,
  deps: OwnerGateDeps,
): Promise<OwnerCheckHold[]> {
  const holds: OwnerCheckHold[] = [];
  for (const id of itemIds) {
    const task = deps.getTask(taskId);
    const raw = task?.reviews?.find((r) => r.id === id);
    const item = raw ? readTaskReviewItem(raw) : undefined;
    if (!task || !raw?.doneWhenLineId || !item || !isOpen(raw)) continue;
    const unjudged = raw.judge === undefined;
    const wasHeld = isReviewItemHeld(item);
    const author = ownerItemFiler(raw, writer);
    const gate = await deps.judgeReviewItem(task, item, author);
    if (gate.held) {
      holds.push({
        lineId: raw.doneWhenLineId,
        reviewItemId: id,
        heldReason: gate.reason ?? '',
        message: gate.message ?? '',
      });
    } else if (unjudged || wasHeld) {
      deps.announceTaskReview(task, gate.item, { ...author, color: '' });
    }
  }
  return holds;
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
