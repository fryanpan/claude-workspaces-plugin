/**
 * The cross-board review's card: rows from several boards become cards whose
 * writes go to each row's own board, the size filter keeps the reader's place,
 * and the chrome says which project the card is from without counting
 * anything. Fixtures are invented.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  reviewItemQuestionRequest,
  reviewReplyRequest,
  reviewSecretsRequest,
} from '../src/board/board-review-model.ts';
import {
  type WalkthroughHandlers,
  type WalkthroughView,
  mountWalkthroughIsland,
  walkthroughData,
} from '../src/board/walkthrough-island.tsx';
import {
  type CrossEntry,
  type CrossReviewRow,
  aimAfterSizeChange,
  allowedEntries,
  asQueue,
  crossEntry,
  crossItemHref,
  hiddenNote,
} from '../src/reviews/cross-walk-model.ts';

const NOW = 1_700_000_000_000;

function ticketRow(over: Partial<CrossReviewRow> = {}): CrossReviewRow {
  return {
    kind: 'task-review',
    workspaceId: 'w-river',
    project: 'Riverbend',
    key: 'w-river:task-review:t-1:r-1',
    taskId: 't-1',
    reviewItemId: 'r-1',
    docId: '',
    threadId: '',
    title: 'River level table',
    ask: 'Which gauge?',
    askedBy: 'Tides Agent',
    since: NOW - 60_000,
    review: { shape: 'decision', headline: 'Which gauge?', detail: 'Two gauges disagree.' },
    size: 'easy',
    minutes: 1,
    ...over,
  };
}

function docRow(over: Partial<CrossReviewRow> = {}): CrossReviewRow {
  return {
    kind: 'doc-thread',
    workspaceId: 'w-harbor',
    project: 'Harborlight',
    key: 'w-harbor:doc-thread:tide-notes:th-9',
    docId: 'tide-notes',
    threadId: 'th-9',
    commentId: 'c-9',
    band: 'declared',
    title: 'Tide notes',
    ask: 'Is the lag right?',
    askedBy: 'Tides Agent',
    since: NOW - 120_000,
    review: { shape: 'review', headline: 'Is the lag right?' },
    size: 'medium',
    minutes: 3,
    ...over,
  };
}

const entries = (rows: CrossReviewRow[]): CrossEntry[] =>
  rows.flatMap((r) => {
    const e = crossEntry(r, NOW);
    return e ? [e] : [];
  });

describe('a cross-board row as a card', () => {
  it('writes an answer to the board the row lives on, not the page’s', () => {
    const [ticket, doc] = entries([ticketRow(), docRow()]);
    expect(reviewReplyRequest(ticket!.item, 'The harbour one', 'a')?.path).toBe(
      '/workspaces/w-river/tasks/t-1/review-items/r-1/answer',
    );
    expect(reviewReplyRequest(doc!.item, 'Yes')?.path).toBe(
      '/workspaces/w-harbor/docs/tide-notes/threads/th-9/answer',
    );
    expect(reviewItemQuestionRequest(ticket!.item, 'Which one is newer?')?.path).toBe(
      '/workspaces/w-river/docs/task%3At-1/threads',
    );
    const [secret] = entries([
      ticketRow({
        review: {
          shape: 'secret',
          headline: 'Tide API key',
          secrets: [{ service: 'tides', label: 'Tide API key' }],
        },
      }),
    ]);
    expect(reviewSecretsRequest(secret!.item, [{ service: 'tides', value: 'x' }])?.path).toBe(
      '/workspaces/w-river/tasks/t-1/review-items/r-1/secrets',
    );
  });

  it('keeps a ticket’s own decision, which Home draws from the board instead', () => {
    const [legacy] = entries([
      ticketRow({ reviewItemId: 'r-legacy', key: 'w-river:task-review:t-1:r-legacy' }),
    ]);
    expect(legacy?.item.key).toBe('w-river:task-review:t-1:r-legacy');
    expect(reviewReplyRequest(legacy!.item, 'Go')?.path).toBe(
      '/workspaces/w-river/tasks/t-1/review-items/r-legacy/answer',
    );
  });

  it('opens where the item lives, on its own board', () => {
    const [ticket, doc] = entries([ticketRow(), docRow({ docType: 'mockup' })]);
    expect(crossItemHref(ticket!)).toBe('/workspaces/w-river?task=t-1');
    expect(crossItemHref(doc!)).toBe('/workspaces/w-harbor/mockups/tide-notes?thread=th-9');
  });
});

describe('the size filter keeps the reader’s place', () => {
  const all = () =>
    entries([
      ticketRow({ key: 'a', size: 'easy' }),
      docRow({ key: 'b', size: 'hard' }),
      ticketRow({ key: 'c', taskId: 't-3', size: 'medium' }),
      ticketRow({ key: 'd', taskId: 't-4', size: 'easy' }),
    ]);

  it('stays on the card when it is still allowed, else moves to the next allowed one', () => {
    expect(aimAfterSizeChange(all(), 'c', 'medium')).toBe('c');
    expect(aimAfterSizeChange(all(), 'b', 'medium')).toBe('c');
    expect(aimAfterSizeChange(all(), 'c', 'easy')).toBe('d');
    expect(aimAfterSizeChange(all(), 'd', 'easy')).toBe('d');
    expect(aimAfterSizeChange(entries([docRow({ key: 'z', size: 'hard' })]), 'z', 'easy')).toBe(
      null,
    );
  });

  it('counts what it hides only for the done screen', () => {
    expect(allowedEntries(all(), 'easy').map((e) => e.item.key)).toEqual(['a', 'd']);
    expect(hiddenNote(all(), 'easy')).toBe('2 harder items not shown');
    expect(hiddenNote(all(), 'medium')).toBe('1 harder item not shown');
    expect(hiddenNote(all(), 'hard')).toBeNull();
  });
});

describe('the walkthrough in cross-board chrome', () => {
  let root: HTMLElement;
  let dispose: (() => void) | null = null;
  const handlers = (over: Partial<WalkthroughHandlers> = {}): WalkthroughHandlers => ({
    onAnswer: vi.fn(),
    onReply: vi.fn(),
    onSaveSecrets: vi.fn(),
    onAskOnItem: vi.fn(),
    onQuestionOnItem: vi.fn(),
    onOpenItem: vi.fn(),
    onOpenThread: vi.fn(),
    onStep: vi.fn(),
    onClose: vi.fn(),
    ...over,
  });
  function show(view: Partial<WalkthroughView>): void {
    dispose?.();
    walkthroughData.value = {
      queue: asQueue([]),
      index: 0,
      progress: { cleared: 0, last: null },
      now: NOW,
      handlers: handlers(),
      secretsGate: 'open',
      ...view,
    };
    dispose = mountWalkthroughIsland(root);
  }
  beforeEach(() => {
    document.body.replaceChildren();
    root = document.createElement('div');
    document.body.append(root);
  });
  afterEach(() => {
    dispose?.();
    dispose = null;
  });

  it('names the project, carries the size bar, and counts nothing the sitting cleared', () => {
    const onPick = vi.fn();
    const list = entries([ticketRow(), docRow()]);
    show({
      queue: asQueue(list),
      progress: { cleared: 3, last: null },
      chrome: {
        backLabel: '‹ Back to Workspaces',
        heading: 'Workspace: Riverbend',
        size: { level: 'medium', onPick },
        doneLabel: 'Back to Workspaces',
        tally: false,
      },
    });
    expect(root.querySelector('.board-walk-home')?.textContent).toBe('‹ Back to Workspaces');
    expect(root.querySelector('.board-walk-heading')?.textContent).toBe('Workspace: Riverbend');
    expect(root.querySelector('.board-walk-pos')?.textContent).toBe('1 of 2');
    expect(root.querySelector('.board-walk-cleared')).toBeNull();
    const stops = [...root.querySelectorAll<HTMLElement>('.board-walk-topline [data-size]')];
    expect(stops.map((b) => b.classList.contains('filled'))).toEqual([true, true, false]);
    expect(stops.map((b) => b.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false']);
    stops[2]?.click();
    expect(onPick).toHaveBeenCalledWith('hard');
  });

  it('ends on how many harder items were held back', () => {
    show({
      queue: asQueue([]),
      progress: { cleared: 2, last: null },
      chrome: {
        backLabel: '‹ Back to Workspaces',
        heading: 'Workspaces',
        doneNote: '2 harder items not shown',
        doneLabel: 'Back to Workspaces',
        tally: false,
      },
    });
    const done = root.querySelector('.board-walk-done') as HTMLElement;
    expect(done.querySelector('p')?.textContent).toBe('2 harder items not shown');
    expect(done.querySelector('.board-walk-done-tally')).toBeNull();
    expect(done.querySelector('.board-btn-primary')?.textContent).toBe('Back to Workspaces');
  });

  it('leaves the board’s own chrome as it was', () => {
    show({ queue: asQueue([]), progress: { cleared: 1, last: null } });
    expect(root.querySelector('.board-walk-home')?.textContent).toBe('‹ Back to Home');
    expect(root.querySelector('.board-walk-topline [data-size]')).toBeNull();
    expect(root.querySelector('.board-walk-done p')?.textContent).toBe(
      'Nothing else is waiting on you right now.',
    );
    expect(root.querySelector('.board-walk-done-tally')?.textContent).toBe(
      'You cleared 1 in this sitting.',
    );
  });
});
