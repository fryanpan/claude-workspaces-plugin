import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ReviewPlanStore,
  boardsNamedBy,
  rankProjects,
  resolvePlanBoard,
} from '../src/review-plan.ts';
import type { GoalRow } from '../src/tasks.ts';

const boards = [
  { id: 'w-river', name: 'Riverbend', lastActivity: 100, leadAgentId: 'agent-river' },
  { id: 'w-harbor', name: 'Harborlight', lastActivity: 300 },
  { id: 'w-salt', name: 'Saltmarsh', lastActivity: 200 },
  { id: 'w-plan', name: 'Team Lead', lastActivity: 50, leadAgentId: 'agent-team-lead' },
];

function goal(id: string, title: string, extra: Partial<GoalRow> = {}): GoalRow {
  return {
    id,
    workspaceId: 'w-plan',
    kind: 'goal',
    title,
    order: 0,
    status: 'todo',
    transitions: [],
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  };
}

describe('boardsNamedBy', () => {
  it('reads a board link in the body, a url link, and a "Name:" title', () => {
    expect(
      boardsNamedBy(
        goal('g1', 'Ship it', { body: 'Work on [it](/workspaces/w-salt/home).' }),
        boards,
      ),
    ).toEqual(['w-salt']);
    expect(
      boardsNamedBy(
        goal('g2', 'Ship it', { links: [{ kind: 'url', url: '/workspaces/w-river' }] }),
        boards,
      ),
    ).toEqual(['w-river']);
    expect(boardsNamedBy(goal('g3', 'harborlight: booking flow'), boards)).toEqual(['w-harbor']);
  });

  it('names nothing from a bare mention or an unknown board', () => {
    expect(boardsNamedBy(goal('g1', 'Research Riverbend options'), boards)).toEqual([]);
    expect(boardsNamedBy(goal('g2', 'x', { body: '/workspaces/w-gone' }), boards)).toEqual([]);
    // A link to a task on a board is about that task, not the project.
    expect(boardsNamedBy(goal('g3', 'x', { body: '/workspaces/w-salt?task=t-1' }), boards)).toEqual(
      [],
    );
  });
});

describe('rankProjects', () => {
  it('orders named boards by the first goal naming them, then the rest by recency', () => {
    const goalRows = [
      goal('g-a', 'Saltmarsh: tide widget'),
      goal('g-b', 'Riverbend: rollout'),
      goal('g-c', 'Saltmarsh: second goal'),
    ];
    const ranked = rankProjects(boards, {
      goals: [
        { id: 'g-a', title: '' },
        { id: 'g-b', title: '' },
        { id: 'g-c', title: '' },
      ],
      goalRows,
    });
    expect(ranked.map((p) => [p.workspaceId, p.rank, p.planned])).toEqual([
      ['w-salt', 1, true],
      ['w-river', 2, true],
      ['w-harbor', 3, false],
      ['w-plan', 4, false],
    ]);
  });

  it('follows the band order, so reordering goals reorders projects', () => {
    const goalRows = [goal('g-a', 'Saltmarsh: x'), goal('g-b', 'Riverbend: y')];
    const ranked = rankProjects(boards, {
      goals: [
        { id: 'g-b', title: '' },
        { id: 'g-a', title: '' },
      ],
      goalRows,
    });
    expect(ranked.slice(0, 2).map((p) => p.workspaceId)).toEqual(['w-river', 'w-salt']);
  });

  it('ranks purely by recency with no plan', () => {
    expect(rankProjects(boards, null).map((p) => p.workspaceId)).toEqual([
      'w-harbor',
      'w-salt',
      'w-river',
      'w-plan',
    ]);
  });
});

describe('the plan board', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('is the owner setting when it names a live board, else the spawner-led board', () => {
    expect(resolvePlanBoard(boards, 'w-salt', 'agent-team-lead')).toBe('w-salt');
    expect(resolvePlanBoard(boards, 'w-gone', 'agent-team-lead')).toBe('w-plan');
    expect(resolvePlanBoard(boards, undefined, 'agent-team-lead')).toBe('w-plan');
    expect(resolvePlanBoard(boards, undefined, 'agent-nobody')).toBeUndefined();
  });

  it('persists the setting across a restart and survives a corrupt file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'review-plan-'));
    dirs.push(dir);
    new ReviewPlanStore(dir).set('w-salt');
    expect(new ReviewPlanStore(dir).get()).toBe('w-salt');
    new ReviewPlanStore(dir).set(null);
    expect(new ReviewPlanStore(dir).get()).toBeUndefined();
    writeFileSync(join(dir, 'review-plan.json'), '{nope');
    expect(new ReviewPlanStore(dir).get()).toBeUndefined();
  });
});
