/**
 * The page `enter-sends-browser-driver.ts` loads: three real comment boxes,
 * one at a time, each recording what it sent.
 *
 *  - `task`: the task panel's Comments box (`ComposerForm`), mounted through
 *    the real task detail island.
 *  - `card`: the board's thread card (`ThreadCard`), which is the doc's
 *    thread card and its reply box, lifted onto a board surface.
 *  - `widget`: the widget's comment box on a mock (`submitOnEnter`).
 *
 * Every key arrives from the driver as a real CDP keystroke; this file only
 * mounts and reads.
 */
import type { User } from '@claude-workspaces/core';
import { h, render } from 'preact';
import { submitOnEnter } from '../../widget/src/widget-picker.ts';
import type { DetailHandlers, TaskDiscussion } from '../src/board/board-detail-render.ts';
import { type BoardTask, CHORES_ID } from '../src/board/board-model.ts';
import { mountTaskDetailIsland, taskDetailData } from '../src/board/task-detail-island.tsx';
import { ThreadCard, draftThread } from '../src/board/thread-card.tsx';

export type Kind = 'task' | 'card' | 'widget';

export interface EnterReading {
  sent: string[];
  /** What the box under test holds — the textarea every caller reads. */
  value: string;
  /** The last Enter keydown the page saw, so a reading says which key shape
   *  it was taken under. */
  lastEnter: { isComposing: boolean; keyCode: number; shiftKey: boolean } | null;
}

/** One box's readings, printed by the driver. Here rather than in the driver
 *  so the test can import the type without importing a module that reads
 *  stylesheets off disk. */
export interface BoxRun {
  kind: Kind;
  afterShiftEnter: EnterReading;
  /** Safari's shape: `isComposing` false, keyCode 229. */
  afterSafariIme: EnterReading;
  /** Chrome's shape: a composition open in the box when Enter lands. */
  afterChromeIme: EnterReading;
  afterEnter: EnterReading;
  afterEmptyEnter: EnterReading;
  afterCmdEnter: EnterReading;
}

const NOW = 1_700_000_000_000;
const ALICE: User = { id: 'u-alice', name: 'Alice', kind: 'known', color: '#336699' };

let sent: string[] = [];
let box: () => HTMLTextAreaElement | null = () => null;
let lastEnter: EnterReading['lastEnter'] = null;

// Trusted only: the markdown editor re-dispatches Enter onto its textarea, and
// that proxy passes through this capture listener too.
document.addEventListener(
  'keydown',
  (ev) => {
    if (ev.key === 'Enter' && ev.isTrusted)
      lastEnter = { isComposing: ev.isComposing, keyCode: ev.keyCode, shiftKey: ev.shiftKey };
  },
  true,
);

function mountTask(host: HTMLElement): void {
  host.className = 'board-detail';
  mountTaskDetailIsland(host);
  const task = {
    id: 't-ferry',
    title: 'Book the Riverbend ferry',
    status: 'todo',
    assignee: 'Alice',
    goal: CHORES_ID,
    order: 1,
    after: [],
    links: [],
    transitions: [],
    bodyDocId: 'task:t-ferry',
    createdAt: NOW,
    updatedAt: NOW,
  } as unknown as BoardTask;
  const discussion: TaskDiscussion = { loading: false, threads: [] };
  taskDetailData.value = {
    task,
    discussion,
    handlers: {
      onClose: () => {},
      onStatusSet: () => {},
      onTitleCommit: () => {},
      onComment: async (_t: BoardTask, text: string) => {
        sent.push(text);
        return true;
      },
    } as unknown as DetailHandlers,
  };
  box = () => host.querySelector<HTMLTextAreaElement>('.board-comment-form textarea');
}

function mountCard(host: HTMLElement): void {
  const thread = draftThread('t-ferry', 'the Saltmarsh slipway', ALICE, NOW);
  render(
    h(ThreadCard, {
      thread,
      user: ALICE,
      onReply: async (text: string) => {
        sent.push(text);
        return true;
      },
      onFold: () => {},
    }),
    host,
  );
  box = () => host.querySelector<HTMLTextAreaElement>('.thread-reply textarea');
}

function mountWidget(host: HTMLElement): void {
  const ta = document.createElement('textarea');
  ta.className = 'cw-enter-widget-box';
  host.append(ta);
  // As the widget's own post does: refuse an empty box, and empty it once
  // the comment is saved.
  submitOnEnter(ta, () => {
    const text = ta.value.trim();
    if (!text) return;
    sent.push(text);
    ta.value = '';
  });
  box = () => ta;
}

/** Mount one box; answers the selector the driver focuses to type into. */
export function mount(kind: Kind): string {
  sent = [];
  lastEnter = null;
  const host = document.createElement('div');
  document.body.replaceChildren(host);
  if (kind === 'task') mountTask(host);
  else if (kind === 'card') mountCard(host);
  else mountWidget(host);
  return kind === 'widget' ? '.cw-enter-widget-box' : '.md-composer-live .ProseMirror';
}

export function read(): EnterReading {
  return { sent: [...sent], value: box()?.value ?? '', lastEnter };
}

declare global {
  interface Window {
    cwEnter?: { mount: typeof mount; read: typeof read };
  }
}
window.cwEnter = { mount, read };
