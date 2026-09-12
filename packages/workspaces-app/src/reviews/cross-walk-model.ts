/**
 * The cross-board review's queue, as the walkthrough card reads it.
 *
 * The server hands `/api/review-queue` every open review item on every board
 * in one order (top project first, then each board's Home order), each row
 * sized. This turns those rows into the `ReviewItem`s the card already draws,
 * narrows them to the size the reader chose, and says where the reader stands
 * when the choice changes under them.
 *
 * Pure: the page (`reviews-app.ts`) owns the fetch, the stored choice and the
 * signal write.
 */
import { type ReviewSize, sizeAllowed } from '@claude-workspaces/core';
import {
  type ReviewItem,
  type ReviewQueue,
  type ReviewThreadItem,
  reviewQueue,
} from '../board/board-review-model.ts';

/** One row of `/api/review-queue`. */
export type CrossReviewRow = ReviewThreadItem & {
  workspaceId: string;
  project: string;
  /** `<workspaceId>:<row key>` — unique across boards. */
  key: string;
  size: ReviewSize;
  minutes: number;
};

export interface CrossEntry {
  item: ReviewItem;
  project: string;
  workspaceId: string;
  size: ReviewSize;
}

/**
 * One row as a card. A thread row is placed by Home's own mapping, so the card
 * reads exactly as it does on the board. A ticket-borne row is built here,
 * because Home skips the derived `r-legacy` row — it draws that question from
 * the board's projection instead, and this page has no projection. Its answer
 * route delegates to the decision, so the row is the whole card.
 *
 * The key is the server's, which carries the board: two boards can hold a row
 * with the same local key.
 */
export function crossEntry(row: CrossReviewRow, now: number): CrossEntry | null {
  const thread: ReviewThreadItem = row;
  let item: ReviewItem | undefined;
  if (row.kind === 'task-review') {
    if (!row.taskId || !row.reviewItemId) return null;
    item = {
      key: row.key,
      kind: 'task-review',
      title: row.title,
      ask: row.ask,
      why: '',
      since: row.since,
      thread,
      ...(row.review !== undefined ? { review: row.review } : {}),
      ...(row.state === 'revised'
        ? {
            revision: {
              at: row.revisedAt ?? row.since,
              ...(row.question !== undefined ? { question: row.question } : {}),
              ...(row.threadId !== undefined ? { threadId: row.threadId } : {}),
              ...(row.revisedRange ? { range: row.revisedRange } : {}),
            },
          }
        : {}),
    };
  } else {
    const placed = reviewQueue([], [thread], now).items[0];
    if (placed) item = { ...placed, key: row.key };
  }
  if (!item) return null;
  return { item, project: row.project, workspaceId: row.workspaceId, size: row.size };
}

/** The entries a size lets through, in the server's order. */
export function allowedEntries(entries: readonly CrossEntry[], level: ReviewSize): CrossEntry[] {
  return entries.filter((e) => sizeAllowed(e.size, level));
}

export function asQueue(entries: readonly CrossEntry[]): ReviewQueue {
  const items = entries.map((e) => e.item);
  return { items, total: items.length, blocking: 0 };
}

/**
 * Where the reader stands after the size changes: on the card they were
 * reading if the new size still lets it through, otherwise on the next one
 * after it in the full order that does. Null is the done screen.
 */
export function aimAfterSizeChange(
  entries: readonly CrossEntry[],
  currentKey: string | null,
  level: ReviewSize,
): string | null {
  const from = currentKey ? entries.findIndex((e) => e.item.key === currentKey) : 0;
  for (let i = Math.max(from, 0); i < entries.length; i += 1) {
    const e = entries[i];
    if (e && sizeAllowed(e.size, level)) return e.item.key;
  }
  return null;
}

/** "N harder item(s) not shown", or null when the size hides nothing. */
export function hiddenNote(entries: readonly CrossEntry[], level: ReviewSize): string | null {
  const hidden = entries.length - allowedEntries(entries, level).length;
  if (hidden === 0) return null;
  return `${hidden} harder ${hidden === 1 ? 'item' : 'items'} not shown`;
}

/**
 * Where "open it where it lives" goes for a row on another board: the task
 * panel (aimed at the thread when there is one), the goal panel, or the doc at
 * the comment — the same destinations the board's own opener picks.
 */
export function crossItemHref(entry: CrossEntry): string | null {
  const t = entry.item.thread;
  if (!t) return null;
  const board = `/workspaces/${encodeURIComponent(entry.workspaceId)}`;
  const threadId = entry.item.revision?.threadId ?? t.threadId;
  if (t.kind === 'task-review' || t.kind === 'task-thread') {
    if (!t.taskId) return board;
    const thread = threadId ? `&thread=${encodeURIComponent(threadId)}` : '';
    return `${board}?task=${encodeURIComponent(t.taskId)}${thread}`;
  }
  if (t.kind === 'goal-thread') {
    if (!t.taskId) return board;
    return `${board}?goal=${encodeURIComponent(t.taskId)}&thread=${encodeURIComponent(t.threadId)}`;
  }
  const surface = t.docType === 'mockup' ? 'mockups' : 'docs';
  return `${board}/${surface}/${encodeURIComponent(t.docId)}?thread=${encodeURIComponent(t.threadId)}`;
}
