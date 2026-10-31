import { contextMatches } from '@claude-workspaces/core/anchor/context';
import { readLinkedItem } from '@claude-workspaces/core/linked-item';
import type { LinkedReviewItem, Thread } from '@claude-workspaces/core/types';
import { escapeHtml as esc } from '@claude-workspaces/core/ui-shared';
import type * as Y from 'yjs';
import { seenStore } from './comment-seen-store.ts';
import { decorateLinked, foldedHtml, openHeadHtml } from './comment-view-card.ts';
import { PAGE_CSS, VIEW_CSS } from './comment-view-css.ts';
import {
  type ViewModel,
  type ViewRow,
  buildView,
  contextOf,
  isNewTo,
  openCounts,
  pageKey,
  pageName,
} from './comment-view-model.ts';
import { mountBadges, pageLinks } from './link-badges.ts';
import { refreshAnchors } from './widget-anchor-refresh.ts';
import { goTo, takeGoTo } from './widget-goto.ts';
import { IGNORE_ATTR } from './widget-picker.ts';
import type { ThreadRow } from './widget-threads.ts';
import type { FeedbackWidgetEl } from './widget.ts';

/**
 * The comment view: every thread on the doc, the new ones first, then one
 * group per page, and a tap on one takes the reader to it.
 *
 * The owner, on a mock with several pages: the popover was hard to read and
 * showed little of each thread, and comments on other pages were hard to
 * find. So:
 *
 * - **New** holds every open thread with something from someone else since
 *   the reader last opened it, from any page. Opening one clears it, and it
 *   stays where it is until another is opened, so the card does not jump.
 * - **One group per page** follows, in the order the page links to them
 *   (`comment-view-model.ts`). The page the reader is on says so; the others
 *   offer "Go to". A chip per page above the list jumps to its group.
 * - **A card** shows the first comment and the latest; tapped, it opens in
 *   place holding the thread's popover — reply, resolve, an ask, a
 *   suggestion — and the page goes to the thread's page and spot, its pin
 *   ringed. On a phone the opened thread fills a half-height sheet on its
 *   own, with "All comments" back to the list where it was.
 * - **Links** to other pages wear a round count of their open threads
 *   (`link-badges.ts`).
 * - Inside a mock on the board, the way in is the Comments button in the
 *   board's bar above the mock, which shows a steady dot while anything is
 *   new (`mock-host.ts`); the bridge carries the two messages.
 *
 * Opening the view always starts at the top. Calm, per the owner: steady
 * marks, no counts on New, nothing that pulses. A pin tap opens its thread
 * here too.
 *
 * It rides in `mic.js` and `mockup-live.js` with `widget-ask.ts`, and the
 * board mounts it beside its mic; the budgeted bundle hands each render's
 * threads to `listHook` and draws no list of its own.
 */

/** The bridge's line to the board's bar around a mock (`mock-bridge.ts`). */
interface HostBar {
  tell(state: { open: boolean; fresh: boolean }): void;
}

/**
 * `t` with each comment's linked review item, read off the doc here rather
 * than by the budgeted bundle's thread reader, which has no bytes left for
 * it. Read through core's checker, so a malformed one is no item at all.
 */
function withLinked(el: FeedbackWidgetEl, t: Thread): Thread {
  const raw = el.client?.ydoc.getMap('threads').get(t.id) as Y.Map<unknown> | undefined;
  const cs = raw?.get?.('comments') as Y.Array<Y.Map<unknown>> | undefined;
  if (!cs?.toArray) return t;
  const items = new Map<string, LinkedReviewItem>();
  for (const c of cs.toArray()) {
    const item = readLinkedItem(c.get?.('linkedItem'));
    if (item) items.set(String(c.get('id')), item);
  }
  if (!items.size) return t;
  return {
    ...t,
    comments: t.comments.map((c) => {
      const linkedItem = items.get(c.id);
      return linkedItem ? { ...c, linkedItem } : c;
    }),
  };
}

const narrow = (): boolean => matchMedia('(max-width: 1100px)').matches;

export function mountPageList(el: FeedbackWidgetEl): void {
  if (el.listHook || !el.shadow) return;
  const shadow = el.shadow;
  const style = document.createElement('style');
  style.textContent = VIEW_CSS;
  shadow.append(style);
  if (!document.querySelector('style[data-cw-page-list]')) {
    const page = document.createElement('style');
    page.setAttribute('data-cw-page-list', '');
    page.textContent = PAGE_CSS;
    document.head.append(page);
  }
  const panel = shadow.querySelector<HTMLElement>('.panel');
  const list = shadow.querySelector<HTMLElement>('.panel-threads');
  const title = panel?.querySelector('.panel-header .title');
  if (title) title.textContent = 'Comments';
  const sub = document.createElement('span');
  sub.className = 'cw-sub';
  title?.after(sub);
  const chips = document.createElement('div');
  chips.className = 'cw-pages';
  panel?.querySelector('.panel-header')?.after(chips);

  const badgeLayer = document.createElement('div');
  badgeLayer.setAttribute(IGNORE_ATTR, '');
  document.body.append(badgeLayer);
  const badges = mountBadges(badgeLayer);

  const seen = seenStore(el.opts?.docId ?? '');
  const inFrame = window.parent !== window;
  const host = (window as unknown as { cwHostBar?: HostBar }).cwHostBar ?? null;
  if (host) el.setAttribute('data-cw-host-bar', '');

  /** The thread opened in the view, the one kept under New, the one just
   *  resolved, and where the list was scrolled before a phone opened one. */
  let kept: string | null = null;
  let justResolved: string | null = null;
  let listScroll = 0;
  let model: ViewModel | null = null;
  let threads = new Map<string, Thread>();
  let lastRows: ThreadRow[] = [];
  let openPop: (t: Thread) => void = () => {};
  let drawn = '';
  /** Watches the opened popover for closing itself; off while a redraw
   *  takes it away. */
  let popWatch: MutationObserver | null = null;

  const isOpen = (): boolean => !!panel?.classList.contains('open');
  const tellHost = (): void => {
    host?.tell({ open: isOpen(), fresh: !!model?.fresh.some((r) => r.isNew) });
    document.documentElement.classList.toggle('cw-view-open', inFrame && isOpen());
  };
  const toggle: (force?: boolean) => void =
    el.togglePanel?.bind(el) ?? ((force) => panel?.classList.toggle('open', force ?? !isOpen()));
  el.togglePanel = (force?: boolean): void => {
    const was = isOpen();
    toggle(force);
    if (isOpen() && !was && list) {
      // Opening always starts at the top, on New.
      list.scrollTop = 0;
    }
    if (!isOpen()) {
      el.activeThread = null;
      drawn = '';
    }
    render();
    tellHost();
  };
  addEventListener('cw-comments', () => el.togglePanel());

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
  // A pin opens its thread here rather than in a popover beside it. A dimmed
  // pin still goes to the state it was made in.
  document.addEventListener(
    'click',
    (ev) => {
      const pin = (ev.target as Element | null)?.closest?.('.cfw-pin') as HTMLElement | null;
      const t = pin && !pin.hasAttribute('data-dim') && threads.get(pin.dataset.threadId ?? '');
      if (!t) return;
      ev.stopPropagation();
      if (!isOpen()) toggle(true);
      show(t);
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

  const latest = (t: Thread): number => t.comments[t.comments.length - 1]?.ts ?? 0;

  /** Open `t` in the view, on this page: its spot, its pin, its card. */
  function show(t: Thread): void {
    if (narrow() && !el.activeThread && list) listScroll = list.scrollTop;
    if (justResolved !== t.id) justResolved = null;
    const fresh = model?.fresh.some((r) => r.id === t.id) ?? false;
    kept = fresh || kept === t.id ? t.id : null;
    el.activeThread = t.id;
    ringed = t.id;
    seen.mark(t.id, latest(t));
    // At once rather than smoothly; on a phone into the half the sheet
    // leaves showing. Only once the spot has a box: a fragment move fires
    // popstate, which renders this, before the hashchange a page shows its
    // section on, and scrolling to a hidden element does nothing. So look
    // each frame, for up to 1.5s, while this thread is still the open one.
    const until = performance.now() + 1500;
    const reach = (): void => {
      requestAnimationFrame((now) => {
        const spot = el.threadPositions.get(t.id)?.el;
        if (el.activeThread !== t.id) return;
        if (!spot?.getClientRects().length) return void (now < until && reach());
        spot.scrollIntoView({ block: narrow() ? 'start' : 'center' });
        if (narrow()) scrollBy(0, -48);
      });
    };
    reach();
    drawn = '';
    render();
    ring();
    if (narrow() && list) list.scrollTop = 0;
    else
      list
        ?.querySelector(`[data-thread-id="${CSS.escape(t.id)}"]`)
        ?.scrollIntoView({ block: 'nearest' });
    // A card with an exchange can be taller than the list: bring its reply
    // box into view, by hand, since scrollIntoView moves the page too.
    const reply = () => {
      const box = list?.querySelector('.thread.active .thread-popover .actions');
      const over =
        list && box ? box.getBoundingClientRect().bottom - list.getBoundingClientRect().bottom : 0;
      if (list && over > 0) list.scrollTop += over;
    };
    reply();
    requestAnimationFrame(reply);
  }

  /** Go to the page a thread or a page key is on. A move of the fragment
   *  alone stays on this load; anything else loads the address. */
  function goToUrl(url: string, threadId: string | null): void {
    const [path, hash = ''] = url.split(/#(.*)/s);
    const [here] = (el.currentContext.url ?? '').split('#');
    if (path === here) {
      wanted = threadId;
      location.hash = hash;
      return;
    }
    if (threadId) goTo(url, threadId);
    else if (/^\/(?![/\\])/.test(url)) location.assign(url);
  }

  function go(t: Thread): void {
    const url = contextOf(t)?.url;
    if (url && url !== el.currentContext?.url && t.anchor.kind !== 'subject') goToUrl(url, t.id);
    else show(t);
  }

  function back(): void {
    el.activeThread = null;
    drawn = '';
    render();
    if (list) list.scrollTop = listScroll;
  }

  const rowOf = (r: ThreadRow, here: string, read: ReturnType<typeof seen.read>): ViewRow => {
    const t = r.thread;
    const ctx = contextOf(t);
    return {
      id: t.id,
      status: r.status,
      key: t.anchor.kind === 'subject' || !ctx?.url ? here : pageKey(ctx),
      last: latest(t),
      isNew: isNewTo(t, el.user?.id, read, seen),
    };
  };

  function render(): void {
    if (!list) return;
    const cur = el.currentContext ?? {};
    const here = pageKey(cur);
    const links = pageLinks();
    const name = (k: string) => pageName(k, links.get(k)?.[0]?.textContent ?? '');
    // A reply that lands on the thread the reader has open is read already.
    const active = el.activeThread ? threads.get(el.activeThread) : undefined;
    if (active && isOpen()) seen.mark(active.id, latest(active));
    const read = seen.read();
    const rows = lastRows.map((r) => rowOf(r, here, read));
    model = buildView(rows, { here, order: [...links.keys()], kept, justResolved });
    badges.draw(openCounts(rows), here);
    const detail = narrow() && !!active && isOpen();
    panel?.classList.toggle('cw-detail', detail);
    const sig = JSON.stringify([
      lastRows.map((r) => [r.thread.id, r.status, r.thread.comments.length, latest(r.thread)]),
      rows.map((r) => r.isNew),
      here,
      el.activeThread,
      kept,
      justResolved,
      el.showResolved,
      detail,
      isOpen(),
    ]);
    if (sig === drawn) return;
    drawn = sig;
    const m = model;
    sub.textContent = m.open
      ? `${m.open} open on ${m.pageCount} ${m.pageCount === 1 ? 'page' : 'pages'}`
      : '';
    chips.innerHTML = m.pages
      .map((g) => {
        const n = g.rows.filter((r) => r.status !== 'resolved').length + g.underNew;
        const nw = m.fresh.some((r) => r.key === g.key && r.isNew);
        return `<button class="cw-pchip${g.here ? ' here' : ''}" data-chip="${esc(g.key)}"><span class="cw-newdot"${nw ? '' : ' hidden'}></span>${esc(name(g.key))} <span class="n">${n} open</span></button>`;
      })
      .join('');
    // What is typed in an open thread's reply box survives a redraw.
    const box = shadow.querySelector<HTMLTextAreaElement>('.thread-popover textarea');
    const draft = box
      ? { v: box.value, f: shadow.activeElement === box, s: box.selectionStart }
      : null;
    popWatch?.disconnect();
    shadow.querySelector('.thread-popover')?.remove();
    const keep = list.scrollTop;
    list.innerHTML = '';
    /** `grouped`: under its page's own heading, which names the page. */
    const card = (r: ViewRow, grouped = false): HTMLElement => {
      const t = threads.get(r.id) as Thread;
      const div = document.createElement('div');
      div.className = `thread status-${r.status}`;
      div.dataset.threadId = r.id;
      const ctx = contextOf(t);
      const where =
        r.key !== here
          ? grouped
            ? ''
            : `On ${name(r.key)}`
          : ctx?.url && !contextMatches(ctx, cur)
            ? 'Another view of this page'
            : '';
      if (r.id === el.activeThread) {
        div.classList.add('active');
        div.innerHTML = openHeadHtml(t, where);
      } else {
        div.innerHTML = foldedHtml(t, el, where);
        div.addEventListener('click', (ev) => {
          if ((ev.target as Element).closest('a')) return;
          go(t);
        });
      }
      return div;
    };
    const section = (key: string, head: string, cards: ViewRow[], page?: string): HTMLElement => {
      const s = document.createElement('div');
      s.dataset.section = key;
      if (page !== undefined) s.dataset.page = page;
      s.innerHTML = `<div class="section-heading">${head}</div>`;
      for (const r of cards) s.appendChild(card(r, page !== undefined));
      list.appendChild(s);
      return s;
    };
    if (detail && active) {
      list.innerHTML =
        '<div class="cw-back"><button data-back aria-label="Back to all comments">‹ All comments</button></div>';
      const r = rows.find((x) => x.id === active.id);
      if (r) list.appendChild(card(r));
    } else if (!rows.length) {
      list.innerHTML =
        '<div class="empty">No comments yet. Tap the bubble, then click anything on the page.</div>';
    } else {
      if (m.fresh.length) section('new', 'New', m.fresh);
      for (const g of m.pages) {
        const label = esc(name(g.key));
        const head = g.here
          ? `${label}<span class="where">· this page</span>`
          : `${label}<button class="go" data-goto-page="${esc(g.key)}">Go to ${label}</button>`;
        const s = section(g.here ? 'page' : 'away', head, g.rows, g.key);
        if (!g.rows.length) {
          s.insertAdjacentHTML(
            'beforeend',
            `<div class="cw-none">${g.underNew ? `${g.underNew} under New` : 'Nothing open here.'}</div>`,
          );
        }
      }
      if (m.nospot.length) section('nospot', 'No spot on the page', m.nospot);
      if (m.resolved.length) {
        const tg = document.createElement('button');
        tg.className = 'resolved-toggle';
        tg.textContent = `${el.showResolved ? 'Hide' : 'Show'} resolved (${m.resolved.length})`;
        tg.addEventListener('click', () => {
          el.showResolved = !el.showResolved;
          localStorage.setItem('cfw:showResolved', el.showResolved ? '1' : '0');
          // Rerender to show or hide the resolved group and its pins
          el.scheduleRender();
        });
        list.appendChild(tg);
        if (el.showResolved) section('resolved', 'Resolved', m.resolved);
      }
    }
    list.scrollTop = keep;
    // The opened thread: its popover, drawn by the budgeted bundle, in its card.
    const slot =
      active &&
      list.querySelector<HTMLElement>(`.thread.active[data-thread-id="${CSS.escape(active.id)}"]`);
    if (active && slot) {
      openPop(active);
      const pop = shadow.querySelector<HTMLElement>('.thread-popover');
      if (pop) {
        slot.appendChild(pop);
        decorateLinked(pop, active);
        wirePopover(pop, active);
        const ta = pop.querySelector('textarea');
        if (ta && draft) {
          ta.value = draft.v;
          if (draft.f) {
            ta.focus();
            ta.setSelectionRange(draft.s, draft.s);
          }
        }
      }
    }
    tellHost();
  }

  /** The popover closes itself after a reply or a resolve; in the view the
   *  thread stays open, and a resolved one stays in place with Reopen. */
  function wirePopover(pop: HTMLElement, t: Thread): void {
    pop.querySelector('.resolve')?.addEventListener('click', () => {
      justResolved = t.id;
    });
    pop.querySelector('.reopen')?.addEventListener('click', () => {
      justResolved = null;
    });
    popWatch = new MutationObserver((_, obs) => {
      if (pop.isConnected) return;
      obs.disconnect();
      drawn = '';
      el.scheduleRender();
    });
    popWatch.observe(pop.parentElement as Node, { childList: true });
  }

  list?.addEventListener('click', (ev) => {
    const t = ev.target as Element;
    if (t.closest('[data-back]')) return back();
    const gp = t.closest<HTMLElement>('[data-goto-page]');
    if (gp) {
      const key = gp.dataset.gotoPage ?? '';
      const r = model?.pages.find((g) => g.key === key)?.rows[0];
      const url = r && contextOf(threads.get(r.id) as Thread)?.url;
      el.activeThread = null;
      goToUrl(url ?? key.split(' ')[0] ?? '', null);
    }
  });
  chips.addEventListener('click', (ev) => {
    const c = (ev.target as Element).closest<HTMLElement>('[data-chip]');
    if (!c || !list) return;
    const g = [...list.querySelectorAll<HTMLElement>('[data-page]')].find(
      (s) => s.dataset.page === c.dataset.chip,
    );
    g?.scrollIntoView({ block: 'start' });
  });

  el.listHook = (rows, open) => {
    lastRows = rows.map((r) => ({ ...r, thread: withLinked(el, r.thread) }));
    threads = new Map(lastRows.map((r) => [r.thread.id, r.thread]));
    openPop = open;
    take();
    if (el.activeThread && !threads.has(el.activeThread)) el.activeThread = null;
    render();
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
      if (contextMatches(contextOf(row.thread), cur)) {
        if (!isOpen()) toggle(true);
        show(row.thread);
      }
    }
    ring();
  };
  el.scheduleRender();
}
