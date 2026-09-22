/**
 * The per-board filing, driven directly.
 *
 * `waiting-unfiled-escalation.test.ts` reaches these through a tick, a clock
 * and an aging window, which is the right shape for the ladder and the wrong
 * one for the two invariants this module holds: never two items for one
 * board, and one board's item naming one board's rows. Here the sidecar is
 * handed over by hand, so a case can build a state a tick would take four
 * windows to reach.
 *
 * Fixtures are synthetic — invented boards and titles. The repo is public.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reviewWithdrawn } from '@claude-workspaces/core';
import { STALL_ESCALATION_ACTOR } from '../src/stall-escalation.ts';
import { TaskStore } from '../src/tasks.ts';
import {
  type FilingContext,
  fileEachBoard,
  withdrawBoardItem,
} from '../src/waiting-unfiled-filing.ts';
import type { AgingWait } from '../src/waiting-unfiled-review.ts';
import { type Sidecar, emptySidecar } from '../src/waiting-unfiled-sidecar.ts';
import { WAITING_UNFILED_BUCKET } from '../src/waiting-unfiled.ts';

const MIN = 60_000;
const WINDOW = 30 * MIN;
const NOW = 5_000 * MIN;

describe('the per-board filing', () => {
  let dir = '';
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  function harness() {
    dir = mkdtempSync(join(tmpdir(), 'wu-filing-'));
    const store = new TaskStore({ dataDir: dir });
    const said: string[] = [];
    const sidecar: Sidecar = emptySidecar();
    const ctx: FilingContext = {
      store,
      sidecar,
      agingMs: WINDOW,
      say: (m) => said.push(m),
    };
    return { store, sidecar, ctx, said };
  }

  function board(store: TaskStore, name: string, titles: readonly string[]) {
    const ws = store.createWorkspace(name, { leadAgentId: 'agent-lead' }).id;
    const ids = titles.map((title) => {
      const res = store.createTask(ws, {
        title,
        body: `Agent can ${title.toLowerCase()} so that the work lands.`,
        assignee: 'Cartographer',
        assigneeKind: 'agent',
      });
      if (!res.ok) throw new Error('create failed');
      return res.task.id;
    });
    return { ws, ids };
  }

  const wait = (ws: string, taskId: string, title: string): AgingWait => ({
    workspaceId: ws,
    taskId,
    title,
    bucket: WAITING_UNFILED_BUCKET,
    quietMs: 60 * MIN,
    firstSeen: NOW - 2 * WINDOW,
    tells: 3,
  });

  const items = (store: TaskStore, taskId: string) =>
    store.listReviewItems(taskId).filter((i) => i.createdBy === STALL_ESCALATION_ACTOR.name);

  it('files one item per board, each naming only its own rows', () => {
    const { store, sidecar, ctx } = harness();
    const ferry = board(store, 'harborlight-ferry', ['Rebuild the timetable']);
    const mill = board(store, 'riverbend-mill', ['Rank the mill results']);
    const rows = [
      wait(ferry.ws, ferry.ids[0] as string, 'Rebuild the timetable'),
      wait(mill.ws, mill.ids[0] as string, 'Rank the mill results'),
    ];

    fileEachBoard(ctx, rows, rows, NOW);

    expect(Object.keys(sidecar.filedByBoard ?? {}).sort()).toEqual([ferry.ws, mill.ws].sort());
    const ferryItem = items(store, ferry.ids[0] as string);
    const millItem = items(store, mill.ids[0] as string);
    expect(ferryItem).toHaveLength(1);
    expect(millItem).toHaveLength(1);
    const detail = (i: (typeof ferryItem)[number]) =>
      (i.review as { detail?: string }).detail ?? '';
    expect(detail(ferryItem[0] as (typeof ferryItem)[number])).not.toContain(mill.ids[0] as string);
    expect(detail(millItem[0] as (typeof millItem)[number])).not.toContain(ferry.ids[0] as string);
  });

  it('revises the standing item rather than filing a second for the board', () => {
    const { store, sidecar, ctx } = harness();
    const { ws, ids } = board(store, 'harborlight-ferry', [
      'Rebuild the timetable',
      'Publish the tide table',
    ]);
    const first = [wait(ws, ids[0] as string, 'Rebuild the timetable')];
    fileEachBoard(ctx, first, first, NOW);
    const filedId = sidecar.filedByBoard?.[ws]?.itemId ?? '';
    expect(filedId).not.toBe('');

    // The board's set grows. The anchor keeps its one item.
    const both = [...first, wait(ws, ids[1] as string, 'Publish the tide table')];
    fileEachBoard(ctx, both, both, NOW + WINDOW);

    const standing = items(store, ids[0] as string);
    expect(standing).toHaveLength(1);
    expect(standing[0]?.id).toBe(filedId);
    expect(items(store, ids[1] as string)).toHaveLength(0);
    expect((standing[0]?.review as { detail?: string }).detail ?? '').toContain(ids[1] as string);
  });

  it('a board that drops out of `stillDue` has its item withdrawn, and the rest stand', () => {
    const { store, sidecar, ctx } = harness();
    const ferry = board(store, 'harborlight-ferry', ['Rebuild the timetable']);
    const mill = board(store, 'riverbend-mill', ['Rank the mill results']);
    const ferryRow = wait(ferry.ws, ferry.ids[0] as string, 'Rebuild the timetable');
    const millRow = wait(mill.ws, mill.ids[0] as string, 'Rank the mill results');
    fileEachBoard(ctx, [ferryRow, millRow], [ferryRow, millRow], NOW);
    expect(Object.keys(sidecar.filedByBoard ?? {})).toHaveLength(2);

    // The ferry's ask got filed, so only the mill is still due.
    fileEachBoard(ctx, [millRow], [millRow], NOW + WINDOW);

    expect(Object.keys(sidecar.filedByBoard ?? {})).toEqual([mill.ws]);
    const withdrawn = (taskId: string) => {
      const review = items(store, taskId)[0]?.review;
      return review !== undefined && reviewWithdrawn(review);
    };
    expect(withdrawn(ferry.ids[0] as string)).toBe(true);
    // CONTROL: the board still due keeps an item a person can answer.
    expect(withdrawn(mill.ids[0] as string)).toBe(false);
  });

  it('withdrawing one board forgets it, and withdrawing an unknown board is a no-op', () => {
    const { store, sidecar, ctx, said } = harness();
    const { ws, ids } = board(store, 'harborlight-ferry', ['Rebuild the timetable']);
    const rows = [wait(ws, ids[0] as string, 'Rebuild the timetable')];
    fileEachBoard(ctx, rows, rows, NOW);

    withdrawBoardItem(ctx, ws, 'the ferry sailed');
    expect(sidecar.filedByBoard).toBeUndefined();
    const review = items(store, ids[0] as string)[0]?.review;
    expect(review !== undefined && reviewWithdrawn(review)).toBe(true);
    expect(said.some((m) => m.includes('cleared'))).toBe(true);

    // A board with nothing filed: no throw, and nothing announced.
    const before = said.length;
    withdrawBoardItem(ctx, 'w-nobody', 'nothing to take back');
    expect(said).toHaveLength(before);
  });
});
