import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
/**
 * The aging half: an unfiled wait the lead was told about, and nobody filed,
 * goes past the lead a window later — to Team Lead first, to the owner's own
 * queue only when Team Lead cannot be reached, and as ONE item per BOARD
 * however many tasks on it are waiting.
 *
 * Three things are asserted, each with its control:
 *  - the AGE. One window is not enough; two is. The control is the same task
 *    at the same tick with the clock not advanced.
 *  - the SHAPE. Three tasks across two boards produce one item per board,
 *    each naming only its own board's tasks — not three items, and not one
 *    item naming rows a reader cannot act on.
 *  - the LADDER. With Team Lead reachable, nothing reaches the owner at all.
 *
 * The store is the real `TaskStore`, so what is read back is what a person
 * would find on their queue.
 *
 * All fixtures are synthetic — invented names on made-up boards. The repo is
 * public.
 */
import { type ReviewPayload, reviewWithdrawn } from '@claude-workspaces/core';
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
    const ws = store.createWorkspace('release-train', { leadAgentId: LEAD.id }).id;
    const ids = titles.map((title) => {
      const res = store.createTask(ws, {
        title,
        body: `Agent can ${title.toLowerCase()} so that the train leaves on time.`,
        assignee: LEAD.name,
        assigneeKind: 'agent',
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

  it('three tasks on two boards make ONE item PER BOARD, each naming its own', () => {
    dir = mkdtempSync(join(tmpdir(), 'wu-escalation-two-'));
    const store = new TaskStore({ dataDir: dir });
    const boards = ['release-train', 'search-revamp'].map((name) => {
      const ws = store.createWorkspace(name, { leadAgentId: LEAD.id }).id;
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

    // One item per board, not one for the server: an item revised to name a
    // board its reader is not working gives them nothing to act on (Bryan,
    // 2026-09-21: "The second isn't even in your project").
    expect(escalations.filedCount()).toBe(2);
    const first = boardFiledItems(store, [boards[0] as string]);
    const second = boardFiledItems(store, [boards[1] as string]);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    // Each item names its own board's tasks…
    for (const id of ids[0] as string[]) expect(first[0]?.detail).toContain(id);
    for (const id of ids[1] as string[]) expect(second[0]?.detail).toContain(id);
    // …and none of the other's, which is the half that was wrong.
    for (const id of ids[1] as string[]) expect(first[0]?.detail).not.toContain(id);
    for (const id of ids[0] as string[]) expect(second[0]?.detail).not.toContain(id);
    // The counts are each board's own, not the fleet's three.
    expect(first[0]?.headline).toContain('2 tasks');
    expect(second[0]?.headline).toContain('Rank results by recency');
  });

  it('withdraws one board’s item while the other board is still waiting', () => {
    // The per-board items have to come back independently, or a board that
    // filed its asks would keep a standing item because a different board
    // has not.
    dir = mkdtempSync(join(tmpdir(), 'wu-escalation-one-clears-'));
    const store = new TaskStore({ dataDir: dir });
    const boards = ['harborlight-ferry', 'saltmarsh-yard'].map(
      (name) => store.createWorkspace(name, { leadAgentId: LEAD.id }).id,
    );
    const titles = ['Cut the release branch', 'Publish the winter timetable'];
    const ids = boards.map((ws, i) => {
      const res = store.createTask(ws, {
        title: titles[i] as string,
        body: `Agent can ${(titles[i] as string).toLowerCase()} so that the work lands.`,
        assignee: LEAD.name,
        assigneeKind: 'agent',
      });
      if (!res.ok) throw new Error('create failed');
      return res.task.id;
    });
    const both = boards.map((ws, i) =>
      snapshot(ws, [waitingRow(ids[i] as string, titles[i] as string)]),
    );
    const escalations = new WaitingUnfiledEscalations({ store, agingMs: WINDOW });
    escalations.onTick(both, START);
    escalations.onTick(both, START + WINDOW);
    expect(escalations.filedCount()).toBe(2);

    // The first board's ask gets filed, so its finding is gone; the second
    // board's is untouched.
    const onlySecond = [snapshot(boards[0] as string, []), both[1] as StallSnapshot];
    escalations.onTick(onlySecond, START + WINDOW + MIN);

    expect(escalations.filedCount()).toBe(1);
    const cleared = store
      .listReviewItems(ids[0] as string)
      .find((i) => i.createdBy === STALL_ESCALATION_ACTOR.name);
    expect(reviewWithdrawn(cleared?.review as ReviewPayload)).toBe(true);
    const standing = store
      .listReviewItems(ids[1] as string)
      .find((i) => i.createdBy === STALL_ESCALATION_ACTOR.name);
    expect(reviewWithdrawn(standing?.review as ReviewPayload)).toBe(false);
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

  /**
   * The frame fans boards in on purpose — one wake for one fact — so the only
   * thing that can make it readable is each row saying which board it is on.
   *
   * Measured 2026-09-17: a frame tagged with one board named three rows from
   * three boards, and the peer that got it could tell only by recognising an
   * id. This drives two boards through ONE tick and asserts every row is
   * attributable: `row.workspaceId ?? frame.workspaceId` has to be the board
   * that actually holds it.
   *
   * The control rides along: the frame still carries BOTH rows in ONE send,
   * so a fix that split the wake per board — spending a second turn — would
   * fail here rather than pass quietly.
   */
  it('names each row’s own board when one frame spans two', () => {
    dir = dir || mkdtempSync(join(tmpdir(), 'wu-escalation-'));
    const store = new TaskStore({ dataDir: dir });
    const boards = ['harborlight-ferry', 'saltmarsh-yard'].map(
      (name) => store.createWorkspace(name, { leadAgentId: LEAD.id }).id,
    );
    const titles = ['Cut the release branch', 'Publish the winter timetable'];
    const ids = boards.map((ws, i) => {
      const res = store.createTask(ws, {
        title: titles[i] as string,
        body: `Agent can ${(titles[i] as string).toLowerCase()} so that the work lands.`,
        assignee: LEAD.name,
        assigneeKind: 'agent',
      });
      if (!res.ok) throw new Error('create failed');
      return res.task.id;
    });
    const snapshots = boards.map((ws, i) =>
      snapshot(ws, [waitingRow(ids[i] as string, titles[i] as string)]),
    );
    const sent: Array<{ agentId: string; frame: StallNudgeFrame }> = [];
    const teamLead: TeamLeadReach = {
      agentId: 'agent-team-lead',
      // Team Lead holds a stream on the SECOND board only, so the wake is
      // delivered somewhere that does not hold the anchor row either.
      boards: () => boards,
      canReach: (ws) => ws === boards[1],
      send: (_ws, agentId, frame) => {
        sent.push({ agentId, frame });
        return 1;
      },
    };
    const escalations = new WaitingUnfiledEscalations({ store, agingMs: WINDOW, teamLead });
    escalations.onTick(snapshots, START);
    escalations.onTick(snapshots, START + WINDOW);

    expect(sent).toHaveLength(1);
    const frame = sent[0]?.frame as StallNudgeFrame;
    const rows = frame.unfiled ?? [];
    // One wake, both boards: the fan-in is the design and must survive.
    expect(rows.map((r) => r.id).sort()).toEqual([...ids].sort());
    // Every row attributable, by the reading an agent has to do.
    const boardOf = (id: string) => store.getTask(id)?.workspaceId;
    for (const row of rows) {
      expect(row.workspaceId ?? frame.workspaceId).toBe(boardOf(row.id) as string);
    }
    // And the two rows really are on different boards, or the assertion above
    // would hold for a frame that never spanned anything.
    expect(new Set(rows.map((r) => r.workspaceId ?? frame.workspaceId)).size).toBe(2);
  });

  /**
   * The frame has to say which RUNG it is, or it reads as an ordinary board
   * wake from a board the reader does not lead — which is also what the
   * dead-board redirect looks like, and that one claims the seat is
   * unreachable. Six carries fired 20-22 September 2026 and cost a turn each.
   *
   * Driven through the real escalation rather than the builder, because the
   * thing that could break is the wiring: the lead is read off each board's
   * snapshot at the tick, and `AgingWait` had no field for it before.
   */
  it('tells Team Lead the window the rows already stood, and each board’s own seat', () => {
    dir = dir || mkdtempSync(join(tmpdir(), 'wu-escalation-'));
    const store = new TaskStore({ dataDir: dir });
    const leads = [LEAD.id, 'agent-harbour-master', undefined];
    const names = ['harborlight-ferry', 'saltmarsh-yard', 'riverbend-locks'];
    const titles = ['Cut the release branch', 'Publish the winter timetable', 'Stage the locks'];
    const boards = names.map(
      (name, i) =>
        store.createWorkspace(name, leads[i] === undefined ? {} : { leadAgentId: leads[i] }).id,
    );
    const ids = boards.map((ws, i) => {
      const res = store.createTask(ws, {
        title: titles[i] as string,
        body: `Agent can ${(titles[i] as string).toLowerCase()} so that the work lands.`,
        assignee: LEAD.name,
        assigneeKind: 'agent',
      });
      if (!res.ok) throw new Error('create failed');
      return res.task.id;
    });
    const snapshots = boards.map((ws, i) => ({
      ...snapshot(ws, [waitingRow(ids[i] as string, titles[i] as string)]),
      ...(leads[i] === undefined ? { leadAgentId: undefined } : { leadAgentId: leads[i] }),
    }));
    const sent: Array<{ agentId: string; frame: StallNudgeFrame }> = [];
    const teamLead: TeamLeadReach = {
      agentId: 'agent-team-lead',
      boards: () => boards,
      canReach: () => true,
      send: (_ws, agentId, frame) => {
        sent.push({ agentId, frame });
        return 1;
      },
    };
    const escalations = new WaitingUnfiledEscalations({ store, agingMs: WINDOW, teamLead });
    escalations.onTick(snapshots, START);
    escalations.onTick(snapshots, START + WINDOW);

    expect(sent).toHaveLength(1);
    const carry = sent[0]?.frame.unfiledCarry;
    // The window the frame states is the window the escalation actually ran,
    // which is the same number the board's own item states.
    expect(carry?.agedAtLeastMs).toBe(WINDOW);
    // Each board once, each with the seat on IT — not the anchor's.
    expect(carry?.boards).toEqual([
      { workspaceId: boards[0] as string, leadAgentId: LEAD.id },
      { workspaceId: boards[1] as string, leadAgentId: 'agent-harbour-master' },
      // The control for the seat: a board with an empty one is still named,
      // and carries no lead rather than inheriting a neighbour's.
      { workspaceId: boards[2] as string },
    ]);
    // This frame is the carry, never the dead-board redirect.
    expect(sent[0]?.frame.escalatedFrom).toBeUndefined();
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
    // The item is not deleted, it is withdrawn: still on the ticket, off the
    // reader's queue.
    const ours = store
      .listReviewItems(ids[0] as string)
      .find((i) => i.createdBy === STALL_ESCALATION_ACTOR.name);
    expect(ours).toBeDefined();
    expect(reviewWithdrawn(ours?.review as ReviewPayload)).toBe(true);
  });

  it('an anchor task that closes does not retire the waits the item named', () => {
    // The item has to hang on SOME ticket, and the one it picked can be
    // finished while the others are still waiting. Archiving it takes the
    // item off the reader's queue without anybody having read the list, so
    // the finding has to come back on a ticket that is still open.
    const { store, ws, ids } = boardWith(['Cut the release branch', 'Draft the rollout note']);
    const escalations = new WaitingUnfiledEscalations({ store, agingMs: WINDOW });
    const rows = [
      waitingRow(ids[0] as string, 'Cut the release branch'),
      waitingRow(ids[1] as string, 'Draft the rollout note'),
    ];
    escalations.onTick([snapshot(ws, rows)], START);
    escalations.onTick([snapshot(ws, rows)], START + WINDOW);
    const first = boardFiledItems(store, [ws]);
    expect(first).toHaveLength(1);
    const anchor = first[0]?.taskId as string;

    const archived = store.archiveTask(anchor, {
      actor: { id: LEAD.id, name: LEAD.name, kind: 'agent' },
    });
    expect(archived.ok).toBe(true);

    // The still-open task is still waiting, so it is still a finding.
    const stillDue = rows.filter((r) => r.id !== anchor);
    escalations.onTick([snapshot(ws, stillDue)], START + WINDOW + MIN);
    const refiled = boardFiledItems(store, [ws]).filter((i) => i.taskId !== anchor);
    expect(refiled).toHaveLength(1);
    expect(refiled[0]?.detail).toContain(stillDue[0]?.id as string);
  });
});
