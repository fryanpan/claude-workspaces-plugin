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
 *  - **Which board is the plan.** An owner setting (`review-plan.json`), and
 *    when that is unset the board whose lead seat is held by the server's
 *    spawner agent (Team Lead) — the most recently active one if the seat
 *    holds more than one board.
 *  - **Which project a goal names.** A goal names a board by linking to it
 *    (`/workspaces/<id>` in its prose or its links) or by a title that starts
 *    with the board's name and a colon ("Riverbend: ship the digest"). The
 *    first goal in band order that names a board ranks it; a goal may name
 *    several. A board no goal names ranks after every named one, newest
 *    activity first, so an unplanned board is late rather than missing.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type WorkspaceLink,
  extractWorkspaceLinks,
  parseWorkspaceLink,
} from '@claude-workspaces/core';
import type { GoalRow, WorkspaceGoal } from './tasks.ts';

const FILENAME = 'review-plan.json';

/** The owner's choice of plan board, persisted. Absent means "derive it". */
export class ReviewPlanStore {
  private readonly path: string;
  private planWorkspaceId: string | undefined;

  constructor(dataDir: string) {
    this.path = join(dataDir, FILENAME);
    if (!existsSync(this.path)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as { planWorkspaceId?: unknown };
      if (typeof parsed.planWorkspaceId === 'string' && parsed.planWorkspaceId) {
        this.planWorkspaceId = parsed.planWorkspaceId;
      }
    } catch {
      // A corrupt file falls back to the derived plan board. Unlike a gate on
      // external reach, getting this wrong reorders a list and hides nothing.
    }
  }

  get(): string | undefined {
    return this.planWorkspaceId;
  }

  /** `null` clears the setting, handing the choice back to the derivation. */
  set(workspaceId: string | null): void {
    this.planWorkspaceId = workspaceId ?? undefined;
    mkdirSync(join(this.path, '..'), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ planWorkspaceId: workspaceId ?? null })}\n`);
    renameSync(tmp, this.path);
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

/** The board ids one goal names. */
export function boardsNamedBy(
  goal: Pick<GoalRow, 'title' | 'body' | 'links'>,
  boards: readonly Pick<PlanBoardInput, 'id' | 'name'>[],
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
  const title = goal.title.trim().toLowerCase();
  for (const b of boards) {
    const name = b.name.trim().toLowerCase();
    if (name && title.startsWith(`${name}:`)) named.add(b.id);
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
 * Every board in project order: named boards by the first plan goal that
 * names them, then the rest by recency. The plan board's goals are read in
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
