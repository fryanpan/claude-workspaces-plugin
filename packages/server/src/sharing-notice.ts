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
 * reads every live board, so the catch-all board reaches them. When the
 * catch-all is retired, which refuses new tasks and drops off that page, the
 * notice goes to the best live board instead (`rankFallbackBoards`); nothing
 * here unretires a board. A flip that names a
 * board never reaches here: it closes that board alone and locks the owner
 * out of nothing.
 *
 * The item is an ACCESS card (`sharing-on`, `@claude-workspaces/core/review-access`):
 * only the access door answers it (`routes/task-access.ts`), on the owner's
 * person proof from the board's own page, and the general answer route
 * refuses it. A loopback caller naming the owner as its author cannot turn
 * sharing back on. While the switch is off, the owner's Access hostname still
 * lets the owner reach that one card (`sharing-off-door.ts`), so the way back
 * does not depend on being at this machine.
 *
 * - **Turned OFF again while the item is open:** that card is withdrawn and a
 *   new one names the latest flip, so the queue holds one item. An access
 *   card is never reworded (`review-items/store.ts`).
 * - **Turned back ON by anyone else:** the open item is withdrawn, because
 *   somebody has already answered it.
 * - **Approved at the access door:** the server flips the switch through the
 *   same path the route uses, logged with the owner as the actor, and the
 *   door records the answer. Reject records the answer only.
 *
 * Filed by the server and still judged: every filing and revision goes
 * through the review-item quality gate, but the owner is told whatever the
 * gate says, and a hold is recorded as passed with the gate's words beside
 * it (server.ts). The gate holds agent-written asks; this is a fixed
 * template, and a security notice the owner never sees is worse. The standing task and the open item are kept
 * in `sharing-notice.json`, so a restart neither files a duplicate nor
 * forgets the item it would withdraw.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SharingFlip } from './share/sharing-flip.ts';

export const SHARING_NOTICE_FILENAME = 'sharing-notice.json';

/** Who files and withdraws the item. Not the stall escalation's
 *  name: the stall loop treats that one as its own. */
export const SHARING_NOTICE_ACTOR = {
  id: 'agent-workspaces-sharing',
  name: 'Sharing switch',
  kind: 'agent',
} as const;

export const SHARING_NOTICE_TASK_TITLE = 'Outside access to every board';

type Actor = { id: string; name: string; kind?: string };

/** The change the notice's card carries. */
export type SharingOnChange = { op: 'sharing-on'; workspaceId: string };

export interface SharingNoticeDeps {
  dataDir: string;
  /** The owner's catch-all board, created on first need. */
  boardId: () => string;
  /**
   * Live boards to file on when the catch-all board refuses the task, best
   * first. The catch-all can be retired, and a retired board refuses new
   * tasks; the notice must still reach the owner, and nothing here may
   * unretire a board to get there.
   */
  fallbackBoards?: () => string[];
  getTask(taskId: string): { id: string; workspaceId: string; archivedAt?: number } | undefined;
  /** Whether a board is live. The owner's review page skips a retired
   *  board, so a standing task left on one would file items nobody reads. */
  isBoardLive?: (workspaceId: string) => boolean;
  createTask(
    workspaceId: string,
    opts: { title: string; body: string; goal: string; actor: Actor },
  ): { ok: true; task: { id: string } } | { ok: false; error?: string };
  /** File the access card; its headline is derived from the change. */
  addAccessReviewItem(
    taskId: string,
    change: SharingOnChange,
    why: string,
    opts: { actor: Actor },
  ): { ok: true; item: { id: string } } | { ok: false; error: string };
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
  /** Where a refusal is reported. Defaults to console.error. */
  say?: (line: string) => void;
}

interface NoticeState {
  taskId?: string;
  /** The open item, while the master switch is off. */
  itemId?: string;
  /** Which kind of item `itemId` is. An item filed before the notice became
   *  an access card is a plain decision anyone on this machine could answer,
   *  so a restart forgets it and the next flip files a card. */
  card?: 'access';
}

/** A board as the fallback ranking reads it. */
export interface FallbackCandidate {
  id: string;
  retired: boolean;
  /** Whether the board is open to anyone outside: a share link, a
   *  share-link member, or a share. */
  shared: boolean;
  activeAt: number;
}

/**
 * Where the notice goes when the catch-all board refuses it: live boards
 * only, never a retired one. A board nobody outside is a member of comes
 * first, because the item names an address on this machine and the members
 * of a board see everything on it. Among equals, the most recently active
 * board wins, since that is the one the owner is most likely looking at.
 */
export function rankFallbackBoards(boards: readonly FallbackCandidate[]): string[] {
  return boards
    .filter((b) => !b.retired)
    .sort((a, b) => Number(a.shared) - Number(b.shared) || b.activeAt - a.activeAt)
    .map((b) => b.id);
}

/**
 * Who threw the switch, in the reader's words. The log line keeps the full
 * actor with its id; the card is read on a phone against the review-item
 * criteria, which refuse a raw id, so it carries the name alone.
 */
const UNATTRIBUTED_ON_CARD = 'An unnamed caller';

export function actorOnCard(actor: string): string {
  const agent = /^agent (.+?)(?: \([^)]*\))?$/.exec(actor);
  if (agent?.[1]) return `The agent ${agent[1]}`;
  const person = /^(?:person|owner) (.+?)(?: \([^)]*\))?$/.exec(actor);
  if (person?.[1]) return person[1];
  return UNATTRIBUTED_ON_CARD;
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

/** The item's words. Exported so a test asserts the facts it must carry. The
 *  card's own headline is the change's line; this headline leads the
 *  notifications and the detail. */
export function sharingOffReview(flip: SharingFlip): { headline: string; detail: string } {
  const reason = flip.reason === null ? 'They gave no reason.' : `Their reason: “${flip.reason}”.`;
  const detail = [
    `${actorOnCard(flip.actor)} turned off sharing for every board at ${timeOnCard(flip.at)}, from ${peerOnCard(flip.peer)}. ${reason}`,
    '',
    'While it is off, every share-link, collaboration and public-hostname visitor is refused, your own hostname included. Approve turns it back on; Reject leaves it off.',
    '',
    'To tell what happened, read the first line: who did it, from which address, and the reason given. Then ask that agent, or check which of your sessions called the switch last.',
    '',
    '- **Intended, for one board:** the caller is your agent and the reason names a board. Approve, and have that agent close that board alone.',
    `- **A mistake:** the caller is unnamed, or your agent gave no reason. ${UNATTRIBUTED_ON_CARD} is a program on this machine running an older plugin. Approve.`,
    "- **An incident:** the caller is nobody you know, or the address is not this machine. Reject, and check each board's share list before reopening.",
  ].join('\n');
  return { headline: 'External sharing was turned off', detail };
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

  /** Set while the access door turns the switch on from this card, so the
   *  flip that follows does not withdraw the card the door is answering. */
  private answeringFromCard = false;

  /** The open item, for a test or a status read. */
  openItem(): { taskId: string; itemId: string } | undefined {
    const { taskId, itemId } = this.state;
    return taskId && itemId ? { taskId, itemId } : undefined;
  }

  /**
   * The open card and the board it is on, for the one door the owner's Access
   * hostname keeps open while the switch is off (`sharing-off-door.ts`).
   */
  openCard(): { workspaceId: string; taskId: string; itemId: string } | undefined {
    const open = this.openItem();
    const task = open ? this.deps.getTask(open.taskId) : undefined;
    return open && task ? { workspaceId: task.workspaceId, ...open } : undefined;
  }

  /**
   * Turn the switch on because the owner approved this card. `flip` runs the
   * switch's own path, whose flip lands in `onFlip`; the card is the door's
   * to answer, so it is let go rather than withdrawn.
   */
  turnOnFromCard<T extends { ok: boolean }>(flip: () => T): T {
    this.answeringFromCard = true;
    try {
      return flip();
    } finally {
      this.answeringFromCard = false;
    }
  }

  /** Called after every flip the switch route wrote. The gate runs in the
   *  background; the returned promise settles when it has. */
  onFlip(flip: SharingFlip): Promise<void> {
    if (flip.workspaceId) return Promise.resolve();
    if (flip.enabled) {
      if (this.answeringFromCard) this.state.itemId = undefined;
      else this.withdrawOpen(`The master switch was turned back on by ${flip.actor}.`);
      this.save();
      return Promise.resolve();
    }
    const { detail } = sharingOffReview(flip);
    // Withdrawn, never reworded: an access card's words are its change's.
    // Answered or withdrawn by some other door already, it just goes.
    this.withdrawOpen('Replaced by a card naming the latest time it was turned off.');
    const taskId = this.ensureTask();
    if (!taskId) {
      this.save();
      return Promise.resolve();
    }
    const workspaceId = this.deps.getTask(taskId)?.workspaceId ?? '';
    const res = this.deps.addAccessReviewItem(taskId, { op: 'sharing-on', workspaceId }, detail, {
      actor: { ...SHARING_NOTICE_ACTOR },
    });
    if (!res.ok) {
      this.say(`[sharing] owner notice refused task=${taskId}: ${res.error}`);
      this.save();
      return Promise.resolve();
    }
    this.state.itemId = res.item.id;
    this.state.card = 'access';
    return this.settle(taskId, res.item.id);
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
    if (
      known &&
      known.archivedAt === undefined &&
      (this.deps.isBoardLive?.(known.workspaceId) ?? true)
    ) {
      return known.id;
    }
    const first = this.deps.boardId();
    const boards = [first, ...(this.deps.fallbackBoards?.() ?? []).filter((b) => b !== first)];
    for (const workspaceId of boards) {
      const created = this.deps.createTask(workspaceId, {
        title: SHARING_NOTICE_TASK_TITLE,
        body: 'Where the server tells the owner that the master sharing switch was turned off: who did it, from where, when and why, with a choice to turn it back on. Each item withdraws itself when the switch is turned back on.',
        goal: 'chores',
        actor: { ...SHARING_NOTICE_ACTOR },
      });
      if (created.ok) {
        this.state.taskId = created.task.id;
        return created.task.id;
      }
      this.say(
        `[sharing] owner notice task refused on board ${JSON.stringify(workspaceId)}: ${created.error ?? 'unknown'}`,
      );
    }
    this.say('[sharing] owner notice filed nowhere: every board refused the task');
    return null;
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
      const card = parsed.card === 'access';
      return {
        ...(typeof parsed.taskId === 'string' ? { taskId: parsed.taskId } : {}),
        ...(card && typeof parsed.itemId === 'string'
          ? { itemId: parsed.itemId, card: 'access' as const }
          : {}),
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
