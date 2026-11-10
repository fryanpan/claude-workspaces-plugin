/**
 * `review-key.ts` on its own: which item each name resolves to, and what a
 * filed item off the queue is reported as. The route-level proof is
 * `review-rank-key-forms.test.ts`.
 */
import { describe, expect, it } from 'bun:test';
import type { TaskReviewItem } from '@claude-workspaces/core';
import type { CrossReviewItem } from '../src/cross-review-queue.ts';
import { findQueueItem, ticketItemRef, whyNotQueued } from '../src/review-key.ts';

const ticket = (ws: string, taskId: string, reviewItemId: string) =>
  ({
    kind: 'task-review',
    taskId,
    reviewItemId,
    workspaceId: ws,
    key: `${ws}:task-review:${taskId}:${reviewItemId}`,
  }) as unknown as CrossReviewItem;
const thread = (ws: string, docId: string, threadId: string) =>
  ({
    kind: 'doc-thread',
    docId,
    threadId,
    workspaceId: ws,
    key: `${ws}:doc-thread:${docId}:${threadId}`,
  }) as unknown as CrossReviewItem;

const ITEMS = [
  ticket('w-harbor', 't-1', 'r-1'),
  ticket('w-river', 't-2', 'r-2'),
  thread('w-river', 'd-1', 'th-1'),
];

describe('findQueueItem', () => {
  it('resolves the queue key, the board-relative key, its encoding and the bare id alike', () => {
    for (const k of [
      'w-river:task-review:t-2:r-2',
      'task-review:t-2:r-2',
      'task-review%3At-2%3Ar-2',
      'r-2',
    ]) {
      expect(findQueueItem(ITEMS, k)?.key).toBe('w-river:task-review:t-2:r-2');
    }
    expect(findQueueItem(ITEMS, 'doc-thread:d-1:th-1')?.key).toBe('w-river:doc-thread:d-1:th-1');
  });

  it('does not match a key on the wrong board, a fragment, or an unknown id', () => {
    for (const k of ['w-harbor:task-review:t-2:r-2', 't-2:r-2', 'r-9', 'th-1', '%E0%A4%A']) {
      expect(findQueueItem(ITEMS, k)).toBeUndefined();
    }
  });
});

describe('ticketItemRef', () => {
  it('reads the task and item out of either key form, and an id on its own', () => {
    expect(ticketItemRef('w-x:task-review:t-1:r-1')).toEqual({
      workspaceId: 'w-x',
      taskId: 't-1',
      itemId: 'r-1',
    });
    expect(ticketItemRef('task-review:t-1:r-1')).toEqual({ taskId: 't-1', itemId: 'r-1' });
    expect(ticketItemRef('r-1')).toEqual({ itemId: 'r-1' });
    expect(ticketItemRef('doc-thread:d-1:th-1')).toBeUndefined();
    expect(ticketItemRef('task-review:t-1')).toBeUndefined();
    expect(ticketItemRef('a:b:task-review:t-1:r-1')).toBeUndefined();
  });
});

describe('whyNotQueued', () => {
  const item = { id: 'r-1', review: { shape: 'review', headline: 'Q?' } } as TaskReviewItem;
  const live = { status: 'todo' };
  it('names what took a filed item off the queue', () => {
    expect(whyNotQueued({ item, task: live, boardLive: false })?.reason).toBe('board-retired');
    expect(whyNotQueued({ item, task: { status: 'done' }, boardLive: true })?.reason).toBe(
      'task-done',
    );
    expect(
      whyNotQueued({ item, task: { status: 'todo', archivedAt: 1 }, boardLive: true })?.reason,
    ).toBe('task-archived');
  });

  it('says nothing for an item nothing explains, or no item at all', () => {
    expect(whyNotQueued({ item, task: live, boardLive: true })).toBeUndefined();
    expect(whyNotQueued(undefined)).toBeUndefined();
  });
});
