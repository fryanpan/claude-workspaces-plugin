/**
 * A needs-review task link opens its task with `?focus=review`, and the panel
 * lands on the open review items: it scrolls the queue into view, once per
 * open, as soon as the queue is drawn. Without the parameter it scrolls
 * nowhere — the panel's ordinary open is unchanged. Fixtures are synthetic.
 */
import { options } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DetailHandlers, TaskDiscussion } from '../src/board/board-detail-render.ts';
import { type BoardTask, CHORES_ID } from '../src/board/board-model.ts';
import { mountTaskDetailIsland, taskDetailData } from '../src/board/task-detail-island.tsx';

options.debounceRendering = (cb: () => void) => cb();

const NOW = 1_700_000_000_000;
const EMPTY: TaskDiscussion = { loading: false, threads: [] };

/** The task, holding its own open decision when `asks` is set. */
function task(asks = false): BoardTask {
  return {
    id: 't-ferry',
    title: 'Check the Riverbend timetable',
    status: 'todo',
    assignee: 'agent',
    goal: CHORES_ID,
    order: 1,
    after: [],
    links: [],
    transitions: [],
    bodyDocId: 'task:t-ferry',
    createdAt: NOW,
    updatedAt: NOW,
    ...(asks
      ? { needs: 'decision' as const, body: 'Is the Saltmarsh stop ten minutes later?' }
      : {}),
  };
}

const handlers = (): DetailHandlers => ({
  onClose: vi.fn(),
  onStatusSet: vi.fn(),
  onTitleCommit: vi.fn(),
  onAnswer: vi.fn(),
  onAssign: vi.fn(),
});

let live: (() => void) | null = null;
let scrolled: Element[] = [];

function open(search: string, t: BoardTask): HTMLElement {
  window.history.replaceState(null, '', `/workspaces/w-harbor${search}`);
  const host = document.createElement('div');
  host.className = 'board-detail';
  document.body.replaceChildren(host);
  // Written before the mount: the signal is module-level, and the last
  // test's task would otherwise paint first.
  taskDetailData.value = { task: { ...t }, discussion: EMPTY, handlers: handlers() };
  live = mountTaskDetailIsland(host);
  return host;
}

beforeEach(() => {
  scrolled = [];
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this);
  };
});
afterEach(() => {
  live?.();
  live = null;
  document.body.innerHTML = '';
});

describe('opening a task from a needs-review link', () => {
  it('scrolls the open review queue into view, once', () => {
    const host = open('?task=t-ferry&focus=review', task(true));
    const queue = host.querySelector('.board-decide');
    expect(queue).not.toBeNull();
    expect(scrolled).toEqual([queue]);
    // A repaint of the same open task does not drag the reader back.
    taskDetailData.value = { task: task(true), discussion: EMPTY, handlers: handlers() };
    expect(scrolled).toHaveLength(1);
  });

  it('waits for the queue when the item arrives after the panel opens', () => {
    const host = open('?task=t-ferry&focus=review', task());
    expect(scrolled).toEqual([]);
    taskDetailData.value = { task: task(true), discussion: EMPTY, handlers: handlers() };
    expect(scrolled).toEqual([host.querySelector('.board-decide')]);
  });

  it('scrolls nowhere on an ordinary open (control)', () => {
    const host = open('?task=t-ferry', task(true));
    expect(host.querySelector('.board-decide')).not.toBeNull();
    expect(scrolled).toEqual([]);
  });
});
