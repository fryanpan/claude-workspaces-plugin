import { postReply } from '@claude-workspaces/core';
import { createAnchor } from '@claude-workspaces/core/anchor/element';
import { postLinkedReply } from '@claude-workspaces/core/linked-item';
import type { LinkedReviewItem, User } from '@claude-workspaces/core/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { mountPageList } from '../src/widget-page-list.ts';
import { renderThreadsInto } from '../src/widget-threads.ts';
import type { FeedbackWidgetEl } from '../src/widget.ts';
import { pinOf, thread, widgetAt } from './page-fixture.ts';

/**
 * The comment view on a one-file mock with three pages, moved between by its
 * fragment: new threads under one heading at the top, one group per page in
 * the nav's order, a linked review item in its thread, a pin that opens its
 * thread in the view, and the board's bar told what to show. Driven through
 * the widget's renderer with the view mounted, as `mockup-live.js` mounts it.
 * Fixture names only; the clock is injected.
 */

const T0 = 1_760_000_000_000;
const MOCK = '/workspaces/w-harbor/mockups/d-ferry';
const AGENT: User = { id: 'a-riverbend', name: 'Riverbend agent', kind: 'known', color: '#0a7b83' };

/** Whether the screen is a phone's, as the view asks `matchMedia`. */
let phone = false;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  phone = false;
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (q: string) => ({ matches: phone && q.includes('max-width'), media: q }) as MediaQueryList,
  );
  localStorage.clear();
  history.replaceState(null, '', `${MOCK}?cw-frame=1#book`);
  document.body.innerHTML =
    '<nav><a href="#timetable">Timetable</a><a href="#book">Book</a><a href="#pay">Pay</a></nav>' +
    '<main><h1 id="tt">Timetable</h1><p id="seats">Choose a seat</p><button id="pay">Pay £18.40</button></main>';
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
  (window as { cwHostBar?: unknown }).cwHostBar = undefined;
  history.replaceState(null, '', '/');
});

const byId = (id: string) => document.getElementById(id) as HTMLElement;
const on = (id: string, page: string) => ({
  ...createAnchor(byId(id)),
  context: { url: `${MOCK}?cw-frame=1#${page}` },
});

/** A thread on each page, and the reader back for a second visit. */
function seeded(opts: { returning?: boolean } = {}) {
  if (opts.returning !== false) localStorage.setItem('cfw:seen:', '{}');
  const ydoc = new Y.Doc();
  thread(ydoc, 't-tt', on('tt', 'timetable'), T0, 'Can the 07:40 say it has bike space?');
  thread(ydoc, 't-seats', on('seats', 'book'), T0 + 1000, 'Which side gets the sun?');
  thread(ydoc, 't-pay', on('pay', 'pay'), T0 + 2000, 'Show the bike fee before this button');
  const el = widgetAt(ydoc, `${MOCK}?cw-frame=1#book`);
  el.shadow.innerHTML =
    '<div class="panel"><header class="panel-header"><div class="title">Feedback</div></header>' +
    '<div class="panel-threads"></div></div>';
  el.scheduleRender = () => renderThreadsInto(el);
  mountPageList(el);
  return { el, ydoc };
}

const sections = (el: FeedbackWidgetEl) =>
  [...el.shadow.querySelectorAll<HTMLElement>('.panel-threads [data-section]')].map((s) => [
    s.dataset.section,
    s.querySelector('.section-heading')?.firstChild?.textContent,
    [...s.querySelectorAll<HTMLElement>('.thread')].map((t) => t.dataset.threadId),
  ]);

describe('the comment view', () => {
  it('groups every open thread by page, in the order the nav links to them', () => {
    const { el } = seeded({ returning: false });
    expect(sections(el)).toEqual([
      ['away', 'Timetable', ['t-tt']],
      ['page', 'Book', ['t-seats']],
      ['away', 'Pay', ['t-pay']],
    ]);
    expect(el.shadow.querySelector('.cw-sub')?.textContent).toBe('3 open on 3 pages');
    // Each other page offers a way there.
    expect(el.shadow.querySelector('[data-goto-page]')?.textContent).toBe('Go to Timetable');
    // A card under its page's heading does not name the page again.
    expect(el.shadow.querySelector('[data-section=away] .thread .where')).toBeNull();
  });

  it('puts a reply from someone else under New, live, until the reader opens it', () => {
    const { el, ydoc } = seeded();
    expect(sections(el).map((s) => s[0])).not.toContain('new');
    vi.setSystemTime(T0 + 5000);
    postReply(ydoc, 't-pay', { id: 'c-agent', author: AGENT, text: 'Moved the bike fee up.' });
    renderThreadsInto(el);
    expect(sections(el)[0]).toEqual(['new', 'New', ['t-pay']]);
    const card = el.shadow.querySelector('[data-section=new] .thread');
    expect(card?.textContent).toContain('Moved the bike fee up.');
    // Under New, cards from every page mix, so each says which.
    expect(card?.querySelector('.where')?.textContent).toBe('On Pay');
    // The chip for Pay carries the steady dot; the others keep its room.
    const dots = [...el.shadow.querySelectorAll<HTMLElement>('.cw-pchip')].map(
      (c) => !c.querySelector('.cw-newdot')?.hasAttribute('hidden'),
    );
    expect(dots).toEqual([false, false, true]);

    // Opened (it is on another page, so the page goes there first): it stays
    // under New while open, and leaves once another thread is opened.
    (el.shadow.querySelector('[data-section=new] .thread') as HTMLElement).click();
    expect(location.hash).toBe('#pay');
    el.currentContext = { url: `${MOCK}?cw-frame=1#pay` };
    renderThreadsInto(el);
    expect(el.shadow.querySelector('.thread.active')?.getAttribute('data-thread-id')).toBe('t-pay');
    expect(sections(el)[0]).toEqual(['new', 'New', ['t-pay']]);
    expect(pinOf(el, 't-pay')?.hasAttribute('data-hl')).toBe(true);
    (el.shadow.querySelector('.thread[data-thread-id="t-seats"]') as HTMLElement).click();
    el.currentContext = { url: `${MOCK}?cw-frame=1#book` };
    renderThreadsInto(el);
    expect(sections(el).map((s) => s[0])).not.toContain('new');
  });

  it('shows a linked review item with its headline and a link that opens it', () => {
    const { el, ydoc } = seeded();
    const item: LinkedReviewItem = {
      workspaceId: 'w-saltmarsh',
      board: 'Saltmarsh board',
      headline: 'Turn on the tunnel for the Riverbend share?',
      url: '/workspaces/w-saltmarsh?task=t-tunnel',
      ref: { taskId: 't-tunnel', reviewItemId: 'r-tunnel' },
    };
    postLinkedReply(ydoc, 't-seats', {
      id: 'c-link',
      author: AGENT,
      text: `Linked review item on Saltmarsh board: "${item.headline}" — ${item.url}`,
      linkedItem: item,
    });
    renderThreadsInto(el);
    const row = el.shadow.querySelector('.thread[data-thread-id="t-seats"] [data-linked-item]');
    expect(row?.querySelector('.hl')?.textContent).toBe(item.headline);
    expect(row?.querySelector('.from')?.textContent).toBe('Review item · Saltmarsh board');
    expect(row?.querySelector('a')?.getAttribute('href')).toBe(item.url);
    // The fallback line only names the item, so the card does not repeat it.
    expect(el.shadow.querySelector('.thread[data-thread-id="t-seats"]')?.textContent).not.toContain(
      'Linked review item on',
    );
  });

  it('opens a pin’s thread in the view, with the popover’s reply box in its card', () => {
    const { el } = seeded();
    pinOf(el, 't-seats')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(el.shadow.querySelector('.panel')?.classList.contains('open')).toBe(true);
    const active = el.shadow.querySelector('.thread.active');
    expect(active?.getAttribute('data-thread-id')).toBe('t-seats');
    expect(active?.querySelector('.thread-popover textarea')).toBeTruthy();
    // One popover, and it is the one in the card.
    expect(el.shadow.querySelectorAll('.thread-popover').length).toBe(1);
  });

  it('on a phone, shows a picked thread alone, with the way back to all of them', () => {
    phone = true;
    const { el } = seeded();
    pinOf(el, 't-seats')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const panel = el.shadow.querySelector('.panel');
    expect(panel?.classList.contains('cw-detail')).toBe(true);
    expect(
      [...el.shadow.querySelectorAll('.thread')].map((t) => t.getAttribute('data-thread-id')),
    ).toEqual(['t-seats']);
    const back = el.shadow.querySelector<HTMLElement>('[data-back]');
    expect(back?.textContent).toBe('‹ All comments');
    back?.click();
    expect(panel?.classList.contains('cw-detail')).toBe(false);
    expect(sections(el).flatMap((x) => x[2])).toEqual(['t-tt', 't-seats', 't-pay']);
  });

  it('tells the board’s bar whether it is open and whether anything is new', () => {
    const told: Array<{ open: boolean; fresh: boolean }> = [];
    (window as { cwHostBar?: unknown }).cwHostBar = { tell: (s: never) => told.push(s) };
    const { el, ydoc } = seeded();
    expect(el.hasAttribute('data-cw-host-bar')).toBe(true);
    dispatchEvent(new Event('cw-comments'));
    expect(told.at(-1)).toEqual({ open: true, fresh: false });
    vi.setSystemTime(T0 + 5000);
    postReply(ydoc, 't-tt', { id: 'c-agent', author: AGENT, text: 'Added a bike icon.' });
    renderThreadsInto(el);
    expect(told.at(-1)).toEqual({ open: true, fresh: true });
    // Opened, it is no longer new, though it stays under New while open.
    (el.shadow.querySelector('[data-section=new] .thread') as HTMLElement).click();
    el.currentContext = { url: `${MOCK}?cw-frame=1#timetable` };
    renderThreadsInto(el);
    expect(told.at(-1)).toEqual({ open: true, fresh: false });
    dispatchEvent(new Event('cw-comments'));
    expect(told.at(-1)).toEqual({ open: false, fresh: false });
  });
});
