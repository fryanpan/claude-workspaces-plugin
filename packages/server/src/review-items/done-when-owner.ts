import {
  REVIEW_LIMITS,
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
import type { DoneWhenLine, DoneWhenProof } from '@claude-workspaces/core/done-when';
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

/** The headline budget every hand-written item is advised by. A generated
 *  item HOLDS to it: the card clamps at that width on a phone, and the first
 *  generated items shipped a whole acceptance criterion as their title —
 *  209 characters on the reader's queue (measured 2026-09-15). */
const HEADLINE_MAX = REVIEW_LIMITS.headline;

/** How long a link's words may run before the label is derived from the URL
 *  instead. A label is a thing to tap, not a paragraph to read. */
const LABEL_MAX = 60;

/** How much of a proof's own words the card carries as context. Past this it
 *  is a document, and the link is right there. */
const NOTE_MAX = 400;

/** `text` on one line, cut at the last word boundary that fits, with an
 *  ellipsis. Word-boundary rather than mid-word: a clipped headline is the
 *  only thing a reader sees in a list, and a cut word reads as a bug. */
function clipWords(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').trim();
  if (one.length <= max) return one;
  const cut = one.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  const kept = space > max / 2 ? cut.slice(0, space) : cut;
  return `${kept.replace(/[\s,;:.]+$/, '')}\u2026`;
}

/** A full stop that ends a word nobody means as a sentence: an abbreviation
 *  or an initial. Without this, "Works on iOS, e.g. Mobile Safari" headlines
 *  as "Check: Works on iOS, e.g" (codex review). */
const ABBREVIATION = /(?:\be\.g|\bi\.e|\betc|\bvs|\bcf|\bal|\bapprox|\bfig|\bno|\s[A-Za-z])\.$/i;

/** Shorter than this and a "sentence" is a fragment, so the next one is
 *  taken with it rather than a headline reading "Check: Yes". */
const MIN_SENTENCE = 24;

/** The first sentence of a line — what the headline says when the line itself
 *  is a paragraph. Sentences are taken together until one ends somewhere a
 *  reader would stop. */
function firstSentence(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim();
  let acc = '';
  for (const part of one.split(/(?<=[.!?])\s+(?=[A-Z(\[])/)) {
    acc = acc === '' ? part : `${acc} ${part}`;
    if (acc.length >= MIN_SENTENCE && !ABBREVIATION.test(acc)) return acc;
  }
  return one;
}

/** `text` ending in sentence punctuation, so a quoted note does not read as
 *  cut off and the template never doubles a full stop. */
function sentence(text: string): string {
  return /[.!?\u2026]$/.test(text) ? text : `${text}.`;
}

/** Trailing sentence punctuation removed, so the template adds its own. */
function unpunctuated(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!?\u2026]+$/, '');
}

/**
 * What the reader decides, in one line they can act on from a list on a
 * phone: the line's first sentence, clipped to the same budget a hand-written
 * headline is advised by. The whole line is still in the detail, so nothing a
 * clip drops is lost.
 */
export function ownerCheckHeadline(line: DoneWhenLine): string {
  const prefix = 'Check: ';
  return `${prefix}${clipWords(unpunctuated(firstSentence(line.text)), HEADLINE_MAX - prefix.length)}`;
}

/** What a link to this URL is, in the reader's words, when the proof's own
 *  text is too long to be a label. Read off the address and nothing else —
 *  a generated line invents no specifics. */
function labelForUrl(url: string): string {
  if (/\/mockups?\//.test(url)) return 'the mock';
  if (/\/docs?\//.test(url)) return 'the doc';
  if (/[?&]task=/.test(url) || /\/tasks\//.test(url)) return 'the task';
  const pr = /github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/.exec(url);
  if (pr) return `PR ${pr[1]}`;
  return 'the link';
}

/** Square brackets removed so a label cannot close its own markdown link. */
function plain(text: string): string {
  return text.replace(/[[\]]/g, '').replace(/\s+/g, ' ').trim();
}

/** The words a proof's link wears: its own text when that is short enough to
 *  be a label, else what the URL says it is. A multi-sentence note is never a
 *  label — the first generated mock items put a whole paragraph between the
 *  brackets, and the reader was handed a wall of text to tap. */
function linkLabel(proof: DoneWhenProof): string {
  const words = plain(proof.text);
  const oneSentence = firstSentence(words) === words;
  if (words !== '' && words.length <= LABEL_MAX && oneSentence) return words;
  return labelForUrl(proof.url ?? '');
}

/** One proof as a phrase: a link when it has one, else its words. */
function attachment(proof: DoneWhenProof): string {
  const words = plain(proof.text);
  if (isHttp(proof.url)) return `[${linkLabel(proof)}](${proof.url})`;
  return clipWords(words, LABEL_MAX * 2);
}

/**
 * The item for one owner line: the existing decision card with two options.
 *
 * The detail LEADS WITH THE LINK, on its own line. The reader's first act is
 * to open the thing being checked, and the first owner items put the proof in
 * a trailing "Proof:" list, or had none — "Where's the mock? \u2026 Link the mock
 * from the review item" (owner, 2026-09-14). Then the line itself, the proof's
 * own words as the context somebody away from the work needs, and one sentence
 * saying what each answer does. Nothing here is invented: every specific comes
 * from the line, its proof or the task's title.
 */
export function ownerCheckReview(
  task: Task,
  line: DoneWhenLine,
): { shape: 'decision'; headline: string; detail: string; options: unknown[] } {
  const proofs = (line.proof ?? []).slice(0, 3);
  const lead = proofs.find((p) => isHttp(p.url));
  const check = unpunctuated(line.text);
  const opening = lead
    ? `Open [${linkLabel(lead)}](${lead.url}).`
    : 'Nothing is linked to open, so find it first.';
  // The lead proof's own words, unless the label already said them. Not
  // possessive on the reporter's name: half the fleet's names end in s.
  const leadWords = lead ? plain(lead.text) : '';
  const note =
    lead !== undefined && leadWords !== '' && leadWords !== linkLabel(lead)
      ? ` The note attached with it: \u201c${sentence(clipWords(leadWords, NOTE_MAX))}\u201d`
      : '';
  const also = proofs.filter((p) => p !== lead).map(attachment);
  const detail = [
    opening,
    '',
    `Check: ${check}.${note}`,
    '',
    `Looks right marks this line of \u201c${task.title}\u201d met, and the task closes once every line is; Not met sends it back to ${line.by || 'the builder'} with your words.${
      also.length > 0 ? ` Also attached: ${also.join('; ')}.` : ''
    }`,
  ].join('\n');
  return {
    shape: 'decision',
    headline: ownerCheckHeadline(line),
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

/** What one sync did. `toJudge` names the items the quality gate has not
 *  seen: filed or revised by this sync, or open with no verdict at all — an
 *  item filed before owner checks were gated, or one a crash left between its
 *  write and its judgement, which no later sync would otherwise reach. */
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
      if (item.review.headline === headline && item.review.detail === detail) {
        if (item.judge === undefined) toJudge.push(item.id);
      } else {
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
    } else if (wasHeld || (unjudged && gate.item.judge !== undefined)) {
      // Unjudged means first seen only once a verdict was recorded: with the
      // gate off nothing is recorded, and an item every sync hands back would
      // otherwise ping the reader's devices on every write.
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
