/**
 * Which open review item a caller means, by any name it was handed for it.
 *
 * One item goes by three names. The cross-board queue keys it
 * `<workspaceId>:<row key>` (`cross-review-queue.ts`), and that is what a
 * `workspace.new_asks` line carries. Home's `?item=` link carries the row key
 * alone, without the board (`task-review:<taskId>:<itemId>`), because Home
 * is already on the board. And a ticket's review item has its own id
 * (`r-…`), which is what `add_review_item` hands back to whoever filed it.
 *
 * The rank route matched only the first name exactly, so a lead holding
 * either of the others was told `not-found` about an item that sat open on
 * Home (2026-11-10). `findQueueItem` takes all three.
 *
 * And when no open item answers, `whyNotQueued` says what became of a
 * ticket item the name does point at — held by the judge, answered, its task
 * done — so the caller is not told an item it can see does not exist.
 */
import type { TaskReviewItem } from '@claude-workspaces/core';
import { isReviewItemGated, reviewItemState, reviewWithdrawn } from '@claude-workspaces/core';
import type { CrossReviewItem } from './cross-review-queue.ts';
import { LEGACY_REVIEW_ITEM_ID } from './tasks.ts';

/** A key as sent, with one layer of URL encoding taken off when it has one:
 *  a `?item=` value copied out of an address bar arrives encoded. */
function decodeKey(key: string): string {
  if (!key.includes('%')) return key;
  try {
    return decodeURIComponent(key);
  } catch {
    return key;
  }
}

/** The open item a key names: the queue key, the board-relative row key, or a
 *  ticket review item's own id, in that order. */
export function findQueueItem(
  items: readonly CrossReviewItem[],
  rawKey: string,
): CrossReviewItem | undefined {
  const key = decodeKey(rawKey);
  return (
    items.find((i) => i.key === key) ??
    items.find((i) => i.key === `${i.workspaceId}:${key}`) ??
    (key === LEGACY_REVIEW_ITEM_ID
      ? undefined
      : items.find((i) => i.kind === 'task-review' && i.reviewItemId === key))
  );
}

/** The ticket review item a key names, as far as the key alone says. */
export function ticketItemRef(
  rawKey: string,
): { workspaceId?: string; taskId?: string; itemId: string } | undefined {
  const key = decodeKey(rawKey);
  const parts = key.split(':');
  const at = parts.indexOf('task-review');
  if (at === 0 || at === 1) {
    const [taskId, itemId] = parts.slice(at + 1);
    if (!taskId || !itemId || parts.length !== at + 3) return undefined;
    return at === 1 ? { workspaceId: parts[0] ?? '', taskId, itemId } : { taskId, itemId };
  }
  if (at >= 0) return undefined;
  return parts.length === 1 && key !== '' && key !== LEGACY_REVIEW_ITEM_ID
    ? { itemId: key }
    : undefined;
}

/** Why a ticket item is off the queue. */
export type NotQueuedReason =
  | 'board-retired'
  | 'task-archived'
  | 'task-done'
  | 'held'
  | 'withdrawn'
  | 'answered'
  | 'waiting';

const MESSAGES: Record<NotQueuedReason, string> = {
  'board-retired': 'That review item is on a retired board, which the queue does not read.',
  'task-archived': 'That review item is on an archived task, so it is not on the queue.',
  'task-done': 'That review item is on a done task, so it is not on the queue.',
  held: 'That review item is held by the quality check (or still being judged), so it is not on the queue yet.',
  withdrawn: 'That review item was withdrawn by its asker.',
  answered: 'That review item is already answered.',
  waiting: 'That review item is waiting on its asker to revise it.',
};

/** What `whyNotQueued` reads: the item where it is filed, and its task. */
export interface FiledItem {
  item: TaskReviewItem;
  task: { status: string; archivedAt?: number };
  boardLive: boolean;
}

/** Why the filed item is not on the queue, or undefined when nothing explains
 *  it — the caller then says not-found. */
export function whyNotQueued(
  filed: FiledItem | undefined,
): { reason: NotQueuedReason; message: string } | undefined {
  if (!filed) return undefined;
  const reason = reasonOf(filed);
  return reason ? { reason, message: MESSAGES[reason] } : undefined;
}

function reasonOf({ item, task, boardLive }: FiledItem): NotQueuedReason | undefined {
  if (!boardLive) return 'board-retired';
  if (task.archivedAt !== undefined) return 'task-archived';
  if (task.status === 'done') return 'task-done';
  if (isReviewItemGated(item)) return 'held';
  if (reviewWithdrawn(item.review)) return 'withdrawn';
  const state = reviewItemState(item);
  if (state === 'answered' || state === 'waiting') return state;
  return undefined;
}
