/**
 * `link-review-marks.ts` driven with plain objects: which threads ask a
 * person something, when a task's open count marks its link, and that a doc
 * is marked by either of the two sources its dock shows.
 */
import { describe, expect, it } from 'bun:test';
import type { TaskReviewItem, Thread } from '@claude-workspaces/core';
import { docNeedsReview, taskNeedsReview, threadAsksPerson } from '../src/link-review-marks.ts';

const AGENT = { id: 'agent-harborlight', name: 'Harborlight Lead', kind: 'known', color: '#888' };
const QUESTION = { shape: 'review', headline: 'Is the Riverbend timetable right?' } as const;

function thread(review: Record<string, unknown> | undefined, extra: Partial<Thread> = {}): Thread {
  return {
    id: 'th-1',
    status: 'open',
    anchor: { kind: 'doc' },
    comments: [
      { id: 'c-1', author: AGENT, text: 'One question.', ts: 1000, ...(review ? { review } : {}) },
    ],
    ...extra,
  } as unknown as Thread;
}

describe('threadAsksPerson', () => {
  it('reads an open, unanswered, visible declaration as an ask', () => {
    expect(threadAsksPerson(thread({ ...QUESTION }))).toBe(true);
  });

  it('reads no ask in a plain comment, a resolved thread, an answer or a held item', () => {
    expect(threadAsksPerson(thread(undefined))).toBe(false);
    expect(threadAsksPerson(thread({ ...QUESTION }, { status: 'resolved' }))).toBe(false);
    expect(threadAsksPerson(thread({ ...QUESTION, answeredAt: 2000 }))).toBe(false);
    expect(threadAsksPerson(thread({ ...QUESTION, judge: { verdict: 'held' } }))).toBe(false);
    expect(threadAsksPerson(thread({ ...QUESTION, judge: { verdict: 'pending' } }))).toBe(false);
  });

  it('reads no ask on a thread whose anchor is gone', () => {
    expect(
      threadAsksPerson(thread({ ...QUESTION }, { anchor: { kind: 'orphan' } as Thread['anchor'] })),
    ).toBe(false);
  });
});

describe('taskNeedsReview', () => {
  it('marks an open row with something open, and never a finished one', () => {
    expect(taskNeedsReview({ status: 'todo' }, 1)).toBe(true);
    expect(taskNeedsReview({ status: 'todo' }, 0)).toBe(false);
    expect(taskNeedsReview({ status: 'done' }, 2)).toBe(false);
    expect(taskNeedsReview({ status: 'in-progress', archivedAt: 5 }, 2)).toBe(false);
  });
});

describe('docNeedsReview', () => {
  const item = (detail: string): TaskReviewItem =>
    ({
      id: 'r-1',
      review: { shape: 'review', headline: 'Is the Saltmarsh page readable?', detail },
      createdAt: 1000,
      createdBy: AGENT.name,
    }) as unknown as TaskReviewItem;
  const sources = (threads: Thread[], reviews: TaskReviewItem[]) => ({
    openThreads: () => threads,
    boardTasks: () => [{ id: 't-1', title: 'Saltmarsh page', status: 'todo' as const, links: [] }],
    reviewsOf: () => reviews,
    canonical: (id: string) => id,
    owner: true,
  });

  it('is marked by its own thread ask', () => {
    expect(docNeedsReview('d-saltmarsh', sources([thread({ ...QUESTION })], []))).toBe(true);
  });

  it('is marked by a ticket item that links it, and not by one that links another page', () => {
    const here = item('Check [it](/workspaces/w-1/mockups/d-saltmarsh).');
    const there = item('Check [it](/workspaces/w-1/mockups/d-riverbend).');
    expect(docNeedsReview('d-saltmarsh', sources([], [here]))).toBe(true);
    expect(docNeedsReview('d-saltmarsh', sources([], [there]))).toBe(false);
  });

  it('is not marked by a plain comment', () => {
    expect(docNeedsReview('d-saltmarsh', sources([thread(undefined)], []))).toBe(false);
  });
});
