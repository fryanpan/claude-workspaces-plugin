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
  it('puts no word on an unmarked card', () => {
    const { el } = seeded();
    expect(slot(el)?.dataset.state).toBe('open');
    expect(slot(el)?.textContent).toBe('');
    expect(pinOf(el, 't-one')?.dataset.state).toBe('open');
  });

  it("keeps the note's room in an unmarked opened card, so the buttons do not move when a mark arrives", () => {
    const { el } = seeded();
    (el.shadow.querySelector('.thread[data-thread-id="t-one"]') as HTMLElement).click();
    const note = el.shadow.querySelector<HTMLElement>('.thread.active .cw-progress');
    expect(note?.dataset.state).toBe('open');
    expect(note?.textContent).toBe('');
    // Before the buttons, as the marked one is.
    expect(note?.nextElementSibling?.classList.contains('actions')).toBe(true);
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

  it('breathes on the pin of a comment an agent is working on, slowly and in turn', () => {
    const { el, ydoc } = seeded();
    // CONTROL: an unmarked pin carries no dots.
    expect(pinOf(el, 't-one')?.querySelectorAll('.cw-breathe')).toHaveLength(0);
    setThreadProgress(ydoc, 't-one', 'working', AGENT, T0 + 1000);
    renderThreadsInto(el);
    const dots = [...(pinOf(el, 't-one')?.querySelectorAll<HTMLElement>('.cw-breathe') ?? [])];
    expect(dots).toHaveLength(3);
    const styles = dots.map((d) => getComputedStyle(d));
    expect(styles.map((s) => s.animationName)).toEqual(['cw-breathe', 'cw-breathe', 'cw-breathe']);
    expect(styles.map((s) => s.animationDuration)).toEqual(['4.5s', '4.5s', '4.5s']);
    expect(styles.map((s) => s.animationIterationCount)).toEqual([
      'infinite',
      'infinite',
      'infinite',
    ]);
    // happy-dom reports a value as the sheet wrote it, so .75s keeps its form.
    expect(styles.map((s) => s.animationDelay)).toEqual(['0s', '.75s', '1.5s']);
    // Done stops the breathing: the rebuilt pin carries no dots.
    setThreadProgress(ydoc, 't-one', 'done', AGENT, T0 + 2000);
    renderThreadsInto(el);
    expect(pinOf(el, 't-one')?.dataset.state).toBe('done');
    expect(pinOf(el, 't-one')?.querySelectorAll('.cw-breathe')).toHaveLength(0);
  });

  it('holds the dots still when the reader asks for reduced motion', () => {
    const settings = (
      window as unknown as {
        happyDOM: { settings: { device: { prefersReducedMotion: string } } };
      }
    ).happyDOM.settings.device;
    const { el, ydoc } = seeded();
    setThreadProgress(ydoc, 't-one', 'working', AGENT, T0 + 1000);
    renderThreadsInto(el);
    const dot = () => pinOf(el, 't-one')?.querySelector<HTMLElement>('.cw-breathe') ?? null;
    // CONTROL: the dot breathes with motion allowed.
    const moving = dot();
    expect(moving && getComputedStyle(moving).animationName).toBe('cw-breathe');
    settings.prefersReducedMotion = 'reduce';
    try {
      // The next render rebuilds the pin, as any change on the doc does.
      renderThreadsInto(el);
      const still = dot();
      expect(still, 'the dots are still drawn').not.toBeNull();
      const s = still ? getComputedStyle(still) : null;
      expect(s?.animationName).toBe('none');
      expect(s?.opacity).toBe('.85');
    } finally {
      settings.prefersReducedMotion = 'no-preference';
    }
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
