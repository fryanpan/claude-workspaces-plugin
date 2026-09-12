/**
 * What happened each time a person answered a review item: how long it had
 * waited, and whether anything ranked above it was still open.
 *
 * Two questions Bryan wants answered three days after the cross-board flow
 * ships: how often does he answer in priority order, and how long does an
 * item wait for him? Neither can be rebuilt precisely afterwards: the rank an
 * item held is a fact about the whole queue at the moment of the answer, and
 * the queue has moved on by the next read. So every answer appends one line
 * to `<dataDir>/review-answers.jsonl`, from release onwards.
 *
 * `higherOpen` counts the open items ranked above the answered one, per size
 * level: at `easy` only easy ones, at `medium` easy and medium, at `hard`
 * everything. Recording all three means the report can ask "in order" both
 * ways, ignoring size or allowing for what fit the time he had, without
 * having to know which filter was on when he answered.
 *
 * Wait is `answeredAt − visibleAt`. An item the quality judge held was not in
 * front of anybody while held, so its clock starts at the verdict that let it
 * through (`judge.at`). A later revision re-judges the item and moves
 * `judge.at`, so the release is taken as the earlier of that verdict and the
 * first revision — an approximation, stated here rather than hidden.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ReviewItemJudgement, ReviewSize } from '@claude-workspaces/core';
import {
  type AskShape,
  type CrossReviewQueue,
  type OrderTask,
  askShapeOf,
  boardRanker,
  ranksAhead,
} from './cross-review-queue.ts';

const FILENAME = 'review-answers.jsonl';

export interface AnswerRecord {
  workspaceId: string;
  /** The board's key for the item, as the flow and Home spell it. */
  key: string;
  askedAt: number;
  visibleAt: number;
  answeredAt: number;
  size: ReviewSize;
  minutes: number;
  /** 1-based position in the cross-board queue at the moment of the answer. */
  rankAtAnswer: number;
  /** Open items ranked above it, counted at each cumulative size level. */
  higherOpen: Record<ReviewSize, number>;
  /** The board's project rank, and the plan board it was read from. */
  projectRank: number;
  planWorkspaceId?: string;
}

/** When a held item first reached the queue. See the header. */
export function visibleAtOf(
  createdAt: number,
  judge: ReviewItemJudgement | undefined,
  firstRevisionAt?: number,
): number {
  if (!judge) return createdAt;
  const held =
    judge.verdict === 'held' ||
    (judge.heldFor?.length ?? 0) > 0 ||
    judge.reason.startsWith('Released by');
  if (!held) return createdAt;
  const release = Math.min(judge.at, firstRevisionAt ?? Number.POSITIVE_INFINITY);
  return Math.max(createdAt, release);
}

/**
 * Where the answered item stood, measured against the queue as it is now —
 * the answered item has already left it, so everything still open is either
 * above it or below it.
 */
export function measureAnswer(args: {
  queue: CrossReviewQueue;
  workspaceId: string;
  ask: AskShape;
  board: { tasks: OrderTask[]; goalIds: string[] };
}): { rankAtAnswer: number; higherOpen: Record<ReviewSize, number>; projectRank: number } {
  const { queue, workspaceId, ask, board } = args;
  const project = queue.projects.find((p) => p.workspaceId === workspaceId);
  const projectRank = project?.rank ?? queue.projects.length + 1;
  const rankOf = new Map(queue.projects.map((p) => [p.workspaceId, p.rank]));
  const ranker = boardRanker(board.tasks, board.goalIds);
  const higherOpen: Record<ReviewSize, number> = { easy: 0, medium: 0, hard: 0 };
  for (const item of queue.items) {
    const itemProject = rankOf.get(item.workspaceId) ?? Number.POSITIVE_INFINITY;
    const above =
      itemProject < projectRank ||
      (item.workspaceId === workspaceId && ranksAhead(ranker, askShapeOf(item), ask));
    if (!above) continue;
    if (item.size === 'easy') higherOpen.easy += 1;
    if (item.size !== 'hard') higherOpen.medium += 1;
    higherOpen.hard += 1;
  }
  return { rankAtAnswer: higherOpen.hard + 1, higherOpen, projectRank };
}

/** The append-only log. */
export class ReviewAnswerLedger {
  private readonly path: string;

  constructor(dataDir: string) {
    this.path = join(dataDir, FILENAME);
  }

  append(record: AnswerRecord): void {
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, `${JSON.stringify(record)}\n`);
  }

  /** Every record answered at or after `since`. A torn line is skipped. */
  read(since = 0): AnswerRecord[] {
    if (!existsSync(this.path)) return [];
    const out: AnswerRecord[] = [];
    for (const line of readFileSync(this.path, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line) as AnswerRecord;
        if (typeof rec.answeredAt === 'number' && rec.answeredAt >= since) out.push(rec);
      } catch {
        // A crash mid-append leaves at most one torn line; the rest stand.
      }
    }
    return out;
  }
}

export interface BoardWait {
  workspaceId: string;
  name: string;
  answered: number;
  medianWaitMs: number;
  p90WaitMs: number;
  /** Share answered with nothing open ranked above them. */
  inOrder: number;
  /** Share answered with nothing of the same size or smaller ranked above. */
  inOrderWithinSize: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[i] ?? 0;
}

/** Per-board wait and in-order share, the read Team Lead asked for. */
export function reviewWait(records: AnswerRecord[], nameOf: (id: string) => string): BoardWait[] {
  const byBoard = new Map<string, AnswerRecord[]>();
  for (const r of records) {
    const list = byBoard.get(r.workspaceId) ?? [];
    list.push(r);
    byBoard.set(r.workspaceId, list);
  }
  const out: BoardWait[] = [];
  for (const [workspaceId, list] of byBoard) {
    const waits = list.map((r) => Math.max(0, r.answeredAt - r.visibleAt)).sort((a, b) => a - b);
    const share = (n: number) => Math.round((n / list.length) * 1000) / 1000;
    out.push({
      workspaceId,
      name: nameOf(workspaceId),
      answered: list.length,
      medianWaitMs: percentile(waits, 0.5),
      p90WaitMs: percentile(waits, 0.9),
      inOrder: share(list.filter((r) => r.higherOpen.hard === 0).length),
      inOrderWithinSize: share(list.filter((r) => r.higherOpen[r.size] === 0).length),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
