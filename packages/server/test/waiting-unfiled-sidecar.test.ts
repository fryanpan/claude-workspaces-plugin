import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
/**
 * What the fleet-wide unfiled-wait escalation remembers across a restart.
 *
 * The property every case here is about: this file fails OPEN. A sidecar that
 * is old, truncated or the wrong shape must leave a row with its wakes
 * UNSPENT, never with them already spent — a finding that stops being reported
 * because a field was missing would look exactly like the fix working.
 *
 * Two levels, because they can disagree. The functions are driven directly;
 * then the real `WaitingUnfiledEscalations` is pointed at a file written by
 * hand, which is what a server meeting yesterday's sidecar actually does.
 *
 * Fixtures are synthetic — invented boards and titles. The repo is public.
 */
import { STALL_ESCALATION_ACTOR, type TeamLeadReach } from '../src/stall-escalation.ts';
import type { StalledRow } from '../src/stall-gate.ts';
import type { StallNudgeFrame, StallSnapshot } from '../src/stall-nudge.ts';
import { TaskStore } from '../src/tasks.ts';
import { FLEET_TELL_CAP, WaitingUnfiledEscalations } from '../src/waiting-unfiled-escalation.ts';
import {
  type Sidecar,
  WAITING_UNFILED_FILENAME,
  loadSidecar,
  saveSidecar,
  serializeSidecar,
  sidecarPath,
} from '../src/waiting-unfiled-sidecar.ts';
import { WAITING_UNFILED_BUCKET } from '../src/waiting-unfiled.ts';

const MIN = 60_000;
const WINDOW = 30 * MIN;
const START = 10_000_000;
const LEAD = { id: 'agent-riverbend', name: 'Riverbend', kind: 'agent' as const };

describe('the unfiled-wait sidecar', () => {
  let dir = '';
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = '';
  });
  const fresh = (): string => {
    dir = mkdtempSync(join(tmpdir(), 'wu-sidecar-'));
    return dir;
  };

  it('round-trips a row’s spent wakes', () => {
    const path = sidecarPath(fresh());
    const sidecar: Sidecar = {
      seen: {
        'w-salt|t-tide': { workspaceId: 'w-salt', taskId: 't-tide', firstSeen: START, tells: 2 },
      },
      teamLeadToldAt: START,
    };
    const persisted = saveSidecar(path, sidecar, '');
    expect(persisted).toBe(serializeSidecar(sidecar));
    const back = loadSidecar(path);
    expect(back.sidecar.seen['w-salt|t-tide']?.tells).toBe(2);
    expect(back.sidecar.teamLeadToldAt).toBe(START);
    // And what it reports as already on disk lets the caller skip a rewrite.
    expect(saveSidecar(path, back.sidecar, back.persisted)).toBe(back.persisted);
  });

  it('reads a file written before the count existed as NO wakes spent', () => {
    const path = sidecarPath(fresh());
    // Exactly the shape the server wrote yesterday: no `tells` anywhere.
    writeFileSync(
      path,
      `${JSON.stringify({
        seen: { 'w-salt|t-tide': { workspaceId: 'w-salt', taskId: 't-tide', firstSeen: START } },
      })}\n`,
    );
    const { sidecar } = loadSidecar(path);
    expect(sidecar.seen['w-salt|t-tide']?.firstSeen).toBe(START);
    expect(sidecar.seen['w-salt|t-tide']?.tells).toBeUndefined();
  });

  it('discards a file it cannot read, rather than trusting half of one', () => {
    const path = sidecarPath(fresh());
    writeFileSync(path, '{"seen": {"w-salt|t-tide": {"firstSee');
    const { sidecar, persisted } = loadSidecar(path);
    expect(sidecar.seen).toEqual({});
    // Empty rather than the corrupt text: the next save must write over it.
    expect(persisted).toBe('');
  });

  it('a file whose `seen` is the wrong shape is discarded too', () => {
    const path = sidecarPath(fresh());
    writeFileSync(path, `${JSON.stringify({ seen: 'not a record', teamLeadToldAt: START })}\n`);
    const { sidecar } = loadSidecar(path);
    expect(sidecar.seen).toEqual({});
    expect(sidecar.teamLeadToldAt).toBeUndefined();
  });

  it('a missing file is not an error', () => {
    expect(loadSidecar(sidecarPath(fresh())).sidecar.seen).toEqual({});
    expect(loadSidecar(null).sidecar.seen).toEqual({});
  });
});

describe('a server that restarts over its own sidecar', () => {
  let dir = '';
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  function board(): { store: TaskStore; ws: string; id: string; dataDir: string } {
    dir = mkdtempSync(join(tmpdir(), 'wu-restart-'));
    const store = new TaskStore({ dataDir: dir });
    const ws = store.createWorkspace('harborlight-ferry', { leadAgentId: LEAD.id }).id;
    const res = store.createTask(ws, {
      title: 'Rebuild the timetable',
      body: 'Agent can rebuild the timetable so that the ferry sails on time.',
      assignee: LEAD.name,
      assigneeKind: 'agent',
    });
    if (!res.ok) throw new Error('could not create the task');
    return { store, ws, id: res.task.id, dataDir: dir };
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

  function teamLead(ws: string): { reach: TeamLeadReach; sent: StallNudgeFrame[] } {
    const sent: StallNudgeFrame[] = [];
    return {
      sent,
      reach: {
        agentId: 'agent-team-lead',
        boards: () => [ws],
        canReach: () => true,
        send: (_ws, _agentId, frame) => {
          sent.push(frame);
          return 1;
        },
      },
    };
  }

  it('does not re-gift a row the wakes it has already spent', () => {
    const { store, ws, id, dataDir } = board();
    const rows: StalledRow[] = [
      { id, title: 'Rebuild the timetable', bucket: WAITING_UNFILED_BUCKET, quietMs: 45 * MIN },
    ];
    const first = teamLead(ws);
    const before = new WaitingUnfiledEscalations({
      store,
      dataDir,
      agingMs: WINDOW,
      teamLead: first.reach,
    });
    for (let w = 0; w <= 8; w++) before.onTick([snapshot(ws, rows)], START + w * WINDOW);
    expect(first.sent).toHaveLength(FLEET_TELL_CAP);
    // The count reached the disk, which is what the next process reads.
    const onDisk = JSON.parse(readFileSync(join(dataDir, WAITING_UNFILED_FILENAME), 'utf8')) as {
      seen: Record<string, { tells?: number }>;
    };
    expect(onDisk.seen[`${ws}|${id}`]?.tells).toBe(FLEET_TELL_CAP);

    // A new process over the same data directory: no free extra wakes.
    const after = teamLead(ws);
    const restarted = new WaitingUnfiledEscalations({
      store,
      dataDir,
      agingMs: WINDOW,
      teamLead: after.reach,
    });
    for (let w = 9; w <= 20; w++) restarted.onTick([snapshot(ws, rows)], START + w * WINDOW);
    expect(after.sent).toHaveLength(0);
  });

  it('a server meeting a pre-cap sidecar still escalates, and records the wake', () => {
    const { store, ws, id, dataDir } = board();
    // Yesterday's file: the row has been aging a window already, and the
    // field does not exist.
    writeFileSync(
      join(dataDir, WAITING_UNFILED_FILENAME),
      `${JSON.stringify({
        seen: { [`${ws}|${id}`]: { workspaceId: ws, taskId: id, firstSeen: START } },
      })}\n`,
    );
    const { reach, sent } = teamLead(ws);
    const escalations = new WaitingUnfiledEscalations({
      store,
      dataDir,
      agingMs: WINDOW,
      teamLead: reach,
    });
    escalations.onTick(
      [
        snapshot(ws, [
          { id, title: 'Rebuild the timetable', bucket: WAITING_UNFILED_BUCKET, quietMs: 45 * MIN },
        ]),
      ],
      START + WINDOW,
    );
    // It escalated — the missing field did not read as "already silenced" —
    // and the wake was counted from one, not from the cap.
    expect(sent).toHaveLength(1);
    expect(escalations.aging()[0]?.tells).toBe(1);
    expect(escalations.aging()[0]?.firstSeen).toBe(START);
    // Nothing reached the owner: the row is well inside the cap.
    const items = store
      .listReviewItems(id)
      .filter((i) => i.createdBy === STALL_ESCALATION_ACTOR.name);
    expect(items).toHaveLength(0);
  });
});

/**
 * A sidecar written while the item was ONE for the whole fleet.
 *
 * The field changed shape on 2026-09-22 — a single `filed` object became
 * `filedByBoard`, keyed by workspace — and prod holds a live file in the old
 * shape. The failure this guards is the exact symptom the change removes: a
 * restarted server that cannot see the standing item files a SECOND one
 * beside it, on the owner's queue, naming the same rows.
 *
 * Both cases build the legacy file from an item the escalation really filed,
 * rather than from an invented id, so what is read back is the anchor a
 * revise has to find.
 */
describe('a server that restarts over a sidecar from before the item went per board', () => {
  let dir = '';
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  const row = (id: string, title: string): StalledRow => ({
    id,
    title,
    bucket: WAITING_UNFILED_BUCKET,
    quietMs: 45 * MIN,
  });

  const snapshot = (ws: string, rows: readonly StalledRow[]): StallSnapshot => ({
    workspaceId: ws,
    leadAgentId: LEAD.id,
    retired: false,
    stalled: [],
    unfiled: rows,
    considered: rows.length,
    undetermined: [],
  });

  function task(store: TaskStore, ws: string, title: string): string {
    const res = store.createTask(ws, {
      title,
      body: `Agent can ${title.toLowerCase()} so that the ferry sails on time.`,
      assignee: LEAD.name,
      assigneeKind: 'agent',
    });
    if (!res.ok) throw new Error('could not create the task');
    return res.task.id;
  }

  const stallItems = (store: TaskStore, taskId: string) =>
    store
      .listReviewItems(taskId)
      .filter((i) => i.createdBy === STALL_ESCALATION_ACTOR.name)
      .map((i) => ({ id: i.id, detail: (i.review as { detail?: string }).detail ?? '' }));

  /** Rewrite the sidecar on disk into the shape the old code wrote: one
   *  `filed` object, no `filedByBoard`. `extraKeys` are rows the old item
   *  also named, which is how a fleet-wide item looked from other boards. */
  function rewriteAsLegacy(dataDir: string, extraKeys: readonly string[] = []): string {
    const path = join(dataDir, WAITING_UNFILED_FILENAME);
    const file = JSON.parse(readFileSync(path, 'utf8')) as {
      filedByBoard?: Record<string, { itemId: string; keys: string[] }>;
      [k: string]: unknown;
    };
    const entries = Object.values(file.filedByBoard ?? {});
    const only = entries[0];
    if (entries.length !== 1 || !only) throw new Error('expected exactly one filed board');
    const legacy = { ...only, keys: [...only.keys, ...extraKeys].sort() };
    file.filed = legacy;
    file.filedByBoard = undefined;
    writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`);
    return only.itemId;
  }

  it('revises the item already standing, rather than filing a second beside it', () => {
    dir = mkdtempSync(join(tmpdir(), 'wu-legacy-one-'));
    const store = new TaskStore({ dataDir: dir });
    const ws = store.createWorkspace('harborlight-ferry', { leadAgentId: LEAD.id }).id;
    const first = task(store, ws, 'Rebuild the timetable');
    const second = task(store, ws, 'Publish the tide table');

    // One item on this board, filed by the code that writes the new shape.
    const before = new WaitingUnfiledEscalations({ store, dataDir: dir, agingMs: WINDOW });
    const one = [snapshot(ws, [row(first, 'Rebuild the timetable')])];
    before.onTick(one, START);
    before.onTick(one, START + WINDOW);
    expect(before.filedCount()).toBe(1);
    const itemId = rewriteAsLegacy(dir);

    // A new process reads that file and meets a board whose row set has
    // grown, so it must REVISE — the path that needs the anchor.
    const after = new WaitingUnfiledEscalations({ store, dataDir: dir, agingMs: WINDOW });
    expect(after.filedCount()).toBe(1);
    const two = [
      snapshot(ws, [row(first, 'Rebuild the timetable'), row(second, 'Publish the tide table')]),
    ];
    after.onTick(two, START + 2 * WINDOW);
    after.onTick(two, START + 3 * WINDOW);

    // The same item, revised: one on the anchor task, none on the other.
    const standing = stallItems(store, first);
    expect(standing).toHaveLength(1);
    expect(standing[0]?.id).toBe(itemId);
    expect(stallItems(store, second)).toHaveLength(0);
    expect(standing[0]?.detail).toContain(second);
  });

  it('CONTROL: with the migration skipped, the same file files a second item', () => {
    // The control the case above needs: without it, a build that had stopped
    // filing anything at all would read as a pass. Same legacy file, but
    // `filedByBoard` is what the loader would have found had it ignored the
    // old field — so the anchor is invisible and the next due tick files
    // again. This is the duplicate on the owner's queue, reproduced.
    dir = mkdtempSync(join(tmpdir(), 'wu-legacy-control-'));
    const store = new TaskStore({ dataDir: dir });
    const ws = store.createWorkspace('harborlight-ferry', { leadAgentId: LEAD.id }).id;
    const only = task(store, ws, 'Rebuild the timetable');

    const before = new WaitingUnfiledEscalations({ store, dataDir: dir, agingMs: WINDOW });
    const rows = [snapshot(ws, [row(only, 'Rebuild the timetable')])];
    before.onTick(rows, START);
    before.onTick(rows, START + WINDOW);
    const itemId = rewriteAsLegacy(dir);

    // Drop the legacy field as well, which is what "no migration" means on
    // disk. Everything else about the file is unchanged.
    const path = join(dir, WAITING_UNFILED_FILENAME);
    const file = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    file.filed = undefined;
    writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`);

    const after = new WaitingUnfiledEscalations({ store, dataDir: dir, agingMs: WINDOW });
    expect(after.filedCount()).toBe(0);
    after.onTick(rows, START + 2 * WINDOW);
    const items = stallItems(store, only);
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.id)).toContain(itemId);
  });

  it('a legacy item spanning two boards becomes its own board’s, and the other files its own', () => {
    dir = mkdtempSync(join(tmpdir(), 'wu-legacy-two-'));
    const store = new TaskStore({ dataDir: dir });
    const ferry = store.createWorkspace('harborlight-ferry', { leadAgentId: LEAD.id }).id;
    const mill = store.createWorkspace('riverbend-mill', { leadAgentId: LEAD.id }).id;
    const ferryTask = task(store, ferry, 'Rebuild the timetable');
    const millTask = task(store, mill, 'Rank the mill results');

    // The old shape: one item, anchored on the ferry board, naming the mill
    // board's row too. Built by filing on the ferry alone and then adding the
    // mill's key by hand, which is what the fleet-wide revise used to do.
    const before = new WaitingUnfiledEscalations({ store, dataDir: dir, agingMs: WINDOW });
    const ferryOnly = [snapshot(ferry, [row(ferryTask, 'Rebuild the timetable')])];
    before.onTick(ferryOnly, START);
    before.onTick(ferryOnly, START + WINDOW);
    const itemId = rewriteAsLegacy(dir, [`${mill}|${millTask}`]);

    // Both boards due on the restart's first tick.
    const after = new WaitingUnfiledEscalations({ store, dataDir: dir, agingMs: WINDOW });
    const both = [
      snapshot(ferry, [row(ferryTask, 'Rebuild the timetable')]),
      snapshot(mill, [row(millTask, 'Rank the mill results')]),
    ];
    after.onTick(both, START + 2 * WINDOW);
    after.onTick(both, START + 3 * WINDOW);

    expect(after.filedCount()).toBe(2);
    const ferryItems = stallItems(store, ferryTask);
    const millItems = stallItems(store, millTask);
    // The ferry keeps the item it already had — no duplicate on the anchor.
    expect(ferryItems).toHaveLength(1);
    expect(ferryItems[0]?.id).toBe(itemId);
    // Revised DOWN to its own board: the mill's row is gone from its words.
    expect(ferryItems[0]?.detail).not.toContain(millTask);
    // And the mill has one of its own, naming only its row.
    expect(millItems).toHaveLength(1);
    expect(millItems[0]?.id).not.toBe(itemId);
    expect(millItems[0]?.detail).toContain(millTask);
    expect(millItems[0]?.detail).not.toContain(ferryTask);
  });
});
