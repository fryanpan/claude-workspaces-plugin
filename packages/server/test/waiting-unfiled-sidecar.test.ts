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
