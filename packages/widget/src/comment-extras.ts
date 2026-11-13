import { readLinkedItem } from '@claude-workspaces/core/linked-item';
import { PROGRESS_KEY, readThreadProgress } from '@claude-workspaces/core/thread-progress';
import type { LinkedReviewItem, Thread } from '@claude-workspaces/core/types';
import { escapeHtml as esc, formatTime } from '@claude-workspaces/core/ui-shared';
import type * as Y from 'yjs';
import type { ThreadRow } from './widget-threads.ts';
import type { FeedbackWidgetEl } from './widget.ts';

/**
 * What the comment view reads off a thread that the budgeted bundle's reader
 * has no bytes left for: each comment's linked review item, and the agent's
 * mark on the thread — working on it, or done (`thread-progress.ts` in core).
 * Both are read off the doc here, through core's checkers, so a malformed
 * value is no value at all. Rides in `mic.js` and `mockup-live.js` with
 * `widget-page-list.ts`.
 *
 * The owner asked for the mark after an agent's resolve took a comment off
 * his open page at once: "It's a little sudden, and then it feels like it's
 * getting lost." So the agent marks it, the comment stays, and he resolves.
 * Calm: a steady word and a steady pin, nothing that moves or pulses.
 */

const LABEL = { working: 'In progress', done: 'Done' } as const;

/** `t` with its linked items and its mark, as the doc holds them now. */
export function withExtras(el: FeedbackWidgetEl, t: Thread): Thread {
  const raw = el.client?.ydoc.getMap('threads').get(t.id) as Y.Map<unknown> | undefined;
  const progress = readThreadProgress(raw?.get?.(PROGRESS_KEY));
  const out = progress && t.status === 'open' ? { ...t, progress } : t;
  const cs = raw?.get?.('comments') as Y.Array<Y.Map<unknown>> | undefined;
  if (!cs?.toArray) return out;
  const items = new Map<string, LinkedReviewItem>();
  for (const c of cs.toArray()) {
    const item = readLinkedItem(c.get?.('linkedItem'));
    if (item) items.set(String(c.get('id')), item);
  }
  if (!items.size) return out;
  return {
    ...out,
    comments: out.comments.map((c) => {
      const linkedItem = items.get(c.id);
      return linkedItem ? { ...c, linkedItem } : c;
    }),
  };
}

/** The card's state word, in a slot sized for the widest one and kept, empty,
 *  on a thread with no mark, so nothing beside it moves as the mark changes. */
export function progressSlot(t: Thread): string {
  const p = t.progress;
  const title = p ? ` title="${esc(p.by.name)} · ${formatTime(p.at)}"` : '';
  return `<span class="cw-state" data-state="${p?.state ?? 'open'}"${title}><i></i>${p ? LABEL[p.state] : ''}</span>`;
}

/** The opened thread's line saying who is on it, above the reply box; and on
 *  a done thread, Resolve is the button that leads. */
export function decorateProgress(pop: HTMLElement, t: Thread): void {
  const p = t.progress;
  const actions = pop.querySelector('.actions');
  if (!p || !actions || pop.querySelector('.cw-progress')) return;
  const who = esc(p.by.name);
  const at = formatTime(p.at);
  actions.insertAdjacentHTML(
    'beforebegin',
    `<div class="cw-progress" data-state="${p.state}">${
      p.state === 'done'
        ? `${who} marked this done · ${at}. Resolve it when you are happy, or reply to send it back.`
        : `${who} is working on this · ${at}`
    }</div>`,
  );
  if (p.state === 'done') {
    actions.querySelector('.submit')?.classList.remove('primary');
    actions.querySelector('.resolve')?.classList.add('primary');
  }
}

/** Each pin wears its thread's mark. The budgeted bundle draws the pins and
 *  knows only open and resolved; this runs after it, on every render. */
export function markPins(el: FeedbackWidgetEl, rows: ThreadRow[]): void {
  for (const r of rows) {
    const p = r.thread.progress;
    if (!p) continue;
    const pin = el.pinLayer?.querySelector<HTMLElement>(
      `.cfw-pin[data-thread-id="${CSS.escape(r.thread.id)}"]`,
    );
    if (pin) pin.dataset.state = p.state;
  }
}
