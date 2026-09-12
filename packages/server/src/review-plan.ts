/**
 * Which project comes first: the weekly plan, read off the plan board's goals.
 *
 * Bryan reviews across several boards in one sitting, top project first
 * (decision on the cross-board review task, 2026-09-12: *"Project first makes
 * sense as a default"*). The project order is Team Lead's weekly goal order —
 * the band order on the plan board, where each goal names the project it is
 * about. Nothing here is a ranking anyone sets directly: move a goal on the
 * plan board and the projects move with it, and no agent verb exists that
 * reorders projects on its own.
 *
 * Two questions, one file, because they are asked together:
 *
 *  - **Which board is the plan.** The owner's hand-edited
 *    `review-plan.json` (`{"planWorkspaceId": "<id>"}`), read on every
 *    queue read so an edit lands without a restart. No route writes it: one
 *    file the owner edits is less surface than a verb somebody could call.
 *    When it is unset, or names no live board, the plan is the board whose
 *    lead seat the server's spawner agent (Team Lead) holds — the most
 *    recently active one if the seat holds more than one.
 *  - **Which project a goal names.** A structured link to the board
 *    (`/workspaces/<id>`) in the goal's links or its body. Never the goal's
 *    title: a title prefix breaks silently the day a board is renamed. A goal
 *    may name several boards, and each takes the best (earliest) goal that
 *    names it. A board no goal names ranks after every named one, newest
 *    activity first, so an unplanned board is late rather than missing.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type WorkspaceLink,
  extractWorkspaceLinks,
  parseWorkspaceLink,
} from '@claude-workspaces/core';
import type { GoalRow, WorkspaceGoal } from './tasks.ts';

const FILENAME = 'review-plan.json';

/** The owner's choice of plan board, as they last wrote the file. */
export class ReviewPlanStore {
  private readonly path: string;

  constructor(dataDir: string) {
    this.path = join(dataDir, FILENAME);
  }

  /** The named board id, or undefined for "derive it". */
  get(): string | undefined {
    if (!existsSync(this.path)) return undefined;
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as { planWorkspaceId?: unknown };
      return typeof parsed.planWorkspaceId === 'string' && parsed.planWorkspaceId
        ? parsed.planWorkspaceId
        : undefined;
    } catch {
      // A corrupt file falls back to the derived plan board. Unlike a gate on
      // external reach, getting this wrong reorders a list and hides nothing.
      return undefined;
    }
  }
}

/** What the ranking reads of one board. */
export interface PlanBoardInput {
  id: string;
  name: string;
  lastActivity: number;
  leadAgentId?: string;
}

/**
 * The plan board's id, or undefined when there is none: the owner's setting
 * if it names a live board, else the spawner-led board with the newest
 * activity.
 */
export function resolvePlanBoard(
  boards: readonly PlanBoardInput[],
  setting: string | undefined,
  spawnerAgentId: string,
): string | undefined {
  if (setting && boards.some((b) => b.id === setting)) return setting;
  let best: PlanBoardInput | undefined;
  for (const b of boards) {
    if (b.leadAgentId !== spawnerAgentId) continue;
    if (!best || b.lastActivity > best.lastActivity) best = b;
  }
  return best?.id;
}

function linkedBoard(link: WorkspaceLink): string | undefined {
  return link.kind === 'workspace' ? link.workspaceId : undefined;
}

/** The board ids one goal links to. */
export function boardsNamedBy(
  goal: Pick<GoalRow, 'body' | 'links'>,
  boards: readonly Pick<PlanBoardInput, 'id'>[],
): string[] {
  const named = new Set<string>();
  const known = new Set(boards.map((b) => b.id));
  for (const { link } of extractWorkspaceLinks(goal.body ?? '')) {
    const id = linkedBoard(link);
    if (id && known.has(id)) named.add(id);
  }
  for (const ref of goal.links ?? []) {
    if (ref.kind !== 'url') continue;
    const link = parseWorkspaceLink(ref.url);
    const id = link ? linkedBoard(link) : undefined;
    if (id && known.has(id)) named.add(id);
  }
  return [...named];
}

export interface RankedProject {
  workspaceId: string;
  name: string;
  lastActivity: number;
  /** 1-based, contiguous across every board on the page. */
  rank: number;
  /** True when a plan goal named this board; false for the recency tail. */
  planned: boolean;
}

/**
 * Every board in project order: named boards by the best (earliest) plan goal
 * that links to them, then the rest by recency. The plan board's goals are read in
 * the order of `goals` (band order); archived bands are not in `goalRows`.
 */
export function rankProjects(
  boards: readonly PlanBoardInput[],
  plan: { goals: readonly WorkspaceGoal[]; goalRows: readonly GoalRow[] } | null,
): RankedProject[] {
  const firstGoal = new Map<string, number>();
  if (plan) {
    const rowById = new Map(plan.goalRows.map((r) => [r.id, r]));
    plan.goals.forEach((g, index) => {
      const row = rowById.get(g.id);
      if (!row) return;
      for (const id of boardsNamedBy(row, boards)) {
        if (!firstGoal.has(id)) firstGoal.set(id, index);
      }
    });
  }
  const ordered = [...boards].sort((a, b) => {
    const ga = firstGoal.get(a.id);
    const gb = firstGoal.get(b.id);
    if (ga !== undefined && gb !== undefined && ga !== gb) return ga - gb;
    if (ga !== undefined && gb === undefined) return -1;
    if (ga === undefined && gb !== undefined) return 1;
    return (
      b.lastActivity - a.lastActivity || a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
    );
  });
  return ordered.map((b, i) => ({
    workspaceId: b.id,
    name: b.name,
    lastActivity: b.lastActivity,
    rank: i + 1,
    planned: firstGoal.has(b.id),
  }));
}
