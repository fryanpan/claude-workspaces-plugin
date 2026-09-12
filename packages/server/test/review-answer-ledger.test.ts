import { afterEach, describe, expect, it } from 'bun:test';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ReviewSize } from '@claude-workspaces/core';
import type { CrossReviewItem, CrossReviewQueue } from '../src/cross-review-queue.ts';
import {
  type AnswerRecord,
  ReviewAnswerLedger,
  measureAnswer,
  reviewWait,
  visibleAtOf,
} from '../src/review-answer-ledger.ts';

function item(
  workspaceId: string,
  taskId: string,
  since: number,
  size: ReviewSize,
): CrossReviewItem {
  return {
    kind: 'task-review',
    band: 'declared',
    taskId,
    reviewItemId: 'r-1',
    review: { shape: 'review', headline: 'Check' },
    title: taskId,
    ask: 'Check',
    askedBy: 'Agent',
    since,
    direct: true,
    askedAt: since,
    state: 'open',
    minutes: 1,
    size,
    workspaceId,
    project: workspaceId,
    key: `${workspaceId}:task-review:${taskId}:r-1`,
  };
}

const project = (workspaceId: string, rank: number) => ({
  workspaceId,
  name: workspaceId,
  lastActivity: 0,
  rank,
  planned: true,
});

describe('measureAnswer', () => {
  const board = {
    tasks: [
      { id: 't-1', goal: 'g', order: 0, createdAt: 1 },
      { id: 't-2', goal: 'g', order: 1, createdAt: 2 },
      { id: 't-3', goal: 'g', order: 2, createdAt: 3 },
    ],
    goalIds: ['g'],
  };
  // The queue as it stands AFTER t-2 on Harborlight was answered.
  const queue: CrossReviewQueue = {
    projects: [project('w-river', 1), project('w-harbor', 2)],
    items: [
      item('w-river', 't-9', 5, 'hard'),
      item('w-harbor', 't-1', 1, 'medium'),
      item('w-harbor', 't-3', 3, 'easy'),
    ],
  };
  const ask = {
    kind: 'task-review' as const,
    taskId: 't-2',
    direct: true,
    since: 2,
    tie: 't-2:r-1',
  };

  it('counts what was still open above the answered item, at each size level', () => {
    expect(measureAnswer({ queue, workspaceId: 'w-harbor', ask, board })).toEqual({
      rankAtAnswer: 3,
      higherOpen: { easy: 0, medium: 1, hard: 2 },
      projectRank: 2,
    });
  });

  it('reads an answer at the very top as in order', () => {
    const top = measureAnswer({
      queue,
      workspaceId: 'w-river',
      ask: { kind: 'task-review', taskId: 't-0', direct: true, since: 0, tie: 't-0:r-1' },
      board: { tasks: [{ id: 't-0', goal: 'g', order: 0, createdAt: 0 }], goalIds: ['g'] },
    });
    expect(top.rankAtAnswer).toBe(1);
  });
});

describe('visibleAtOf', () => {
  it('starts the clock at release for a held item, at creation otherwise', () => {
    expect(visibleAtOf(100, undefined)).toBe(100);
    expect(visibleAtOf(100, { at: 150, verdict: 'ok', reason: 'Clear' })).toBe(100);
    expect(visibleAtOf(100, { at: 400, verdict: 'ok', reason: 'Released by the owner' })).toBe(400);
    expect(
      visibleAtOf(100, { at: 900, verdict: 'held', reason: 'Vague', heldFor: ['vague'] }, 300),
    ).toBe(300);
  });
});

describe('the ledger', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  const rec = (over: Partial<AnswerRecord>): AnswerRecord => ({
    workspaceId: 'w-river',
    key: 'k',
    askedAt: 0,
    visibleAt: 0,
    answeredAt: 1000,
    size: 'easy',
    minutes: 1,
    rankAtAnswer: 1,
    higherOpen: { easy: 0, medium: 0, hard: 0 },
    projectRank: 1,
    ...over,
  });

  it('appends, reads from a time, and skips a torn line', () => {
    const dir = mkdtempSync(join(tmpdir(), 'answer-ledger-'));
    dirs.push(dir);
    const ledger = new ReviewAnswerLedger(dir);
    ledger.append(rec({ key: 'early', answeredAt: 10 }));
    appendFileSync(join(dir, 'review-answers.jsonl'), '{"workspaceId":"w-ri');
    appendFileSync(join(dir, 'review-answers.jsonl'), '\n');
    ledger.append(rec({ key: 'late', answeredAt: 500 }));
    expect(ledger.read().map((r) => r.key)).toEqual(['early', 'late']);
    expect(ledger.read(100).map((r) => r.key)).toEqual(['late']);
  });

  it('reports wait from visibility and the in-order share per board', () => {
    const boards = reviewWait(
      [
        rec({ visibleAt: 0, answeredAt: 100 }),
        rec({
          visibleAt: 0,
          answeredAt: 300,
          size: 'easy',
          higherOpen: { easy: 0, medium: 2, hard: 3 },
        }),
        rec({ visibleAt: 100, answeredAt: 300 }),
        rec({
          workspaceId: 'w-harbor',
          visibleAt: 0,
          answeredAt: 50,
          size: 'hard',
          higherOpen: { easy: 1, medium: 1, hard: 1 },
        }),
      ],
      (id) => (id === 'w-river' ? 'Riverbend' : 'Harborlight'),
    );
    expect(boards).toEqual([
      {
        workspaceId: 'w-harbor',
        name: 'Harborlight',
        answered: 1,
        medianWaitMs: 50,
        p90WaitMs: 50,
        inOrder: 0,
        inOrderWithinSize: 0,
      },
      {
        workspaceId: 'w-river',
        name: 'Riverbend',
        answered: 3,
        medianWaitMs: 200,
        p90WaitMs: 300,
        inOrder: 0.667,
        inOrderWithinSize: 1,
      },
    ]);
  });
});
