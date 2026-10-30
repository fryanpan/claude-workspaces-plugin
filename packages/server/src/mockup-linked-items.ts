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
 * items and done tickets. An owner-only item goes to the owner alone, the
 * board's rule for who is asked it (`share/board-role.ts`); everyone else's
 * page never carries it. On a mock it carries `answerAt`, the task on the
 * board, and a link there at the end of its words in place of its options:
 * the mock's own scripts reach the board through the host as the reader
 * (`mockup-frame.ts`), and an ask only the owner may answer must not be
 * answerable by a page an agent wrote. On the doc page it does too when its
 * answer has a door of its own — an access change, a secret, a grant — which
 * the dock's one answer box is not.
 */
import { type TaskReviewItem, extractWorkspaceLinks } from '@claude-workspaces/core';
import type { ReviewAccessChange } from '@claude-workspaces/core/review-access';
import type { LinkedDockItem } from '@claude-workspaces/core/review-dock';
import type { Ref, Task } from '@claude-workspaces/core/task-wire';
import { taskReviewItems } from './review-queue.ts';

/** One ticket item as the dock receives it — one wire shape for both pages. */
export type { LinkedDockItem };

/**
 * The docIds a ticket item points at. The item's own detail wins: an ask that
 * names a page is about that page, and falling back to the task's links then
 * would dock a question about doc A on doc B. An ask that names no page is
 * about the task, so it docks on whatever the task itself links.
 */
export function itemLinkedDocIds(detail: string | undefined, taskLinks: Ref[]): string[] {
  const fromDetail = extractWorkspaceLinks(detail ?? '').flatMap(({ link }) =>
    link.kind === 'doc' || link.kind === 'mockup' || link.kind === 'whiteboard' ? [link.docId] : [],
  );
  if (fromDetail.length > 0) return fromDetail;
  return taskLinks.flatMap((ref) => {
    if (ref.kind === 'doc' || ref.kind === 'thread') return [ref.docId];
    if (ref.kind !== 'url') return [];
    return extractWorkspaceLinks(ref.url).flatMap(({ link }) =>
      link.kind === 'doc' || link.kind === 'mockup' || link.kind === 'whiteboard'
        ? [link.docId]
        : [],
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
  /** Items about this page whatever they link — a run's output item waiting
   *  on the file it holds — which the reader may mark read. */
  readable?: ReadonlySet<string>;
  /** The reader is the board's owner, so owner-only items are theirs too. */
  owner?: boolean;
  /** The page may answer a plain owner-only item in place: the doc page,
   *  never a mock. */
  ownerAnswersHere?: boolean;
  /** The board's link to a task, for an owner-only item this page shows but
   *  may not answer. Without it such an item is left off. */
  answerAt?: (taskId: string) => string;
}): LinkedDockItem[] {
  const { docId, tasks, reviewsOf, canonical, readable, owner, ownerAnswersHere, answerAt } = args;
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
      const ownerOnly = row.review.ownerOnly === true;
      if (ownerOnly && !owner) continue;
      const elsewhere = ownerOnly && (!ownerAnswersHere || hasOwnDoor(row));
      if (elsewhere && !answerAt) continue;
      const markRead = readable?.has(row.reviewItemId) === true;
      const linked = [...itemLinkedDocIds(row.review.detail, task.links ?? []), ...landingOf(row)];
      if (!markRead && !linked.some((id) => canonical(id) === docId)) continue;
      // Answered elsewhere: the link there ends the ask's own words, which
      // the dock already renders links in, and the dock draws no controls.
      const at = elsewhere && answerAt ? answerAt(task.id) : undefined;
      out.push({
        taskId: task.id,
        reviewItemId: row.reviewItemId,
        review: at
          ? { ...row.review, detail: `${row.review.detail}\n\n[Answer on the board](${at})` }
          : row.review,
        by: row.askedBy,
        ts: row.askedAt,
        ...(markRead ? { markRead: true } : {}),
        ...(at ? { answerAt: at } : {}),
      });
    }
  }
  return out;
}

/** An item answered through a door of its own rather than `/answer`. */
function hasOwnDoor(row: { access?: unknown; review: { shape?: string } }): boolean {
  return row.access !== undefined || row.review.shape === 'secret' || row.review.shape === 'grant';
}

/** The doc a proposed share link opens on: its card is about that page too. */
function landingOf(row: { access?: ReviewAccessChange }): string[] {
  const landing = row.access?.op === 'share-link' ? row.access.link.landing : undefined;
  return landing?.id && (landing.kind === 'doc' || landing.kind === 'mockup') ? [landing.id] : [];
}

/**
 * The open ticket items on one board's tasks that link `docId` — what the doc
 * record's `linkedItems` carries for the doc page's dock. The stores are
 * structural so this module keeps no import of either.
 */
export function boardLinkedItems(
  workspaceId: string,
  docId: string,
  taskStore: {
    listTasks(workspaceId: string): Array<Pick<Task, 'id' | 'title' | 'status' | 'links'>>;
    listReviewItems(taskId: string): TaskReviewItem[];
  },
  docStore: { resolveDocId(docId: string): string },
  readable?: ReadonlySet<string>,
  owner = false,
): LinkedDockItem[] {
  const board = `/workspaces/${encodeURIComponent(workspaceId)}`;
  return linkedTaskItems({
    docId,
    tasks: taskStore.listTasks(workspaceId),
    reviewsOf: (taskId) => taskStore.listReviewItems(taskId),
    canonical: (id) => docStore.resolveDocId(id),
    ...(readable ? { readable } : {}),
    owner,
    ownerAnswersHere: true,
    answerAt: (taskId) => `${board}?task=${encodeURIComponent(taskId)}`,
  });
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
