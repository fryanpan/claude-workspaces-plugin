/**
 * The TICKET review items a mockup page is about — the ones its dock should
 * carry even though they live on a task rather than in the mock's threads.
 *
 * A lead files the ask on the task ("which layout ships?") and links the mock
 * in the detail. The dock reads only the mock's own threads, so the reader
 * opened the mock, looked, and had to leave for the Home queue to answer the
 * question about the thing in front of them. This resolves the link on the
 * server and hands the list out in the page the reader is already loading, so
 * nothing new is fetched or polled.
 *
 * Membership is the Home queue's, not a second copy of it: rows come from
 * `taskReviewItems`, which already drops held, withdrawn, answered and waiting
 * items and done tickets. Owner-only items are dropped here as well, for the
 * dock's own reason (see `dockItems` in the widget).
 */
import {
  type ReviewPayload,
  type TaskReviewItem,
  extractWorkspaceLinks,
} from '@claude-workspaces/core';
import type { Ref, Task } from '@claude-workspaces/core/task-wire';
import { taskReviewItems } from './review-queue.ts';

/** One ticket item as the dock receives it. */
export interface LinkedDockItem {
  taskId: string;
  reviewItemId: string;
  review: ReviewPayload;
  by: string;
  ts: number;
}

/**
 * The docIds a ticket item points at. The item's own detail wins: an ask that
 * names a page is about that page, and falling back to the task's links then
 * would dock a question about doc A on doc B. An ask that names no page is
 * about the task, so it docks on whatever the task itself links.
 */
export function itemLinkedDocIds(detail: string | undefined, taskLinks: Ref[]): string[] {
  const fromDetail = extractWorkspaceLinks(detail ?? '').flatMap(({ link }) =>
    link.kind === 'doc' || link.kind === 'mockup' ? [link.docId] : [],
  );
  if (fromDetail.length > 0) return fromDetail;
  return taskLinks.flatMap((ref) => {
    if (ref.kind === 'doc' || ref.kind === 'thread') return [ref.docId];
    if (ref.kind !== 'url') return [];
    return extractWorkspaceLinks(ref.url).flatMap(({ link }) =>
      link.kind === 'doc' || link.kind === 'mockup' ? [link.docId] : [],
    );
  });
}

/**
 * The open ticket items on `tasks` that link `docId`, in board order.
 * `canonical` maps whatever id a link spells to the doc it names, so a link
 * written with an alias still reaches the page.
 */
export function linkedTaskItems(args: {
  docId: string;
  tasks: Array<Pick<Task, 'id' | 'title' | 'status' | 'links'>>;
  reviewsOf: (taskId: string) => TaskReviewItem[];
  canonical: (docId: string) => string;
}): LinkedDockItem[] {
  const { docId, tasks, reviewsOf, canonical } = args;
  const out: LinkedDockItem[] = [];
  for (const task of tasks) {
    const rows = taskReviewItems([
      {
        id: task.id,
        title: task.title,
        bodyDocId: '',
        done: task.status === 'done',
        reviews: reviewsOf(task.id),
      },
    ]);
    for (const row of rows) {
      if (row.review.ownerOnly) continue;
      const linked = itemLinkedDocIds(row.review.detail, task.links ?? []);
      if (!linked.some((id) => canonical(id) === docId)) continue;
      out.push({
        taskId: task.id,
        reviewItemId: row.reviewItemId,
        review: row.review,
        by: row.askedBy,
        ts: row.askedAt,
      });
    }
  }
  return out;
}

/**
 * The data block the widget reads. `type="application/json"` so the browser
 * never runs it, and every `<` escaped so a headline cannot close the element
 * early. Nothing is written when there is nothing linked: a page no open item
 * links carries exactly the bytes it did before.
 */
export function linkedItemsEmbed(items: LinkedDockItem[]): string {
  if (items.length === 0) return '';
  const json = JSON.stringify(items).replace(/</g, '\\u003c');
  return `<script type="application/json" data-cw-linked-items>${json}</script>`;
}

/** Last `</body>`, case-insensitive — the insertion point when there is one. */
const BODY_CLOSE = /<\/body\s*>(?![\s\S]*<\/body\s*>)/i;

/** `html` with the data block added before `</body>`, or appended. */
export function injectLinkedItems(html: string, items: LinkedDockItem[]): string {
  const embed = linkedItemsEmbed(items);
  if (!embed) return html;
  if (BODY_CLOSE.test(html)) return html.replace(BODY_CLOSE, `${embed}$&`);
  return `${html}${embed}`;
}
