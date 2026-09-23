/**
 * Telling the owner the master sharing switch went off, and letting them
 * turn it back on from the same place.
 *
 * On 23 September the switch went off for two minutes and the owner learned
 * of it only because every outside hostname, their own among them, answered
 * `sharing_disabled`. Nothing on the board said so, and nothing said who.
 *
 * So a master switch turned OFF files one DECISION on the owner's queue, on a
 * standing task on the catch-all board: who threw it, from which address,
 * when, why, and what stays refused while it is off. The owner's review page
 * reads every board, so the catch-all board reaches them. A flip that names a
 * board never reaches here: it closes that board alone and locks the owner
 * out of nothing.
 *
 * - **Turned OFF again while the item is open:** the item is revised to name
 *   the latest flip, so the queue holds one item.
 * - **Turned back ON by anyone:** the open item is withdrawn, because
 *   somebody has already answered it.
 * - **Answered "Turn back on" by the owner:** the server flips the switch
 *   through the same path the route uses, and that flip is logged with the
 *   owner as the actor. An answer from anyone else is recorded and does not
 *   flip anything. "Leave off" is recorded only.
 *
 * Filed by the server, and still judged: every filing and revision goes
 * through the review-item quality gate, and the owner's devices are told
 * only when the gate passes it. The standing task and the open item are kept
 * in `sharing-notice.json`, so a restart neither files a duplicate nor
 * forgets the item it would revise or withdraw.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SharingFlip } from './share/sharing-flip.ts';

export const SHARING_NOTICE_FILENAME = 'sharing-notice.json';

/** Who files, revises and withdraws the item. Not the stall escalation's
 *  name: the stall loop treats that one as its own. */
export const SHARING_NOTICE_ACTOR = {
  id: 'agent-workspaces-sharing',
  name: 'Sharing switch',
  kind: 'agent',
} as const;

export const SHARING_NOTICE_TASK_TITLE = 'Outside access to every board';
export const SHARING_ON_OPTION = 'turn-back-on';
export const SHARING_LEAVE_OFF_OPTION = 'leave-off';
const TURN_BACK_ON_LABEL = 'Turn back on';

type Actor = { id: string; name: string; kind?: string };

/** The part of a `decision.answered` event the notice reads. */
export interface SharingAnswer {
  taskId: string;
  reviewItemId?: string;
  optionId?: string;
  answer: string;
  actor: Actor;
}

export interface SharingNoticeDeps {
  dataDir: string;
  /** The owner's catch-all board, created on first need. */
  boardId: () => string;
  getTask(taskId: string): { id: string; archivedAt?: number } | undefined;
  createTask(
    workspaceId: string,
    opts: { title: string; body: string; goal: string; actor: Actor },
  ): { ok: true; task: { id: string } } | { ok: false; error?: string };
  addReviewItem(
    taskId: string,
    review: unknown,
    opts: { actor: Actor },
  ): { ok: true; item: { id: string } } | { ok: false; error: string };
  reviseReviewItem(
    taskId: string,
    reviewItemId: string,
    patch: { headline?: unknown; detail?: unknown; options?: unknown },
    opts: { actor: Actor },
  ): { ok: boolean };
  withdrawReviewItem(
    taskId: string,
    reviewItemId: string,
    opts: { actor: Actor; reason: string },
  ): { ok: boolean };
  /** Re-project a task after its items changed, so the board doc carries it. */
  refresh(taskId: string): void;
  /** Run the quality gate over a filed or revised item, and announce it to
   *  the owner's devices only when the gate passes it. */
  gate(taskId: string, itemId: string): Promise<void>;
  /** Whether this actor is the owner, as the rest of the server decides it. */
  isOwner(actor: Actor): boolean;
  /** Turn the master switch on through the route's own path, logging a flip
   *  with this actor. */
  turnBackOn(flip: { actor: string; peer: string; reason: string }): {
    ok: boolean;
    error?: string;
  };
  /** Where a refusal is reported. Defaults to console.error. */
  say?: (line: string) => void;
}

interface NoticeState {
  taskId?: string;
  /** The open item, while the master switch is off. */
  itemId?: string;
}

/**
 * Who threw the switch, in the reader's words. The log line keeps the full
 * actor with its id; the card is read on a phone against the review-item
 * criteria, which refuse a raw id, so it carries the name alone.
 */
export function actorOnCard(actor: string): string {
  const agent = /^agent (.+?)(?: \([^)]*\))?$/.exec(actor);
  if (agent?.[1]) return `The agent ${agent[1]}`;
  const person = /^(?:person|owner) (.+?)(?: \([^)]*\))?$/.exec(actor);
  if (person?.[1]) return person[1];
  return 'A caller that did not say who it was';
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** "06:46 UTC on 23 September 2026". */
export function timeOnCard(at: number): string {
  const d = new Date(at);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm} UTC on ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

function peerOnCard(peer: string): string {
  const bare = peer.replace(/^::ffff:/, '');
  return bare === '127.0.0.1' || bare === '::1' ? `${bare}, this machine` : bare;
}

/** The item's words. Exported so a test asserts the facts it must carry. */
export function sharingOffReview(flip: SharingFlip): {
  review_type: 'decision';
  headline: string;
  detail: string;
  options: Array<{ id: string; label: string; detail: string }>;
} {
  const reason = flip.reason === null ? 'They gave no reason.' : `Their reason: “${flip.reason}”.`;
  const detail = [
    `${actorOnCard(flip.actor)} turned off outside access to every board at ${timeOnCard(flip.at)}, from the address ${peerOnCard(flip.peer)}. ${reason}`,
    '',
    'While it stays off, nobody outside this machine can open any board: every share-link visitor, every collaboration visitor and every visitor on a public hostname is refused, your own hostname included. Work on this machine is not affected.',
    '',
    'If the aim was to shut out one board, turn this back on and have the agent close that board alone.',
  ].join('\n');
  return {
    review_type: 'decision',
    headline: 'External sharing was turned off',
    detail,
    options: [
      {
        id: SHARING_ON_OPTION,
        label: TURN_BACK_ON_LABEL,
        detail:
          'Every board reopens to the people it is shared with, except a board closed on its own, and the log records you as the one who reopened it. If the precaution was needed, what it guarded against is open again.',
      },
      {
        id: SHARING_LEAVE_OFF_OPTION,
        label: 'Leave off',
        detail:
          'Everyone outside stays refused, you included when you are away from this machine, until an agent here turns it back on.',
      },
    ],
  };
}

export class SharingNotice {
  private readonly path: string;
  private state: NoticeState;
  private readonly say: (line: string) => void;

  constructor(private readonly deps: SharingNoticeDeps) {
    this.path = join(deps.dataDir, SHARING_NOTICE_FILENAME);
    this.say = deps.say ?? ((line) => console.error(line));
    this.state = this.load();
  }

  /** The open item, for a test or a status read. */
  openItem(): { taskId: string; itemId: string } | undefined {
    const { taskId, itemId } = this.state;
    return taskId && itemId ? { taskId, itemId } : undefined;
  }

  /** Called after every flip the switch route wrote. The gate runs in the
   *  background; the returned promise settles when it has. */
  onFlip(flip: SharingFlip): Promise<void> {
    if (flip.workspaceId) return Promise.resolve();
    if (flip.enabled) {
      this.withdrawOpen(`The master switch was turned back on by ${flip.actor}.`);
      this.save();
      return Promise.resolve();
    }
    const review = sharingOffReview(flip);
    const open = this.openItem();
    if (open) {
      const { review_type: _type, ...patch } = review;
      const revised = this.deps.reviseReviewItem(open.taskId, open.itemId, patch, {
        actor: { ...SHARING_NOTICE_ACTOR },
      });
      if (revised.ok) return this.settle(open.taskId, open.itemId);
      // Answered or withdrawn by some other door: file a fresh one below.
      this.state.itemId = undefined;
    }
    const taskId = this.ensureTask();
    if (!taskId) {
      this.save();
      return Promise.resolve();
    }
    const res = this.deps.addReviewItem(taskId, review, { actor: { ...SHARING_NOTICE_ACTOR } });
    if (!res.ok) {
      this.say(`[sharing] owner notice refused task=${taskId}: ${res.error}`);
      this.save();
      return Promise.resolve();
    }
    this.state.itemId = res.item.id;
    return this.settle(taskId, res.item.id);
  }

  /** Called with every `decision.answered` on the server. */
  onAnswered(ev: SharingAnswer): void {
    const open = this.openItem();
    if (!open || ev.taskId !== open.taskId || ev.reviewItemId !== open.itemId) return;
    // The item is answered either way, so it is no longer the open one: a
    // later flip to off files a new item rather than revising this one.
    this.state.itemId = undefined;
    this.save();
    const turnOn =
      ev.optionId === SHARING_ON_OPTION ||
      (ev.optionId === undefined &&
        ev.answer.trim().toLowerCase() === TURN_BACK_ON_LABEL.toLowerCase());
    if (!turnOn) return;
    const who = `${ev.actor.name}${ev.actor.id && ev.actor.id !== ev.actor.name ? ` (${ev.actor.id})` : ''}`;
    if (ev.actor.kind !== 'person' || !this.deps.isOwner(ev.actor)) {
      this.say(
        `[sharing] "${TURN_BACK_ON_LABEL}" answered by ${JSON.stringify(who)}, who is not the owner; the master switch stays off`,
      );
      return;
    }
    const res = this.deps.turnBackOn({
      actor: `owner ${who}`,
      peer: `review item ${open.itemId}`,
      reason: `answered "${TURN_BACK_ON_LABEL}" on the notice`,
    });
    if (!res.ok)
      this.say(
        `[sharing] "${TURN_BACK_ON_LABEL}" could not flip the switch: ${res.error ?? 'unknown'}`,
      );
  }

  private async settle(taskId: string, itemId: string): Promise<void> {
    this.save();
    this.deps.refresh(taskId);
    try {
      await this.deps.gate(taskId, itemId);
    } catch (err) {
      this.say(`[sharing] owner notice gate failed item=${itemId}: ${String(err)}`);
    }
  }

  private ensureTask(): string | null {
    const known = this.state.taskId ? this.deps.getTask(this.state.taskId) : undefined;
    if (known && known.archivedAt === undefined) return known.id;
    const created = this.deps.createTask(this.deps.boardId(), {
      title: SHARING_NOTICE_TASK_TITLE,
      body: 'Where the server tells the owner that the master sharing switch was turned off: who did it, from where, when and why, with a choice to turn it back on. Each item withdraws itself when the switch is turned back on.',
      goal: 'chores',
      actor: { ...SHARING_NOTICE_ACTOR },
    });
    if (!created.ok) {
      this.say(`[sharing] owner notice task refused: ${created.error ?? 'unknown'}`);
      return null;
    }
    this.state.taskId = created.task.id;
    return created.task.id;
  }

  private withdrawOpen(reason: string): void {
    const open = this.openItem();
    if (!open) return;
    this.deps.withdrawReviewItem(open.taskId, open.itemId, {
      actor: { ...SHARING_NOTICE_ACTOR },
      reason,
    });
    this.deps.refresh(open.taskId);
    this.state.itemId = undefined;
  }

  private load(): NoticeState {
    if (!existsSync(this.path)) return {};
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as NoticeState;
      return {
        ...(typeof parsed.taskId === 'string' ? { taskId: parsed.taskId } : {}),
        ...(typeof parsed.itemId === 'string' ? { itemId: parsed.itemId } : {}),
      };
    } catch {
      // A lost record costs at most one duplicate task, never a missed notice.
      return {};
    }
  }

  private save(): void {
    writeFileSync(this.path, `${JSON.stringify(this.state, null, 2)}\n`);
  }
}
