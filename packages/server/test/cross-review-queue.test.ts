import { describe, expect, it } from 'bun:test';
import type { ReviewPayload, ReviewSize } from '@claude-workspaces/core';
import { type BoardQueueInput, countBySize, crossReviewQueue } from '../src/cross-review-queue.ts';
import type { RankedProject } from '../src/review-plan.ts';
import type { SizedReviewItemRow } from '../src/review-sizing.ts';

const REVIEW: ReviewPayload = { shape: 'review', headline: 'Look at this' };

function taskItem(
  taskId: string,
  rid: string,
  since: number,
  size: ReviewSize = 'easy',
): SizedReviewItemRow {
  return {
    kind: 'task-review',
    band: 'declared',
    taskId,
    reviewItemId: rid,
    review: REVIEW,
    title: taskId,
    ask: REVIEW.headline,
    askedBy: 'Riverbend Agent',
    since,
    direct: true,
    askedAt: since,
    state: 'open',
    minutes: size === 'easy' ? 1 : size === 'medium' ? 3 : 8,
    size,
  };
}

function docItem(
  kind: 'task-thread' | 'doc-thread',
  docId: string,
  threadId: string,
  since: number,
  taskId?: string,
): SizedReviewItemRow {
  return {
    kind,
    band: 'declared',
    docId,
    threadId,
    commentId: `c-${threadId}`,
    title: docId,
    ask: 'Does this read right?',
    askedBy: 'Harborlight Agent',
    since,
    direct: true,
    ...(taskId ? { taskId } : {}),
    minutes: 1,
    size: 'easy',
  };
}

const project = (workspaceId: string, rank: number): RankedProject => ({
  workspaceId,
  name: workspaceId,
  lastActivity: 0,
  rank,
  planned: true,
});

describe('crossReviewQueue', () => {
  it('puts every item of a higher project first, whatever its age', () => {
    const boards: BoardQueueInput[] = [
      {
        project: project('w-harbor', 2),
        rows: [taskItem('t-old', 'r-1', 1)],
        tasks: [{ id: 't-old', goal: 'g-1', order: 0, createdAt: 1 }],
        goalIds: ['g-1'],
      },
      {
        project: project('w-river', 1),
        rows: [taskItem('t-new', 'r-1', 900)],
        tasks: [{ id: 't-new', goal: 'g-1', order: 0, createdAt: 900 }],
        goalIds: ['g-1'],
      },
    ];
    const q = crossReviewQueue(boards);
    expect(q.items.map((i) => i.key)).toEqual([
      'w-river:task-review:t-new:r-1',
      'w-harbor:task-review:t-old:r-1',
    ]);
    expect(q.projects.map((p) => p.workspaceId)).toEqual(['w-river', 'w-harbor']);
  });

  it('orders inside a board the way Home does: goal band, place, then kind of ask', () => {
    const rows = [
      docItem('doc-thread', 'd-notes', 'th-doc', 1),
      docItem('task-thread', 'task:t-b', 'th-b', 5, 't-b'),
      taskItem('t-b', 'r-legacy', 50),
      taskItem('t-a', 'r-2', 70),
      taskItem('t-b', 'r-9', 3),
    ];
    const q = crossReviewQueue([
      {
        project: project('w-salt', 1),
        rows,
        tasks: [
          { id: 't-a', goal: 'g-second', order: 0, createdAt: 1 },
          { id: 't-b', goal: 'g-first', order: 4, createdAt: 2 },
        ],
        goalIds: ['g-first', 'g-second'],
      },
    ]);
    expect(q.items.map((i) => i.key)).toEqual([
      // t-b is in the first goal: its own decision, then its questions by age.
      'w-salt:decision:t-b',
      'w-salt:task-review:t-b:r-9',
      'w-salt:task-thread:task:t-b:th-b',
      // t-a is in the second goal, so it waits behind all of t-b.
      'w-salt:task-review:t-a:r-2',
      // A doc comment has no task to rank by: the tail.
      'w-salt:doc-thread:d-notes:th-doc',
    ]);
  });

  it('keeps one task’s items in filing order, and never lets a filter show a later one first', () => {
    const q = crossReviewQueue([
      {
        project: project('w-river', 1),
        rows: [
          taskItem('t-plan', 'r-3', 30, 'easy'),
          taskItem('t-other', 'r-8', 5, 'easy'),
          taskItem('t-plan', 'r-1', 10, 'hard'),
          taskItem('t-plan', 'r-2', 20, 'easy'),
        ],
        tasks: [
          { id: 't-plan', goal: 'g', order: 0, createdAt: 1, dueAt: 1_800_000_000_000 },
          { id: 't-other', goal: 'g', order: 1, createdAt: 2 },
        ],
        goalIds: ['g'],
      },
    ]);
    expect(q.items.map((i) => [i.reviewItemId, i.size])).toEqual([
      ['r-1', 'hard'],
      // Easy on their own, but filed behind a hard one on the same task.
      ['r-2', 'hard'],
      ['r-3', 'hard'],
      // Another task's easy item is not held back by t-plan's.
      ['r-8', 'easy'],
    ]);
    expect(q.items.map((i) => i.minutes)).toEqual([8, 1, 1, 1]);
    expect(q.items.map((i) => i.dueAt)).toEqual([
      1_800_000_000_000,
      1_800_000_000_000,
      1_800_000_000_000,
      undefined,
    ]);
  });

  it('counts sizes cumulatively', () => {
    expect(
      countBySize([{ size: 'easy' }, { size: 'medium' }, { size: 'hard' }, { size: 'easy' }]),
    ).toEqual({ easy: 2, medium: 3, hard: 4 });
  });
});
