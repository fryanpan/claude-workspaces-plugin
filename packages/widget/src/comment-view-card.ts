import { linkedItemText } from '@claude-workspaces/core/linked-item';
import type { Comment, LinkedReviewItem, Thread } from '@claude-workspaces/core/types';
import { cssColor, escapeHtml as esc, formatTime } from '@claude-workspaces/core/ui-shared';
import { receipt, threadSnippet } from './widget-thread-text.ts';
import type { FeedbackWidgetEl } from './widget.ts';

/**
 * One thread's card in the comment view, folded: what it points at, the
 * first comment and the latest, with the ones between counted in words, each
 * cut at three lines. Opened, the card holds the thread's popover instead
 * (`widget-page-list.ts`), so a reply, a resolve, an ask and a suggestion all
 * work there exactly as they do beside a pin.
 */

/** A linked review item's row: where it lives, its headline, and a link
 *  that opens it on its own board. A steady mark, no badge or motion. */
export function linkedHtml(item: LinkedReviewItem): string {
  return (
    '<div class="cw-linked" data-linked-item>' +
    `<span class="from">Review item · ${esc(item.board)}</span>` +
    `<span class="hl">${esc(item.headline)}</span>` +
    // A board page. No target: inside a mock's frame the bridge points it at
    // the board's hostname and opens it at the top (`mock-bridge.ts`).
    `<a href="${esc(item.url)}">Open item</a>` +
    '</div>'
  );
}

/** A comment's words without the line that only names its linked item:
 *  the row says that, better. */
export function wordsOf(c: Comment): string {
  if (!c.linkedItem) return c.text;
  const line = linkedItemText(c.linkedItem);
  return c.text === line ? '' : c.text.replace(`\n\n${line}`, '');
}

/** `mark` is the latest comment's: a delivery tick says whether anyone has
 *  answered yet, so only the latest wears one. */
function commentHtml(c: Comment, t: Thread, el: FeedbackWidgetEl, mark: boolean): string {
  const words = wordsOf(c);
  return (
    '<div class="cw-c">' +
    `<div class="author"><span class="swatch" style="background:${cssColor(c.author.color)}"></span>` +
    `<b>${esc(c.author.name)}</b><span class="time">${formatTime(c.ts)}</span>${mark ? receipt(c, t, el) : ''}</div>` +
    (words ? `<div class="body">${esc(words)}</div>` : '') +
    (c.linkedItem ? linkedHtml(c.linkedItem) : '') +
    '</div>'
  );
}

/** The folded card's inside. */
export function foldedHtml(t: Thread, el: FeedbackWidgetEl, where: string): string {
  const n = t.comments.length;
  const first = t.comments[0];
  const last = t.comments[n - 1];
  let body = first ? commentHtml(first, t, el, n === 1) : '';
  if (n > 2) {
    body += `<button class="cw-more" data-expand>Show ${n - 2} earlier ${n - 2 === 1 ? 'reply' : 'replies'}</button>`;
    // A linked item in a hidden middle comment still shows.
    for (const c of t.comments.slice(1, -1)) if (c.linkedItem) body += linkedHtml(c.linkedItem);
  }
  if (n > 1 && last) body += commentHtml(last, t, el, true);
  return (
    `<div class="meta"><span class="dot"></span><span class="author-name">${esc(t.createdBy.name)}</span>` +
    `<span class="time">${formatTime(last?.ts ?? 0)}</span></div>` +
    `<div class="snippet">${esc(threadSnippet(t.anchor))}</div>` +
    body +
    (where ? `<div class="where">${esc(where)}</div>` : '')
  );
}

/** The opened card's header, above the popover's body. */
export function openHeadHtml(t: Thread, where: string): string {
  return (
    `<div class="meta"><span class="dot"></span><span class="author-name">${esc(t.createdBy.name)}</span></div>` +
    `<div class="snippet">${esc(threadSnippet(t.anchor))}</div>` +
    (where ? `<div class="where">${esc(where)}</div>` : '')
  );
}

/**
 * Give an opened thread's popover its linked items: the budgeted bundle
 * draws each comment as its words alone. The row goes after the comment that
 * carries it, and the line that only names the item comes out of the words.
 */
export function decorateLinked(pop: HTMLElement, t: Thread): void {
  const rows = pop.querySelectorAll<HTMLElement>('.comments > .comment');
  t.comments.forEach((c, i) => {
    const row = rows[i];
    if (!c.linkedItem || !row || row.querySelector('[data-linked-item]')) return;
    const body = row.querySelector<HTMLElement>('.body');
    const words = wordsOf(c);
    if (body && words !== c.text) {
      if (words) body.textContent = words;
      else body.remove();
    }
    row.insertAdjacentHTML('beforeend', linkedHtml(c.linkedItem));
  });
}
