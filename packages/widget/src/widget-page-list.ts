import { contextMatches, samePage } from '@claude-workspaces/core/anchor/context';
import type { AnchorContext, Thread } from '@claude-workspaces/core/types';
import { escapeHtml as esc, formatTime } from '@claude-workspaces/core/ui-shared';
import { refreshAnchors } from './widget-anchor-refresh.ts';
import { goTo, takeGoTo } from './widget-goto.ts';
import { receipt, threadSnippet } from './widget-thread-text.ts';
import type { ThreadRow } from './widget-threads.ts';
import type { FeedbackWidgetEl } from './widget.ts';

/**
 * The widget panel's list of threads: this page's, newest first, and a tap
 * on one takes the reader to it.
 *
 * The owner, on an app whose controls live in its address: "I can't see where
 * I made comments on the page. It's very disorienting." The list used to hold
 * every thread on the doc, oldest first, and a tap scrolled only when the
 * thread's pin happened to be drawn. Now:
 *
 * - **This page** holds the threads made on this path, in any state of it.
 *   A row made with other controls set says so, and its tap loads that
 *   address (`widget-goto.ts`); the page that loads shows the thread.
 * - **No spot on the page** holds the ones made in this very state whose
 *   element the page no longer has, so a comment never vanishes with it.
 * - **Other pages** holds the rest, each tap going to its page.
 *
 * Showing a thread scrolls its element to the middle, opens its popover
 * beside its pin and rings the pin. The ring is steady and goes at the next
 * tap on the page: calm, per the owner, so nothing pulses to say where to look.
 *
 * It rides in `mic.js` and `mockup-live.js`, with `widget-ask.ts`, and the
 * board mounts it beside its mic; the budgeted bundle hands each render's
 * threads to `listHook` and draws no list of its own.
 */

const CSS =
  '.where{font-size:11px;color:#6e7781;margin-top:4px}' + '[data-section]{display:contents}';

/** The steady ring on the pin being shown, in the page's own sheet: pins are
 *  drawn in the light DOM. */
const PIN_CSS =
  '.cfw-pin[data-hl]:after{content:"";position:absolute;left:5px;top:2px;width:34px;height:34px;box-sizing:border-box;border-radius:50%;border:3px solid #2e7dd7}' +
  '.cfw-pin[data-hl]{opacity:1}';

/** The context a thread was made in, an orphan's from its original anchor. */
function contextOf(t: Thread): AnchorContext | undefined {
  const a = t.anchor;
  if (a.kind === 'orphan') return (a.original as { context?: AnchorContext }).context;
  return 'context' in a ? a.context : undefined;
}

/** On the page the reader is on: no page of its own, or this path. */
function onThisPage(t: Thread, cur: AnchorContext): boolean {
  const c = contextOf(t);
  return contextMatches(c, cur) || samePage(c, cur);
}

export function mountPageList(el: FeedbackWidgetEl): void {
  if (el.listHook || !el.shadow) return;
  const style = document.createElement('style');
  style.textContent = CSS;
  el.shadow.append(style);
  if (!document.querySelector('style[data-cw-page-list]')) {
    const pin = document.createElement('style');
    pin.setAttribute('data-cw-page-list', '');
    pin.textContent = PIN_CSS;
    document.head.append(pin);
  }
  /** The thread whose pin is ringed, until the next tap on the page. */
  let ringed: string | null = null;
  const ring = (): void => {
    for (const p of el.pinLayer?.children ?? []) {
      const pin = p as HTMLElement;
      pin.toggleAttribute('data-hl', !!ringed && pin.dataset.threadId === ringed);
    }
  };
  document.addEventListener(
    'pointerdown',
    (ev) => {
      const t = ev.target as Element | null;
      if (t?.closest?.('claude-feedback-widget,.cfw-overlay')) return;
      ringed = null;
      ring();
    },
    true,
  );

  /** The thread a `goTo` asked for, until the page is in its state. */
  let wanted: string | null = null;
  const take = (): void => {
    const got = takeGoTo(location.pathname + location.search + location.hash);
    if (!got) return;
    wanted = got.id;
    // The widget's own history hook hears this and moves its context to the
    // address the thread was made at, which re-renders the pins.
    history.replaceState(history.state, '', got.rest);
  };
  take();

  el.listHook = (rows, open) => {
    const show = (t: Thread): void => {
      ringed = t.id;
      el.activeThread = t.id;
      // At once rather than smoothly, so the popover opens beside the spot
      // where it now is.
      el.threadPositions.get(t.id)?.el.scrollIntoView({ block: 'center' });
      open(t);
      ring();
    };
    const go = (t: Thread): void => {
      const url = contextOf(t)?.url;
      if (url && url !== el.currentContext?.url && t.anchor.kind !== 'subject') goTo(url, t.id);
      else show(t);
    };
    take();
    renderList(el, rows, go);
    // What each pinned element says now, for the next round of a rewritten mock.
    refreshAnchors(el, rows);
    // Shown once it is listed and the widget's context has caught up with the
    // address; dropped if the reader is somewhere else by then.
    const cur = el.currentContext ?? {};
    const row =
      wanted && !cur.url?.includes('cw-goto=')
        ? rows.find((r) => r.thread.id === wanted)
        : undefined;
    if (row) {
      wanted = null;
      if (contextMatches(contextOf(row.thread), cur)) show(row.thread);
    }
    ring();
  };
  el.scheduleRender();
}

function renderList(el: FeedbackWidgetEl, rows: ThreadRow[], go: (t: Thread) => void): void {
  const list = el.shadow.querySelector('.panel-threads') as HTMLElement | null;
  if (!list) return;
  list.innerHTML = '';
  if (rows.length === 0) {
    const e = document.createElement('div');
    e.className = 'empty';
    e.textContent = 'No comments yet. Tap the bubble, then click anything on the page.';
    list.appendChild(e);
    return;
  }
  const cur = el.currentContext ?? {};
  const newest = [...rows].sort(
    (a, b) => (b.thread.comments[0]?.ts ?? 0) - (a.thread.comments[0]?.ts ?? 0),
  );
  const here = newest.filter((r) => onThisPage(r.thread, cur));
  const away = newest.filter((r) => !onThisPage(r.thread, cur) && r.status !== 'resolved');
  const resolved = newest.filter((r) => r.status === 'resolved');
  const section = (key: string, title: string, group: ThreadRow[]): void => {
    if (!group.length) return;
    const s = document.createElement('div');
    s.dataset.section = key;
    s.innerHTML = `<div class="section-heading">${title} (${group.length})</div>`;
    for (const r of group) s.appendChild(renderRow(el, r, cur, go));
    list.appendChild(s);
  };
  section(
    'page',
    'This page',
    here.filter((r) => r.status === 'open'),
  );
  section(
    'nospot',
    'No spot on the page',
    here.filter((r) => r.status === 'orphan'),
  );
  section('away', 'Other pages', away);
  if (!resolved.length) return;
  const toggle = document.createElement('button');
  toggle.className = 'resolved-toggle';
  toggle.textContent = `${el.showResolved ? 'Hide' : 'Show'} resolved (${resolved.length})`;
  toggle.addEventListener('click', () => {
    el.showResolved = !el.showResolved;
    localStorage.setItem('cfw:showResolved', el.showResolved ? '1' : '0');
    // Rerender to show or hide the resolved group and its pins
    el.scheduleRender();
  });
  list.appendChild(toggle);
  if (el.showResolved) section('resolved', 'Resolved', resolved);
}

function renderRow(
  el: FeedbackWidgetEl,
  r: ThreadRow,
  cur: AnchorContext,
  go: (t: Thread) => void,
): HTMLElement {
  const t = r.thread;
  const row = document.createElement('div');
  row.className = `thread status-${r.status}`;
  // Which thread, for what the page's scripts add to a row (`widget-ask.ts`).
  row.dataset.threadId = t.id;
  if (el.activeThread === t.id) row.classList.add('active');
  const last = t.comments[t.comments.length - 1];
  const ctx = contextOf(t);
  const where = !onThisPage(t, cur)
    ? `On ${(ctx?.url ?? '').split(/[?#]/)[0]}`
    : ctx?.url && !contextMatches(ctx, cur)
      ? 'Another view of this page'
      : '';
  row.innerHTML =
    '<div class="meta">' +
    '<span class="dot"></span>' +
    `<span class="author-name">${esc(t.createdBy.name)}</span>` +
    `<span class="time">${formatTime(last?.ts ?? 0)}</span>` +
    receipt(last, t, el) +
    '</div>' +
    `<div class="snippet">${esc(threadSnippet(t.anchor))}</div>` +
    `<div class="last">${esc(last?.text ?? '')}</div>` +
    (where ? `<div class="where">${esc(where)}</div>` : '');
  row.addEventListener('click', () => go(t));
  return row;
}
