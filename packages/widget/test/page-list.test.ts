import { getThreads, markOrphan, setStatus } from '@claude-workspaces/core';
import { createAnchor } from '@claude-workspaces/core/anchor/element';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { mountPageList } from '../src/widget-page-list.ts';
import { renderThreadsInto } from '../src/widget-threads.ts';
import type { FeedbackWidgetEl } from '../src/widget.ts';
import { pinOf, thread, widgetAt } from './page-fixture.ts';

/**
 * The widget's panel lists the threads on the page the reader is on, newest
 * first, and a tap on one takes the reader to it: the page state it was made
 * in, then its spot, marked once. Before, the panel listed every thread on
 * the doc oldest first, a tap scrolled only when its pin happened to be drawn,
 * and a thread made with other controls set could not be reached at all.
 *
 * Driven through the widget's renderer with the page list mounted, as `mic.js`
 * mounts it. Fixture names only; the clock is injected.
 */

const T0 = 1_760_000_000_000;
const PAGE = '/case/harborlight/';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  history.replaceState(null, '', `${PAGE}?all=1`);
  document.body.innerHTML =
    '<main><h1 id="h">Harborlight case</h1><p id="p">Riverbend pier</p></main>';
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
  history.replaceState(null, '', '/');
});

const byId = (id: string) => document.getElementById(id) as HTMLElement;
const on = (id: string, url: string) => ({ ...createAnchor(byId(id)), context: { url } });

/** Three threads on this page in three states, and one on another page. */
function seeded(): FeedbackWidgetEl {
  const ydoc = new Y.Doc();
  thread(ydoc, 't-old', on('h', `${PAGE}?all=1`), T0, 'Oldest here');
  thread(ydoc, 't-away', on('h', '/case/riverbend/'), T0 + 1000, 'On another case');
  thread(ydoc, 't-view', on('p', `${PAGE}?o=ss`), T0 + 2000, 'Made with stations shown');
  thread(ydoc, 't-new', on('p', `${PAGE}?all=1`), T0 + 3000, 'Newest here');
  const el = widgetAt(ydoc, `${PAGE}?all=1`);
  el.scheduleRender = () => renderThreadsInto(el);
  mountPageList(el);
  return el;
}

const rows = (el: FeedbackWidgetEl, section: string): string[] =>
  [...el.shadow.querySelectorAll<HTMLElement>(`[data-section="${section}"] .thread`)].map(
    (r) => r.dataset.threadId ?? '',
  );

/** The spot is scrolled to a frame after the thread opens. */
const frame = () => new Promise((r) => requestAnimationFrame(r));

describe('the page list', () => {
  it("lists this page's threads newest first, and other pages' after them", () => {
    const el = seeded();
    expect(rows(el, 'page')).toEqual(['t-new', 't-view', 't-old']);
    expect(rows(el, 'away')).toEqual(['t-away']);
    // The thread made in another state of the page says so on its row.
    const view = el.shadow.querySelector('.thread[data-thread-id="t-view"]');
    expect(view?.querySelector('.where')?.textContent).toBe('Another view of this page');
  });

  it('restores the page state a thread was made in, then shows its spot once', async () => {
    const el = seeded();
    const spy = vi.fn();
    byId('p').scrollIntoView = spy;
    el.shadow.querySelector<HTMLElement>('.thread[data-thread-id="t-view"]')?.click();
    // The address the thread was made at, carrying which thread to show.
    expect(location.pathname + location.search).toBe(`${PAGE}?o=ss&cw-goto=t-view`);

    // The page has loaded at that address, which the widget read at start.
    // The list takes the thread off it, and the widget's history hook — stood
    // in for here — moves its context to what is left.
    el.currentContext = { url: `${PAGE}?o=ss&cw-goto=t-view` };
    renderThreadsInto(el);
    expect(location.pathname + location.search).toBe(`${PAGE}?o=ss`);
    expect(pinOf(el, 't-view')?.hasAttribute('data-hl') ?? false).toBe(false);
    el.currentContext = { url: `${PAGE}?o=ss` };
    renderThreadsInto(el);
    await frame();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(pinOf(el, 't-view')?.hasAttribute('data-hl')).toBe(true);
    expect(el.shadow.querySelector('.thread-popover')?.textContent).toContain(
      'Made with stations shown',
    );

    // Once: the next render scrolls nowhere, and a tap on the page clears the mark.
    renderThreadsInto(el);
    await frame();
    expect(spy).toHaveBeenCalledTimes(1);
    byId('h').dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    renderThreadsInto(el);
    expect(pinOf(el, 't-view')?.hasAttribute('data-hl')).toBe(false);
  });

  it('shows a thread on this state of the page without moving the address', async () => {
    const el = seeded();
    const spy = vi.fn();
    byId('p').scrollIntoView = spy;
    el.shadow.querySelector<HTMLElement>('.thread[data-thread-id="t-new"]')?.click();
    expect(location.search).toBe('?all=1');
    await frame();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(pinOf(el, 't-new')?.hasAttribute('data-hl')).toBe(true);
  });

  it('marks a thread whose element is gone as having no spot', () => {
    const el = seeded();
    byId('p').remove();
    renderThreadsInto(el);
    expect(rows(el, 'nospot')).toEqual(['t-new']);
    expect(rows(el, 'page')).toEqual(['t-view', 't-old']);
  });
});

describe('the open count', () => {
  /** The page's four threads, three of them resolved: one where its element
   *  stands, one whose element a later round took away, one orphaned. Read on
   *  a second visit, so each counts as new until opened. */
  function resolvedMostly(): { el: FeedbackWidgetEl; ydoc: Y.Doc } {
    localStorage.setItem('cfw:seen:', '{}');
    const ydoc = new Y.Doc();
    thread(ydoc, 't-open', on('h', `${PAGE}?all=1`), T0, 'Still open');
    thread(ydoc, 't-done', on('h', `${PAGE}?all=1`), T0 + 1000, 'Resolved, spot stands');
    thread(ydoc, 't-gone', on('p', `${PAGE}?all=1`), T0 + 2000, 'Resolved, spot gone');
    thread(ydoc, 't-orphan', on('h', `${PAGE}?all=1`), T0 + 3000, 'Resolved, orphaned');
    markOrphan(ydoc, 't-orphan');
    for (const id of ['t-done', 't-gone', 't-orphan']) setStatus(ydoc, id, 'resolved');
    byId('p').remove();
    const el = widgetAt(ydoc, `${PAGE}?all=1`);
    // Bob reads Alice's threads; a reader's own threads are never new.
    el.user = { id: 'u-bob', name: 'Bob', kind: 'known', color: '#1a7f37' };
    // The header the count is written into, as the widget's panel has it.
    el.shadow.innerHTML =
      '<div class="panel"><div class="panel-header"><span class="title"></span></div><div class="panel-threads"></div></div>';
    el.scheduleRender = () => renderThreadsInto(el);
    // The widget re-renders on any change to the doc's threads (`widget.ts`).
    getThreads(ydoc).observeDeep(() => el.scheduleRender());
    mountPageList(el);
    return { el, ydoc };
  }
  const sub = (el: FeedbackWidgetEl) => el.shadow.querySelector('.cw-sub')?.textContent;
  const chip = (el: FeedbackWidgetEl) => el.shadow.querySelector('.cw-pchip .n')?.textContent;

  afterEach(() => localStorage.clear());

  it('leaves out resolved threads, whether or not they still have a spot', () => {
    const { el } = resolvedMostly();
    expect(sub(el)).toBe('1 open on 1 page');
    expect(chip(el)).toBe('1 open');
    expect(rows(el, 'new')).toEqual(['t-open']);
    expect(rows(el, 'nospot')).toEqual([]);
  });

  it('follows a resolve and a reopen made elsewhere, without a reload', () => {
    const { el, ydoc } = resolvedMostly();
    setStatus(ydoc, 't-open', 'resolved');
    expect(sub(el)).toBe('');
    expect(rows(el, 'new')).toEqual([]);
    setStatus(ydoc, 't-gone', 'open');
    expect(sub(el)).toBe('1 open on 1 page');
    expect(rows(el, 'new')).toEqual(['t-gone']);
  });
});
