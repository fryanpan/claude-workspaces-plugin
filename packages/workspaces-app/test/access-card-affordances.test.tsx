/**
 * An access card offers Approve and Reject, and nothing else.
 *
 * The access door answers only a tapped decision: typed words are refused and
 * a question cannot change who is in. The card used to draw the free-text box
 * and "I have a question" anyway, on Home and in the task panel, so the owner
 * was offered two ways of answering that could not work. Both surfaces are
 * drawn here with an access card and with an ordinary ticket card beside it,
 * so a card that lost its box for every item would fail too. All fixtures are
 * synthetic.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DetailHandlers } from '../src/board/board-detail-render.ts';
import { type BoardTask, CHORES_ID } from '../src/board/board-model.ts';
import { type ReviewThreadItem, reviewQueue } from '../src/board/board-review-model.ts';
import {
  type WalkthroughHandlers,
  mountWalkthroughIsland,
  walkthroughData,
} from '../src/board/walkthrough-island.tsx';
import { renderTaskDetail } from './support/task-detail.ts';

const NOW = 1_700_000_000_000;
const WS = 'w-harbor';
const LINE = 'Lets ops@example.com sign in to this board.';
const CHANGE = { op: 'add-audience', workspaceId: WS, entries: ['ops@example.com'] };
const OPTIONS = [
  { id: 'o-approve', label: 'Approve', detail: 'Applies the change now' },
  { id: 'o-reject', label: 'Reject', detail: 'Nothing changes, and the agent is told' },
];

/** A ticket-borne decision as the review-items route ships it. */
function row(access: boolean): ReviewThreadItem {
  return {
    kind: 'task-review',
    band: 'declared',
    workspaceId: WS,
    taskId: 't-invite',
    reviewItemId: 'r-1',
    title: 'Invite the ops team',
    ask: LINE,
    askedBy: 'Riverbend Bot',
    since: NOW - 60_000,
    direct: true,
    askedAt: NOW - 60_000,
    review: {
      shape: 'decision',
      headline: LINE,
      detail: 'They review the release notes.',
      options: OPTIONS,
      ownerOnly: true,
    },
    ...(access ? { access: CHANGE } : {}),
  } as unknown as ReviewThreadItem;
}

function walkHandlers(): WalkthroughHandlers {
  return {
    onAnswer: vi.fn(),
    onReply: vi.fn(),
    onSaveSecrets: vi.fn(),
    onAskOnItem: vi.fn(),
    onQuestionOnItem: vi.fn(),
    onOpenItem: vi.fn(),
    onOpenThread: vi.fn(),
    onStep: vi.fn(),
    onClose: vi.fn(),
  };
}

function task(): BoardTask {
  return {
    id: 't-invite',
    title: 'Invite the ops team',
    status: 'todo',
    assignee: 'agent',
    goal: CHORES_ID,
    order: 1,
    after: [],
    links: [],
    transitions: [],
    bodyDocId: 'task:t-invite',
    createdAt: NOW,
    updatedAt: NOW,
  };
}

let root: HTMLElement;
let dispose: (() => void) | null = null;

beforeEach(() => {
  root = document.createElement('div');
  document.body.replaceChildren(root);
});

afterEach(() => {
  dispose?.();
  dispose = null;
});

const optionLabels = () =>
  [...root.querySelectorAll('.board-walk-option-label')].map((b) => b.textContent?.trim());

describe('the Home walkthrough card', () => {
  const show = (access: boolean, handlers = walkHandlers()) => {
    dispose?.();
    walkthroughData.value = {
      queue: reviewQueue([], [row(access)], NOW),
      index: 0,
      progress: { cleared: 0, last: null },
      now: NOW,
      handlers,
      secretsGate: 'open',
    };
    dispose = mountWalkthroughIsland(root);
  };

  it('an access card has Approve, Reject and Skip, and no box or question link', () => {
    show(true);
    expect(optionLabels()).toEqual(['Approve', 'Reject']);
    expect(root.querySelector('.board-walk-skip-link')).not.toBeNull();
    expect(root.querySelector('.board-walk-answer')).toBeNull();
    expect(root.querySelector('textarea')).toBeNull();
    expect(root.querySelector('.board-walk-question-link')).toBeNull();
    expect(root.querySelector('.board-walk-pill')).toBeNull();
  });

  it('Approve answers with the option it names', () => {
    const handlers = walkHandlers();
    show(true, handlers);
    [...root.querySelectorAll<HTMLButtonElement>('button')]
      .find((b) => b.textContent?.includes('Approve'))
      ?.click();
    expect(handlers.onReply).toHaveBeenCalledWith(expect.anything(), 'Approve', 'o-approve');
  });

  it('the same card without an access change keeps both', () => {
    show(false);
    expect(root.querySelector('.board-walk-answer')).not.toBeNull();
    expect(root.querySelector('.board-walk-question-link')).not.toBeNull();
  });
});

describe('the task panel card', () => {
  const paint = (access: boolean) =>
    renderTaskDetail(root, task(), {
      workspaceId: WS,
      onClose: vi.fn(),
      onStatusSet: vi.fn(),
      onTitleCommit: vi.fn(),
      onAnswer: vi.fn(),
      onOpenDoc: vi.fn(),
      onOpenTask: vi.fn(),
      onAnswerThread: vi.fn(),
      onAskOnPanelItem: vi.fn(),
      asks: [row(access)],
      now: NOW,
    } as unknown as DetailHandlers);

  it('an access card has Approve and Reject, and no box or question link', () => {
    paint(true);
    const card = root.querySelector('.board-decide-card');
    expect(card?.textContent).toContain('Approve');
    expect(card?.textContent).toContain('Reject');
    expect(card?.querySelector('textarea')).toBeNull();
    expect(card?.querySelector('.board-decide-question-link')).toBeNull();
  });

  it('the same card without an access change keeps both', () => {
    paint(false);
    const card = root.querySelector('.board-decide-card');
    expect(card?.querySelector('textarea')).not.toBeNull();
    expect(card?.querySelector('.board-decide-question-link')).not.toBeNull();
  });
});
