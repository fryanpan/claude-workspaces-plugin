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
  it('reads a board link in the body and a url link', () => {
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
  });

  it('names nothing from a title, a bare mention or an unknown board', () => {
    // A title prefix breaks silently on a rename, so it names nothing.
    expect(boardsNamedBy(goal('g0', 'Harborlight: booking flow'), boards)).toEqual([]);
    expect(boardsNamedBy(goal('g1', 'Research Riverbend options'), boards)).toEqual([]);
    expect(boardsNamedBy(goal('g2', 'x', { body: '/workspaces/w-gone' }), boards)).toEqual([]);
    // A link to a task on a board is about that task, not the project.
    expect(boardsNamedBy(goal('g3', 'x', { body: '/workspaces/w-salt?task=t-1' }), boards)).toEqual(
      [],
    );
  });
});

const linksTo = (...ids: string[]): Partial<GoalRow> => ({
  links: ids.map((id) => ({ kind: 'url' as const, url: `/workspaces/${id}` })),
});

describe('rankProjects', () => {
  it('orders named boards by the first goal naming them, then the rest by recency', () => {
    const goalRows = [
      goal('g-a', 'Tide widget', linksTo('w-salt')),
      goal('g-b', 'Rollout', linksTo('w-river')),
      goal('g-c', 'Second goal', linksTo('w-salt')),
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
    const goalRows = [goal('g-a', 'x', linksTo('w-salt')), goal('g-b', 'y', linksTo('w-river'))];
    const ranked = rankProjects(boards, {
      goals: [
        { id: 'g-b', title: '' },
        { id: 'g-a', title: '' },
      ],
      goalRows,
    });
    expect(ranked.slice(0, 2).map((p) => p.workspaceId)).toEqual(['w-river', 'w-salt']);
  });

  it('gives each board a goal links to that goal’s rank, or a better one it already had', () => {
    const goalRows = [
      goal('g-a', 'Harbour first', linksTo('w-harbor')),
      goal('g-b', 'Shared launch', linksTo('w-salt', 'w-harbor', 'w-river')),
    ];
    const ranked = rankProjects(boards, {
      goals: [
        { id: 'g-a', title: '' },
        { id: 'g-b', title: '' },
      ],
      goalRows,
    });
    // Harborlight keeps g-a; the other two share g-b and fall back to recency.
    expect(ranked.map((p) => [p.workspaceId, p.planned])).toEqual([
      ['w-harbor', true],
      ['w-salt', true],
      ['w-river', true],
      ['w-plan', false],
    ]);
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

  it('reads the owner’s hand edit without a restart, and survives a corrupt file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'review-plan-'));
    dirs.push(dir);
    const store = new ReviewPlanStore(dir);
    expect(store.get()).toBeUndefined();
    writeFileSync(join(dir, 'review-plan.json'), '{"planWorkspaceId":"w-salt"}');
    expect(store.get()).toBe('w-salt');
    writeFileSync(join(dir, 'review-plan.json'), '{"planWorkspaceId":null}');
    expect(store.get()).toBeUndefined();
    writeFileSync(join(dir, 'review-plan.json'), '{nope');
    expect(store.get()).toBeUndefined();
  });
});
