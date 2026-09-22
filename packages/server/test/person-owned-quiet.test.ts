/**
 * A row the BOARD says a person owns, with nothing filed, is in NO stall
 * output.
 *
 * It used to be a finding. `keep-moving.ts` bucketed it
 * `blocked-on-owner-unfiled`, the gate pushed it onto `unfiled`, that list
 * counted toward the board's FAIL verdict, and the unfiled escalation named
 * it on a review item on the owner's own queue. The lead's wake already
 * dropped it (`withoutPersonBlocked`), so the only surfaces left were a FAIL
 * nobody could clear and an item asking a person to file a question to
 * themselves. One such row reached Bryan on three items in five days.
 *
 * So the finding is retired, not re-addressed: no agent and no person has an
 * act to perform on it. The row is still classified, still shown on the
 * board, and still held by the ready gate as `awaiting-person`; the gate
 * keeps it as a RECORD on `awaitingPerson`, which counts toward no verdict
 * and enters no frame.
 *
 * Four surfaces, each with the agent-declared bucket as its control — without
 * the control every case here would pass against a build that had simply
 * stopped reporting anything.
 *
 * Fixtures are synthetic — invented boards and titles. The repo is public.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keepMovingVerdictFor } from '../src/keep-moving-verdict.ts';
import type { TaskRow } from '../src/keep-moving.ts';
import { STALL_ESCALATION_ACTOR } from '../src/stall-escalation.ts';
import { OWNER_UNFILED_BUCKET, evaluateStalls } from '../src/stall-gate.ts';
import { StallNudger, type StallSnapshot } from '../src/stall-nudge.ts';
import { TaskStore } from '../src/tasks.ts';
import { WaitingUnfiledEscalations } from '../src/waiting-unfiled-escalation.ts';
import { WAITING_UNFILED_BUCKET } from '../src/waiting-unfiled.ts';

const MIN = 60_000;
const WINDOW = 30 * MIN;
const NOW = 5_000 * MIN;
const START = 10_000_000;

const bands = { dispatchable: new Set(['g-ranked']), ownerBand: new Set<string>() };

/** A ranked row, quiet for an hour, in whatever ownership the case needs. */
function task(over: Partial<TaskRow> = {}): TaskRow {
  return {
    id: 't-harbor',
    title: 'Send the Harborlight note',
    status: 'todo',
    goal: 'g-ranked',
    createdAt: NOW - 400 * MIN,
    transitions: [{ ts: NOW - 400 * MIN, to: 'todo' }],
    ...over,
  };
}

/** The gate over one board's rows, with nothing filed for any of them. */
const gate = (tasks: readonly TaskRow[]) =>
  evaluateStalls({ tasks, events: [], reviewItems: [], bands, now: NOW, quietMs: 20 * MIN });

describe('the gate', () => {
  it('keeps a person-owned row off `unfiled` and records it instead', () => {
    const verdict = gate([task({ ownerKind: 'person' })]);

    expect(verdict.unfiled).toHaveLength(0);
    expect((verdict.awaitingPerson ?? []).map((r) => r.id)).toEqual(['t-harbor']);
    expect(verdict.awaitingPerson?.[0]?.bucket).toBe(OWNER_UNFILED_BUCKET);
  });

  it('CONTROL: an agent-declared wait with nothing filed is still `unfiled`', () => {
    // Same board, same silence, same absence of a filed item — and a row an
    // agent can act on. The gate reads the note clock for this one.
    const rows = [task({ id: 't-riverbend', title: 'Rank the Riverbend results' })];
    const verdict = evaluateStalls({
      tasks: rows,
      events: [],
      reviewItems: [],
      bands,
      now: NOW,
      quietMs: 20 * MIN,
      noteClocks: new Map([['t-riverbend', { newestPlainAt: 0, askedAt: NOW - 90 * MIN }]]),
    });

    expect(verdict.unfiled.map((r) => r.bucket)).toEqual([WAITING_UNFILED_BUCKET]);
    expect(verdict.awaitingPerson ?? []).toHaveLength(0);
  });
});

describe('the keep-moving verdict', () => {
  const snapshot = (over: Partial<StallSnapshot> = {}): StallSnapshot => ({
    workspaceId: 'w-harbor',
    leadAgentId: 'agent-lead',
    retired: false,
    stalled: [],
    unfiled: [],
    considered: 1,
    undetermined: [],
    ...over,
  });

  const row = (bucket: string) => ({
    id: 't-harbor',
    title: 'Send the Harborlight note',
    bucket,
    quietMs: 60 * MIN,
  });

  it('PASSES a board whose only row is one a person owns', () => {
    const verdict = keepMovingVerdictFor(
      snapshot({ awaitingPerson: [row(OWNER_UNFILED_BUCKET)] }),
      NOW,
      { heldOverMs: 20 * MIN, escalated: 0 },
    );

    expect(verdict.verdict).toBe('PASS');
    expect(verdict.unfiled).toHaveLength(0);
    // Recorded, so the row is still traceable in a week of verdicts.
    expect(verdict.awaitingPerson).toEqual(['t-harbor']);
  });

  it('CONTROL: an agent-declared unfiled wait still FAILS the board', () => {
    const verdict = keepMovingVerdictFor(
      snapshot({ unfiled: [row(WAITING_UNFILED_BUCKET)] }),
      NOW,
      {
        heldOverMs: 20 * MIN,
        escalated: 0,
      },
    );

    expect(verdict.verdict).toBe('FAIL');
    expect(verdict.unfiled).toEqual(['t-harbor']);
  });
});

describe('the stall wake', () => {
  function nudgerHarness(board: StallSnapshot) {
    const sent: Array<{ frame: { unfiled?: ReadonlyArray<{ id: string }> } }> = [];
    const nudger = new StallNudger({
      movedWithinMs: 0,
      now: () => NOW,
      snapshot: () => [board],
      canReach: () => true,
      attachedAgents: () => ['agent-lead'],
      send: (_workspaceId, _agentId, frame) => {
        sent.push({ frame });
        return 1;
      },
      sendToFiler: () => 1,
      report: () => {},
    });
    return { sent, nudger };
  }

  const board = (over: Partial<StallSnapshot>): StallSnapshot => ({
    workspaceId: 'w-harbor',
    leadAgentId: 'agent-lead',
    retired: false,
    stalled: [],
    unfiled: [],
    considered: 1,
    undetermined: [],
    ...over,
  });

  const row = (bucket: string) => ({
    id: 't-harbor',
    title: 'Send the Harborlight note',
    bucket,
    quietMs: 60 * MIN,
  });

  it('sends no frame at all for a board whose only row a person owns', () => {
    const { sent, nudger } = nudgerHarness(board({ awaitingPerson: [row(OWNER_UNFILED_BUCKET)] }));
    nudger.tick();

    expect(sent).toHaveLength(0);
  });

  it('CONTROL: the agent-declared bucket still wakes the lead', () => {
    const { sent, nudger } = nudgerHarness(board({ unfiled: [row(WAITING_UNFILED_BUCKET)] }));
    nudger.tick();

    expect(sent).toHaveLength(1);
    expect(sent[0]?.frame.unfiled?.map((r) => r.id)).toEqual(['t-harbor']);
  });
});

describe('the unfiled escalation', () => {
  let dir = '';
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  function boardWith(title: string) {
    dir = dir || mkdtempSync(join(tmpdir(), 'person-owned-quiet-'));
    const store = new TaskStore({ dataDir: dir });
    const ws = store.createWorkspace('harborlight-ferry', { leadAgentId: 'agent-lead' }).id;
    const res = store.createTask(ws, {
      title,
      body: `Bryan can ${title.toLowerCase()} so that the ferry sails.`,
      assignee: 'Cartographer',
      assigneeKind: 'agent',
    });
    if (!res.ok) throw new Error('create failed');
    return { store, ws, id: res.task.id };
  }

  const snapshot = (ws: string, id: string, bucket: string): StallSnapshot => ({
    workspaceId: ws,
    leadAgentId: 'agent-lead',
    retired: false,
    stalled: [],
    unfiled: [{ id, title: 'Send the Harborlight note', bucket, quietMs: 60 * MIN }],
    considered: 1,
    undetermined: [],
  });

  function serverItems(store: TaskStore, ws: string) {
    return store
      .listTasks(ws)
      .flatMap((t) => store.listReviewItems(t.id))
      .filter((i) => i.createdBy === STALL_ESCALATION_ACTOR.name);
  }

  it('files nothing for a person-owned row, however it reaches the list', () => {
    // Fed with the row still ON `unfiled`, which the gate no longer does. The
    // escalation is the last gate before a person's queue, so it must refuse
    // the bucket itself rather than rely on the caller.
    const { store, ws, id } = boardWith('Send the Harborlight note');
    const escalations = new WaitingUnfiledEscalations({ store, agingMs: WINDOW });
    const rows = [snapshot(ws, id, OWNER_UNFILED_BUCKET)];

    escalations.onTick(rows, START);
    escalations.onTick(rows, START + WINDOW);
    escalations.onTick(rows, START + 4 * WINDOW);

    expect(escalations.filedCount()).toBe(0);
    expect(serverItems(store, ws)).toHaveLength(0);
  });

  it('CONTROL: the agent-declared bucket still files at the second window', () => {
    const { store, ws, id } = boardWith('Send the Harborlight note');
    const escalations = new WaitingUnfiledEscalations({ store, agingMs: WINDOW });
    const rows = [snapshot(ws, id, WAITING_UNFILED_BUCKET)];

    escalations.onTick(rows, START);
    escalations.onTick(rows, START + WINDOW);

    expect(escalations.filedCount()).toBe(1);
    expect(serverItems(store, ws)).toHaveLength(1);
  });
});
