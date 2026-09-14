import { listThreads } from '@claude-workspaces/core';
import {
  type DockItem,
  dockBarHtml,
  dockItems,
  dockRounds,
  dockSheetHtml,
  linkedDockItems,
  wireDockSheet,
} from '@claude-workspaces/core/review-dock';
import { authedPost, httpBase } from './widget-auth.ts';
import type { FeedbackWidgetEl } from './widget.ts';

/**
 * The review-item DOCK — an ask, on the page it is about.
 *
 * A review item raised on a mockup used to live only on the ticket, so the
 * reader opened the mock, looked at it, and then had to leave for the Home
 * queue to say what they thought. The ask belongs where the thing is: this
 * puts it in a bar across the bottom of the page the item was raised on, and
 * lets it be answered there.
 *
 * Nothing new is fetched. The widget already syncs the doc's threads, and a
 * review item IS a payload on a comment (`Comment.review`), so the dock reads
 * the same CRDT the pins and the panel read. The answer goes back through the
 * route the doc page already uses — `POST …/threads/:id/answer` — for the
 * same reason: two doors onto "this item is answered" would be free to
 * disagree about what answered means.
 *
 * Which asks dock, the markup and the sheet are `core/review-dock.ts`, shared
 * with the doc page's dock; what is left here is the widget's own half —
 * where the items come from, and the requests an answer makes.
 */

export {
  type DockItem,
  type DockRound,
  dockItems,
  dockRounds,
} from '@claude-workspaces/core/review-dock';

/**
 * The ticket items the server found linking this page, handed out in the
 * page itself (`mockup-linked-items.ts`) — nothing is fetched for them.
 * Empty when the page carries no block, or one that does not parse.
 */
export function readLinkedItems(doc: Document): DockItem[] {
  try {
    const raw = doc.querySelector('script[data-cw-linked-items]')?.textContent;
    return raw ? linkedDockItems(JSON.parse(raw)) : [];
  } catch {
    return [];
  }
}

/** Which thread a URL asks to be opened on, if any — see `board-queue-open`. */
export function deepLinkThread(search: string): string | null {
  try {
    return new URLSearchParams(search).get('thread');
  } catch {
    return null;
  }
}

/**
 * Answer a ticket item through the ticket's own route — the door the Home
 * queue answers through, so the answer lands on the task and wakes its agent
 * exactly as an answer given there does. `answeredWith` is that route's
 * spelling of the option an answer was tapped from.
 */
async function postTaskAnswer(
  el: FeedbackWidgetEl,
  item: DockItem,
  text: string,
  optionId?: string,
): Promise<boolean> {
  const res = await authedPost(
    el,
    `${httpBase(el)}/workspaces/${encodeURIComponent(el.opts.workspaceId)}/tasks/${encodeURIComponent(
      item.taskId ?? '',
    )}/review-items/${encodeURIComponent(item.threadId)}/answer`,
    () => ({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        author: el.user,
        text,
        ...(optionId !== undefined ? { answeredWith: optionId } : {}),
      }),
    }),
  );
  return res.ok;
}

/** Open the expanded item — the rounds, and the way to answer it. */
export function openDockItem(el: FeedbackWidgetEl, item: DockItem): void {
  el.shadow.querySelector('.cw-dock-scrim')?.remove();
  const scrim = document.createElement('div');
  scrim.className = 'cw-dock-scrim';
  scrim.innerHTML = dockSheetHtml(item);
  el.shadow.appendChild(scrim);
  wireDockSheet(scrim, {
    send: (text, optionId) =>
      item.taskId
        ? postTaskAnswer(el, item, text, optionId)
        : el.postAnswer(item.threadId, item.commentId, text, optionId),
    onAnswered: () => {
      // A ticket item is not in this page's threads, so no sync will retire
      // it: drop it here, and the dock clears without the page moving.
      if (item.taskId) {
        el.linkedItems = el.linkedItems.filter((i) => i !== item);
        el.scheduleRender();
      }
    },
  });
}

/**
 * Paint the dock. Called from the widget's one render loop.
 *
 * The bar is rebuilt only when what it says changes, so a host page that
 * mutates its DOM every frame does not restyle the dock every frame — and,
 * more importantly, does not steal a tap that landed mid-rebuild.
 */
export function renderDockInto(el: FeedbackWidgetEl): void {
  if (!el.client) return;
  const items = dockItems(listThreads(el.client.ydoc), el.linkedItems);
  const item = items[0];
  let bar = el.shadow.querySelector('.cw-dock') as HTMLElement | null;
  if (!item) {
    bar?.remove();
    el.style.setProperty('--cw-dock-h', '0px');
    return;
  }
  const sig = [
    item.threadId,
    item.commentId,
    dockRounds(item.review).length,
    item.answered,
    item.review.headline,
  ].join(' ');
  if (!bar) {
    bar = document.createElement('div');
    bar.className = 'cw-dock';
    el.shadow.appendChild(bar);
  }
  if (bar.dataset.sig !== sig) {
    bar.dataset.sig = sig;
    bar.innerHTML = dockBarHtml(item);
    bar.querySelector('.cw-dock-item')?.addEventListener('click', () => openDockItem(el, item));
  }
  // Measured, never assumed — the FAB and the panel sit above whatever height
  // the bar actually takes at this width, and the headline wraps at 430.
  el.style.setProperty('--cw-dock-h', `${Math.round(bar.getBoundingClientRect().height)}px`);

  // The deep link, once. A Home-queue row for this item opens the MOCK with
  // `?thread=`, and landing on the page with the ask still shut would be the
  // "now go find it" the queue exists to remove.
  if (el.pendingDockThread) {
    const wanted = items.find((i) => i.threadId === el.pendingDockThread);
    if (wanted) {
      el.pendingDockThread = null;
      openDockItem(el, wanted);
    }
  }
}
