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
 * Calm: a steady word on the card. The pin of a comment being worked on
 * breathes, slowly — the one motion, chosen by the owner on the
 * comment-states mock — and holds still under reduced motion.
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

/** The card's state word: the one marker of the mark on a card. Absent on an
 *  unmarked card, so the card's times line up as they always have. */
export function progressSlot(t: Thread): string {
  const p = t.progress;
  const title = p ? ` title="${esc(p.by.name)} · ${formatTime(p.at)}"` : '';
  return `<span class="cw-state" data-state="${p?.state ?? 'open'}"${title}>${p ? LABEL[p.state] : ''}</span>`;
}

/** The opened thread's line saying who is on it, above the reply box; and on
 *  a done thread, Resolve is the button that leads. The line's room is there,
 *  empty, on every opened thread, so Reply and Resolve do not move when an
 *  agent's mark arrives as the reader goes to tap one. */
export function decorateProgress(pop: HTMLElement, t: Thread): void {
  const p = t.progress;
  const actions = pop.querySelector('.actions');
  if (!actions || pop.querySelector('.cw-progress')) return;
  const who = p ? esc(p.by.name) : '';
  const at = p ? formatTime(p.at) : '';
  actions.insertAdjacentHTML(
    'beforebegin',
    `<div class="cw-progress" data-state="${p?.state ?? 'open'}">${
      !p
        ? ''
        : p.state === 'done'
          ? `${who} marked this done · ${at}. Resolve it when you are happy, or reply to send it back.`
          : `${who} is working on this · ${at}`
    }</div>`,
  );
  if (p?.state === 'done') {
    actions.querySelector('.submit')?.classList.remove('primary');
    actions.querySelector('.resolve')?.classList.add('primary');
  }
}

/** When each thread's mark was last seen to change, per widget, so a Done
 *  check draws on the transition and not on every rebuild of the pin. */
const seen = new WeakMap<FeedbackWidgetEl, Map<string, { state: string; at: number | null }>>();

/** The check's draw: .12s wait, then .55s (`.cw-draw`, `comment-view-css.ts`). */
const DRAW_WAIT_MS = 120;
const DRAW_MS = 670;

const DOTS =
  '<span class="cw-pg"><i class="cw-breathe"></i><i class="cw-breathe"></i><i class="cw-breathe"></i></span>';
const check = (cls: string, delay: string) =>
  `<span class="cw-pg"><svg viewBox="0 0 16 16" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path class="cw-check${cls}" pathLength="1" d="M4.2 8.4l2.5 2.5L11.9 5.6"${delay}/></svg></span>`;

/** Each pin wears its thread's mark. The budgeted bundle draws the pins and
 *  knows only open and resolved; this runs after it, on every render, and
 *  every render builds every pin afresh.
 *
 *  Working: three breathing dots. Done: a white check, drawn once on the
 *  transition this page saw, as the comment-states mock does (it keeps the
 *  pin, so "a check that drew itself once stays drawn"). A pin already Done
 *  when the page first reads it shows the check drawn, with no motion; a
 *  rebuild during the draw continues it rather than restarting it. */
export function markPins(el: FeedbackWidgetEl, rows: ThreadRow[]): void {
  let marks = seen.get(el);
  if (!marks) seen.set(el, (marks = new Map()));
  const now = Date.now();
  for (const r of rows) {
    const p = r.thread.progress;
    const state = p?.state ?? 'open';
    const prev = marks.get(r.thread.id);
    const at = state !== 'done' ? null : prev?.state === 'done' ? prev.at : prev ? now : null;
    marks.set(r.thread.id, { state, at });
    if (!p) continue;
    const pin = el.pinLayer?.querySelector<HTMLElement>(
      `.cfw-pin[data-thread-id="${CSS.escape(r.thread.id)}"]`,
    );
    if (!pin) continue;
    pin.dataset.state = p.state;
    if (pin.querySelector('.cw-pg')) continue;
    const since = at === null ? DRAW_MS : now - at;
    const drawing = since < DRAW_MS;
    pin.insertAdjacentHTML(
      'beforeend',
      p.state === 'working'
        ? DOTS
        : check(
            drawing ? ' cw-draw' : '',
            drawing && since ? ` style="animation-delay:${DRAW_WAIT_MS - since}ms"` : '',
          ),
    );
  }
}
