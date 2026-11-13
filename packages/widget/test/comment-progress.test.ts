import { setStatus } from '@claude-workspaces/core';
import { createAnchor } from '@claude-workspaces/core/anchor/element';
import { setThreadProgress } from '@claude-workspaces/core/thread-progress';
import type { User } from '@claude-workspaces/core/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { mountPageList } from '../src/widget-page-list.ts';
import { renderThreadsInto } from '../src/widget-threads.ts';
import { pinOf, thread, widgetAt } from './page-fixture.ts';

/**
 * An agent's mark on a comment in the comment view: the card's state word,
 * the pin, and the opened card's line with Resolve leading on a done one.
 * Driven through the widget's renderer with the view mounted. Fixture names
 * only; the clock is injected.
 */

const T0 = 1_760_000_000_000;
const PAGE = '/workspaces/w-harbor/apps/d-berths/';
const AGENT = {
  id: 'agent-harborlight',
  name: 'Harborlight site',
  kind: 'agent',
} as unknown as User;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (q: string) => ({ matches: false, media: q }) as MediaQueryList,
  );
  localStorage.clear();
  history.replaceState(null, '', PAGE);
  document.body.innerHTML = '<main><p id="one">Riverbend opens at nine.</p></main>';
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
  history.replaceState(null, '', '/');
});

function seeded() {
  const ydoc = new Y.Doc();
  const anchor = {
    ...createAnchor(document.getElementById('one') as HTMLElement),
    context: { url: PAGE },
  };
  thread(ydoc, 't-one', anchor, T0, 'Should say 9:00');
  const el = widgetAt(ydoc, PAGE);
  el.shadow.innerHTML =
    '<div class="panel"><header class="panel-header"><div class="title">Feedback</div></header>' +
    '<div class="panel-threads"></div></div>';
  el.scheduleRender = () => renderThreadsInto(el);
  mountPageList(el);
  return { el, ydoc };
}

const slot = (el: ReturnType<typeof seeded>['el']) =>
  el.shadow.querySelector<HTMLElement>('.thread[data-thread-id="t-one"] .cw-state');

describe("an agent's mark in the comment view", () => {
  it('keeps an empty slot on an unmarked card, so the mark moves nothing beside it', () => {
    const { el } = seeded();
    expect(slot(el)?.dataset.state).toBe('open');
    expect(slot(el)?.textContent).toBe('');
    expect(pinOf(el, 't-one')?.dataset.state).toBe('open');
  });

  it('shows In progress, then Done, on the card and the pin', () => {
    const { el, ydoc } = seeded();
    setThreadProgress(ydoc, 't-one', 'working', AGENT, T0 + 1000);
    renderThreadsInto(el);
    expect(slot(el)?.textContent).toBe('In progress');
    expect(pinOf(el, 't-one')?.dataset.state).toBe('working');
    setThreadProgress(ydoc, 't-one', 'done', AGENT, T0 + 2000);
    renderThreadsInto(el);
    expect(slot(el)?.textContent).toBe('Done');
    expect(slot(el)?.title).toContain('Harborlight site');
    expect(pinOf(el, 't-one')?.dataset.state).toBe('done');
  });

  it('opened, a done thread says who marked it, and Resolve leads', () => {
    const { el, ydoc } = seeded();
    setThreadProgress(ydoc, 't-one', 'done', AGENT, T0 + 2000);
    renderThreadsInto(el);
    (el.shadow.querySelector('.thread[data-thread-id="t-one"]') as HTMLElement).click();
    const pop = el.shadow.querySelector('.thread.active .thread-popover');
    expect(pop?.querySelector('.cw-progress')?.textContent).toContain(
      'Harborlight site marked this done',
    );
    expect(pop?.querySelector('.resolve')?.classList.contains('primary')).toBe(true);
    expect(pop?.querySelector('.submit')?.classList.contains('primary')).toBe(false);
  });

  it('a resolve takes the mark and the pin away', () => {
    const { el, ydoc } = seeded();
    setThreadProgress(ydoc, 't-one', 'done', AGENT, T0 + 2000);
    setStatus(ydoc, 't-one', 'resolved');
    renderThreadsInto(el);
    expect(pinOf(el, 't-one')).toBeUndefined();
  });
});
