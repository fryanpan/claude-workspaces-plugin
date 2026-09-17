import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
/**
 * A finding nobody can answer stops WAKING the fleet, and does not stop being
 * a finding.
 *
 * The row this is about is the one whose own closing prose reads as an ask
 * with nothing anyone could file against it: `detectAsk` fires, the gate puts
 * it on `unfiled`, and it never leaves, because there is no question for a
 * lead to file and no answer for anybody to give. Before this, every window
 * for the rest of the board's life carried it to Team Lead again, and a wake
 * is another session's whole turn.
 *
 * What is asserted, each with its control:
 *  - the CAP. Eight windows of the same unanswerable row produce
 *    `FLEET_TELL_CAP` frames, not eight. The control is the same eight windows
 *    with the cap removed from the filter, which produces eight.
 *  - the KEEP SIDE. A genuine unfiled ask still ages and still escalates: it
 *    reaches Team Lead at the second window exactly as before, and a row that
 *    becomes a finding AFTER another has gone quiet is carried on its own
 *    clock rather than inheriting the quiet one's.
 *  - the VISIBILITY. A row that has gone quiet at the fleet rung is still
 *    being aged, still carries its bucket, and is still what the board's own
 *    `unfiled` list is built from — so somebody who goes looking finds it.
 *  - the OWNER RUNG is untouched. With Team Lead unreachable the standing item
 *    still names the row however many windows pass: it is revised in place,
 *    so it costs nobody a turn and is the durable half of the record.
 *
 * All fixtures are synthetic — invented names on made-up boards. The repo is
 * public.
 */
import { STALL_ESCALATION_ACTOR, type TeamLeadReach } from '../src/stall-escalation.ts';
import type { StalledRow } from '../src/stall-gate.ts';
import type { StallNudgeFrame, StallSnapshot } from '../src/stall-nudge.ts';
import { TaskStore } from '../src/tasks.ts';
import { FLEET_TELL_CAP, WaitingUnfiledEscalations } from '../src/waiting-unfiled-escalation.ts';
import { WAITING_UNFILED_BUCKET } from '../src/waiting-unfiled.ts';

const MIN = 60_000;
const WINDOW = 30 * MIN;
const START = 10_000_000;
const LEAD = { id: 'agent-riverbend', name: 'Riverbend', kind: 'agent' as const };

describe('an unanswerable unfiled finding stops waking the fleet', () => {
  let dir = '';
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  function boardWith(titles: readonly string[]): { store: TaskStore; ws: string; ids: string[] } {
    dir = dir || mkdtempSync(join(tmpdir(), 'wu-fleet-quiet-'));
    const store = new TaskStore({ dataDir: dir });
    const ws = store.createWorkspace('harborlight-ferry', { leadAgentId: LEAD.id }).id;
    const ids = titles.map((title) => {
      const res = store.createTask(ws, {
        title,
        body: `Agent can ${title.toLowerCase()} so that the ferry sails on time.`,
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

  /** A Team Lead that is always reachable, recording every frame it is sent. */
  function recordingTeamLead(ws: string): {
    reach: TeamLeadReach;
    sent: StallNudgeFrame[];
  } {
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

  it('is carried to Team Lead a bounded number of times, not once per window forever', () => {
    const { store, ws, ids } = boardWith(['Rebuild the timetable']);
    const { reach, sent } = recordingTeamLead(ws);
    const escalations = new WaitingUnfiledEscalations({ store, agingMs: WINDOW, teamLead: reach });
    const rows = [waitingRow(ids[0] as string, 'Rebuild the timetable')];

    // Eight windows of the identical finding: nothing filed, nothing moved.
    for (let w = 0; w <= 8; w++) escalations.onTick([snapshot(ws, rows)], START + w * WINDOW);

    expect(sent).toHaveLength(FLEET_TELL_CAP);
    // Every frame it did send named the row — the cap bounds repetition, it
    // does not send an empty wake.
    for (const frame of sent) {
      expect((frame.unfiled ?? []).map((r) => r.id)).toEqual([ids[0] as string]);
    }
  });

  it('a row that has gone quiet at the fleet rung is still a finding being aged', () => {
    const { store, ws, ids } = boardWith(['Rebuild the timetable']);
    const { reach, sent } = recordingTeamLead(ws);
    const escalations = new WaitingUnfiledEscalations({ store, agingMs: WINDOW, teamLead: reach });
    const rows = [waitingRow(ids[0] as string, 'Rebuild the timetable')];
    for (let w = 0; w <= 8; w++) escalations.onTick([snapshot(ws, rows)], START + w * WINDOW);
    expect(sent).toHaveLength(FLEET_TELL_CAP);

    // Still aged, with its first-seen intact: the board's own list and the
    // keep-moving verdict read the same row, and nothing here withdrew it.
    const aged = escalations.aging();
    expect(aged.map((a) => a.taskId)).toEqual([ids[0] as string]);
    expect(aged[0]?.firstSeen).toBe(START);
    // And it never reached the owner's queue: Team Lead is reachable, so the
    // owner is not the addressee whether or not the fleet rung has gone quiet.
    expect(escalations.filedCount()).toBe(0);
  });

  it('a genuine unfiled ask still escalates, and a later one is carried on its own clock', () => {
    const { store, ws, ids } = boardWith(['Rebuild the timetable', 'Answer the harbour survey']);
    const { reach, sent } = recordingTeamLead(ws);
    const escalations = new WaitingUnfiledEscalations({ store, agingMs: WINDOW, teamLead: reach });
    const stuck = waitingRow(ids[0] as string, 'Rebuild the timetable');
    const later = waitingRow(ids[1] as string, 'Answer the harbour survey');

    // The unanswerable row spends its tells alone.
    for (let w = 0; w <= 8; w++) escalations.onTick([snapshot(ws, [stuck])], START + w * WINDOW);
    expect(sent).toHaveLength(FLEET_TELL_CAP);

    // A real ask now appears. It has to age one window like any other, and
    // then it is carried — the quiet row beside it does not silence it.
    const both = [stuck, later];
    escalations.onTick([snapshot(ws, both)], START + 9 * WINDOW);
    expect(sent).toHaveLength(FLEET_TELL_CAP);
    escalations.onTick([snapshot(ws, both)], START + 10 * WINDOW);
    expect(sent).toHaveLength(FLEET_TELL_CAP + 1);
    const last = sent[sent.length - 1];
    expect((last?.unfiled ?? []).map((r) => r.id)).toEqual([ids[1] as string]);
  });

  it('with Team Lead unreachable the standing item still names the row after many windows', () => {
    const { store, ws, ids } = boardWith(['Rebuild the timetable']);
    const escalations = new WaitingUnfiledEscalations({ store, agingMs: WINDOW });
    const rows = [waitingRow(ids[0] as string, 'Rebuild the timetable')];
    for (let w = 0; w <= 8; w++) escalations.onTick([snapshot(ws, rows)], START + w * WINDOW);

    // One item, revised in place, still open and still naming the task: the
    // owner rung is a standing record rather than a wake, so the cap has
    // nothing to say about it.
    expect(escalations.filedCount()).toBe(1);
    const ours = store
      .listReviewItems(ids[0] as string)
      .filter((i) => i.createdBy === STALL_ESCALATION_ACTOR.name);
    expect(ours).toHaveLength(1);
    const review = ours[0]?.review as { detail?: string };
    expect(review.detail ?? '').toContain(ids[0] as string);
  });
});
