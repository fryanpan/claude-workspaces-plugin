/**
 * Telling the owner the master sharing switch went off.
 *
 * On 23 September the switch went off for two minutes and the owner learned
 * of it only because every outside hostname, their own among them, answered
 * `sharing_disabled`. Nothing on the board said so, and nothing said who.
 *
 * So a master switch turned OFF files one review item on the owner's queue,
 * on a standing task on the catch-all board, naming who threw it, from which
 * address, when and why, and how to turn it back on. A review item is the
 * surface the owner already reads on Home: the store's `review_item.added`
 * reaches an open board page over its live stream, and the item is announced
 * to the owner's enrolled devices the way the review-item route announces
 * one, which is what "within a minute" asks for. A
 * `workspace.*` event would reach an attached agent's channel and no page:
 * the board renders none of them as words.
 *
 * - Turned back ON: the open item is withdrawn, because the question it asks
 *   has been answered by somebody.
 * - Turned OFF again while an item is open: the old item is withdrawn and a
 *   new one filed, so the queue holds one item and it names the latest flip.
 * - A board closed on its own files nothing. That is the precaution working
 *   as meant, and it locks the owner out of nothing.
 *
 * FILED BY THE SERVER, like the stall escalation: `addReviewItem` on the
 * store, never the quality judge, because the words are a fixed template over
 * facts the server recorded. The standing task and the open item are kept in
 * `sharing-notice.json` so a restart neither files a duplicate nor forgets
 * the item it would withdraw.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SharingFlip } from './share/sharing-flip.ts';

export const SHARING_NOTICE_FILENAME = 'sharing-notice.json';

/** Who files and withdraws the item. Not the stall escalation's name: the
 *  stall loop treats that one as its own. */
export const SHARING_NOTICE_ACTOR = {
  id: 'agent-workspaces-sharing',
  name: 'Sharing switch',
  kind: 'agent',
} as const;

export const SHARING_NOTICE_TASK_TITLE = 'Outside access to every board';

type Actor = { id: string; name: string; kind?: string };

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
  withdrawReviewItem(
    taskId: string,
    reviewItemId: string,
    opts: { actor: Actor; reason: string },
  ): { ok: boolean };
  /** Re-project a task after its items changed, so the board doc carries it. */
  refresh(taskId: string): void;
  /** Announce a filed item the way the review-item route does (browser push). */
  announce(taskId: string, itemId: string): void;
  /** Where a refusal is reported. Defaults to console.error. */
  say?: (line: string) => void;
}

interface NoticeState {
  taskId?: string;
  /** The open item, while the master switch is off. */
  itemId?: string;
}

/** The item's words. Exported so a test asserts the facts it must carry. */
export function sharingOffReview(flip: SharingFlip): Record<string, unknown> {
  const when = new Date(flip.at).toISOString();
  const detail = [
    `The master sharing switch was turned off at ${when}. Every share link, collaboration visitor and your own public hostname is refused until it is turned back on.`,
    '',
    `- **Who:** ${flip.actor}`,
    `- **From:** ${flip.peer}`,
    `- **Reason given:** ${flip.reason ?? 'none'}`,
    '',
    'If this was meant for one board, turn the master switch back on from this machine (set_sharing_enabled with enabled true) and close that board alone by passing its workspaceId. This item withdraws itself when the switch is turned back on.',
  ].join('\n');
  return {
    review_type: 'question',
    headline: 'Outside access is off for every board',
    detail,
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

  /** Called after every flip the switch route wrote. */
  onFlip(flip: SharingFlip): void {
    if (flip.workspaceId) return;
    if (flip.enabled) {
      this.withdrawOpen(`The master switch was turned back on by ${flip.actor}.`);
      this.save();
      return;
    }
    this.withdrawOpen('A later flip of the master switch replaced this item.');
    const taskId = this.ensureTask();
    if (!taskId) {
      this.save();
      return;
    }
    const res = this.deps.addReviewItem(taskId, sharingOffReview(flip), {
      actor: { ...SHARING_NOTICE_ACTOR },
    });
    if (res.ok) {
      this.state.itemId = res.item.id;
      this.deps.refresh(taskId);
      this.deps.announce(taskId, res.item.id);
    } else {
      this.say(`[sharing] owner notice refused task=${taskId}: ${res.error}`);
    }
    this.save();
  }

  private ensureTask(): string | null {
    const known = this.state.taskId ? this.deps.getTask(this.state.taskId) : undefined;
    if (known && known.archivedAt === undefined) return known.id;
    const created = this.deps.createTask(this.deps.boardId(), {
      title: SHARING_NOTICE_TASK_TITLE,
      body: 'Where the server tells the owner that the master sharing switch was turned off: who did it, from where, when and why. Each item withdraws itself when the switch is turned back on.',
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
    const { taskId, itemId } = this.state;
    if (!taskId || !itemId) return;
    this.deps.withdrawReviewItem(taskId, itemId, { actor: { ...SHARING_NOTICE_ACTOR }, reason });
    this.deps.refresh(taskId);
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
