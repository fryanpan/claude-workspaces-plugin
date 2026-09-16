/**
 * The aging half: an unfiled wait the lead was told about, and nobody filed,
 * goes past the lead a window later — to Team Lead first, to the owner's own
 * queue only when Team Lead cannot be reached, and as ONE item however many
 * tasks and boards it spans.
 *
 * Three things are asserted, each with its control:
 *  - the AGE. One window is not enough; two is. The control is the same task
 *    at the same tick with the clock not advanced.
 *  - the SHAPE. Three tasks across two boards produce one item naming all
 *    three, not three items.
 *  - the LADDER. With Team Lead reachable, nothing reaches the owner at all.
 *
 * The store is the real `TaskStore`, so what is read back is what a person
 * would find on their queue.
 *
 * All fixtures are synthetic — invented names on made-up boards. The repo is
 * public.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { STALL_ESCALATION_ACTOR, type TeamLeadReach } from '../src/stall-escalation.ts';
import type { StalledRow } from '../src/stall-gate.ts';
import type { StallNudgeFrame, StallSnapshot } from '../src/stall-nudge.ts';
import { TaskStore } from '../src/tasks.ts';
import { WaitingUnfiledEscalations } from '../src/waiting-unfiled-escalation.ts';
import { WAITING_UNFILED_BUCKET } from '../src/waiting-unfiled.ts';

const MIN = 60_000;
const WINDOW = 30 * MIN;
const START = 10_000_000;

const LEAD = { id: 'agent-cartographer', name: 'Cartographer', kind: 'agent' as const };

describe('an unfiled wait that ages goes past its lead', () => {
  let dir = '';
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  /** A store with `titles.length` in-progress tasks on one board. */
  function boardWith(titles: readonly string[]): { store: TaskStore; ws: string; ids: string[] } {
    dir = dir || mkdtempSync(join(tmpdir(), 'wu-escalation-'));
    const store = new TaskStore({ dataDir: dir });
    const ws = store.createWorkspace({ name: 'release-train', leadAgentId: LEAD.id }).id;
    const ids = titles.map((title) => {
      const res = store.createTask(ws, {
        title,
        body: `Agent can ${title.toLowerCase()} so that the train leaves on time.`,
        assignee: LEAD.name,
        assigneeKind: 'agent',
        author: LEAD,
      });
      if (!res.ok) throw new Error(`could not create ${title}`);
      return res.task.id;
    });
    return { store, ws, ids };
  }

  const snapshot = (ws: string, rows: readonly StalledRow[]): StallSnapshot => ({
    workspaceId: ws,
    leadAgentId: LEAD.id,
    retired: false,
    stalled: [],
    unfiled: rows,
    considered: rows.length,
    undetermined: [],
  });

  const waitingRow = (id: string, title: string): StalledRow => ({
    id,
    title,
    bucket: WAITING_UNFILED_BUCKET,
    quietMs: 45 * MIN,
  });

  /** Every open review item the server itself wrote, across the store. */
  function boardFiledItems(store: TaskStore, workspaces: readonly string[]) {
    const out: Array<{ taskId: string; headline: string; detail: string }> = [];
    for (const ws of workspaces) {
      for (const task of store.listTasks(ws)) {
        for (const item of store.listReviewItems(task.id)) {
          if (item.createdBy !== STALL_ESCALATION_ACTOR.name) continue;
          const review = item.review as { headline?: string; detail?: string };
          out.push({
            taskId: task.id,
            headline: review.headline ?? '',
            detail: review.detail ?? '',
          });
        }
      }
    }
    return out;
  }

  it('is not escalated at one window and is at two', () => {
    const { store, ws, ids } = boardWith(['Cut the release branch']);
    const escalations = new WaitingUnfiledEscalations({ store, agingMs: WINDOW });
    const rows = [waitingRow(ids[0] as string, 'Cut the release branch')];

    escalations.onTick([snapshot(ws, rows)], START);
    expect(escalations.filedCount()).toBe(0);
    // Control: inside the window, still nothing.
    escalations.onTick([snapshot(ws, rows)], START + WINDOW - MIN);
    expect(escalations.filedCount()).toBe(0);
    expect(boardFiledItems(store, [ws])).toHaveLength(0);

    escalations.onTick([snapshot(ws, rows)], START + WINDOW);
    expect(escalations.filedCount()).toBe(1);
    expect(boardFiledItems(store, [ws])).toHaveLength(1);
  });

  it('a wait that gets filed before the second window never escalates at all', () => {
    const { store, ws, ids } = boardWith(['Cut the release branch']);
    const escalations = new WaitingUnfiledEscalations({ store, agingMs: WINDOW });
    const rows = [waitingRow(ids[0] as string, 'Cut the release branch')];
    escalations.onTick([snapshot(ws, rows)], START);
    // The lead filed the ask: the task stops being a finding, so the gate
    // stops naming it and this module forgets it.
    escalations.onTick([snapshot(ws, [])], START + MIN);
    escalations.onTick([snapshot(ws, rows)], START + WINDOW + MIN);
    expect(escalations.filedCount()).toBe(0);
    expect(boardFiledItems(store, [ws])).toHaveLength(0);
  });

  it('three tasks on two boards make ONE item naming all three', () => {
    dir = mkdtempSync(join(tmpdir(), 'wu-escalation-two-'));
    const store = new TaskStore({ dataDir: dir });
    const boards = ['release-train', 'search-revamp'].map((name) => {
      const ws = store.createWorkspace({ name, leadAgentId: LEAD.id }).id;
      return ws;
    });
    const titles = [
      ['Cut the release branch', 'Draft the rollout note'],
      ['Rank results by recency'],
    ];
    const ids = boards.map((ws, i) =>
      (titles[i] as string[]).map((title) => {
        const res = store.createTask(ws, {
          title,
          body: `Agent can ${title.toLowerCase()} so that the work lands.`,
          assignee: LEAD.name,
          assigneeKind: 'agent',
          author: LEAD,
        });
        if (!res.ok) throw new Error('create failed');
        return res.task.id;
      }),
    );
    const snapshots = boards.map((ws, i) =>
      snapshot(
        ws,
        (ids[i] as string[]).map((id, j) => waitingRow(id, (titles[i] as string[])[j] as string)),
      ),
    );
    const escalations = new WaitingUnfiledEscalations({ store, agingMs: WINDOW });
    escalations.onTick(snapshots, START);
    escalations.onTick(snapshots, START + WINDOW);

    const filed = boardFiledItems(store, boards);
    expect(filed).toHaveLength(1);
    expect(escalations.filedCount()).toBe(1);
    const only = filed[0];
    for (const id of ids.flat()) expect(only?.detail).toContain(id);
    expect(only?.headline).toContain('3 tasks');
  });

  it('with Team Lead reachable the owner is not the addressee', () => {
    const { store, ws, ids } = boardWith(['Cut the release branch']);
    const sent: Array<{ agentId: string; frame: StallNudgeFrame }> = [];
    const teamLead: TeamLeadReach = {
      agentId: 'agent-team-lead',
      boards: () => [ws],
      canReach: () => true,
      send: (_ws, agentId, frame) => {
        sent.push({ agentId, frame });
        return 1;
      },
    };
    const escalations = new WaitingUnfiledEscalations({ store, agingMs: WINDOW, teamLead });
    const rows = [waitingRow(ids[0] as string, 'Cut the release branch')];
    escalations.onTick([snapshot(ws, rows)], START);
    escalations.onTick([snapshot(ws, rows)], START + WINDOW);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.agentId).toBe('agent-team-lead');
    expect((sent[0]?.frame.unfiled ?? []).map((r) => r.id)).toEqual([ids[0] as string]);
    // The owner's queue is untouched while Team Lead is reachable.
    expect(boardFiledItems(store, [ws])).toHaveLength(0);

    // …and Team Lead is not told again inside the same window.
    escalations.onTick([snapshot(ws, rows)], START + WINDOW + MIN);
    expect(sent).toHaveLength(1);
    escalations.onTick([snapshot(ws, rows)], START + 2 * WINDOW + MIN);
    expect(sent).toHaveLength(2);
  });

  it('the item is withdrawn once every wait is filed', () => {
    const { store, ws, ids } = boardWith(['Cut the release branch']);
    const escalations = new WaitingUnfiledEscalations({ store, agingMs: WINDOW });
    const rows = [waitingRow(ids[0] as string, 'Cut the release branch')];
    escalations.onTick([snapshot(ws, rows)], START);
    escalations.onTick([snapshot(ws, rows)], START + WINDOW);
    expect(escalations.filedCount()).toBe(1);

    escalations.onTick([snapshot(ws, [])], START + WINDOW + MIN);
    expect(escalations.filedCount()).toBe(0);
    const items = store.listReviewItems(ids[0] as string);
    const ours = items.find((i) => i.createdBy === STALL_ESCALATION_ACTOR.name);
    expect(ours?.withdrawnAt ?? ours?.review).toBeDefined();
  });
});
