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
 *    with the cap put out of reach (`fleetTellCap: 99`), which produces eight.
 *  - the KEEP SIDE. A genuine unfiled ask still ages and still escalates: it
 *    reaches Team Lead at the second window exactly as before; a row that
 *    becomes a finding AFTER another has gone quiet is carried on its own
 *    clock rather than inheriting the quiet one's; and a row that stops being
 *    a finding and asks again gets its wakes back.
 *  - the LANDING. A row past the cap is not silenced, it is MOVED: it goes
 *    onto the owner's standing item — a record rather than a wake — while
 *    staying in `aging()` and staying what the board's own `unfiled` list is
 *    built from. Its control is a row still inside the cap, which does not go
 *    there.
 *  - the DELIVERY. A wake nobody received spends no wake. Five windows whose
 *    `send` delivers 0, and a sixth that delivers, still leave the row its
 *    full three chances; a `send` that throws does the same.
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

  /**
   * A Team Lead that is always reachable, recording every frame it is sent.
   *
   * `delivered` is how many sessions the send reached — the server's own
   * return value, which the escalation is supposed to read before counting a
   * wake against a row. Settable so a test can drive the case that matters
   * most: a frame that went nowhere.
   */
  function recordingTeamLead(ws: string): {
    reach: TeamLeadReach;
    sent: StallNudgeFrame[];
    delivered: { n: number; throws: boolean };
  } {
    const sent: StallNudgeFrame[] = [];
    const delivered = { n: 1, throws: false };
    return {
      sent,
      delivered,
      reach: {
        agentId: 'agent-team-lead',
        boards: () => [ws],
        canReach: () => true,
        send: (_ws, _agentId, frame) => {
          if (delivered.throws) throw new Error('the stream went away mid-send');
          sent.push(frame);
          return delivered.n;
        },
      },
    };
  }

  /** Every open review item the server itself wrote, across one board. */
  function ownerItems(store: TaskStore, ws: string) {
    const out: Array<{ taskId: string; detail: string }> = [];
    for (const task of store.listTasks(ws)) {
      for (const item of store.listReviewItems(task.id)) {
        if (item.createdBy !== STALL_ESCALATION_ACTOR.name) continue;
        const review = item.review as { detail?: string };
        out.push({ taskId: task.id, detail: review.detail ?? '' });
      }
    }
    return out;
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

  it('CONTROL: the same eight windows with the cap out of reach produce eight', () => {
    const { store, ws, ids } = boardWith(['Rebuild the timetable']);
    const { reach, sent } = recordingTeamLead(ws);
    const escalations = new WaitingUnfiledEscalations({
      store,
      agingMs: WINDOW,
      teamLead: reach,
      fleetTellCap: 99,
    });
    const rows = [waitingRow(ids[0] as string, 'Rebuild the timetable')];
    for (let w = 0; w <= 8; w++) escalations.onTick([snapshot(ws, rows)], START + w * WINDOW);
    // Eight, not three: the cap is what the case above measures, and nothing
    // else about the ladder changed underneath it.
    expect(sent).toHaveLength(8);
    // And with the cap unreachable the row never lands on the owner's item,
    // which is the other half of what the cap controls.
    expect(escalations.filedCount()).toBe(0);
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
    expect(aged[0]?.tells).toBe(FLEET_TELL_CAP);
    // It stopped waking anybody and did not stop existing: it is on the
    // owner's standing item, which is where it can still be answered.
    expect(escalations.filedCount()).toBe(1);
  });

  it('a row past the cap lands on the owner’s standing item, where it can be answered', () => {
    const { store, ws, ids } = boardWith(['Rebuild the timetable']);
    const { reach, sent } = recordingTeamLead(ws);
    const escalations = new WaitingUnfiledEscalations({ store, agingMs: WINDOW, teamLead: reach });
    const rows = [waitingRow(ids[0] as string, 'Rebuild the timetable')];

    // Control first: inside the cap, Team Lead is the addressee and the
    // owner's queue is untouched — the ladder's own order, unchanged.
    for (let w = 0; w <= FLEET_TELL_CAP - 1; w++)
      escalations.onTick([snapshot(ws, rows)], START + w * WINDOW);
    expect(sent.length).toBeLessThan(FLEET_TELL_CAP);
    expect(ownerItems(store, ws)).toHaveLength(0);

    // The window that spends the last wake also lands the row on the item —
    // waiting another window would leave it with no audience in between.
    escalations.onTick([snapshot(ws, rows)], START + FLEET_TELL_CAP * WINDOW);
    expect(sent).toHaveLength(FLEET_TELL_CAP);
    const filed = ownerItems(store, ws);
    expect(filed).toHaveLength(1);
    expect(filed[0]?.detail).toContain(ids[0] as string);

    // And it is a record, not a wake: four more windows add no frame and no
    // second item.
    for (let w = FLEET_TELL_CAP + 1; w <= FLEET_TELL_CAP + 4; w++)
      escalations.onTick([snapshot(ws, rows)], START + w * WINDOW);
    expect(sent).toHaveLength(FLEET_TELL_CAP);
    expect(ownerItems(store, ws)).toHaveLength(1);
    expect(escalations.filedCount()).toBe(1);
  });

  it('a row that stops being a finding and asks again gets its wakes back', () => {
    const { store, ws, ids } = boardWith(['Rebuild the timetable']);
    const { reach, sent } = recordingTeamLead(ws);
    const escalations = new WaitingUnfiledEscalations({ store, agingMs: WINDOW, teamLead: reach });
    const rows = [waitingRow(ids[0] as string, 'Rebuild the timetable')];
    for (let w = 0; w <= 8; w++) escalations.onTick([snapshot(ws, rows)], START + w * WINDOW);
    expect(sent).toHaveLength(FLEET_TELL_CAP);

    // The agent reported, so the row stops being a finding: the count is
    // dropped with `firstSeen`, exactly as a filed ask would drop it.
    escalations.onTick([snapshot(ws, [])], START + 9 * WINDOW);
    expect(escalations.aging()).toHaveLength(0);

    // THE SAME row asks again. It is a new wait, so it ages one window and is
    // then carried — the cap is not a permanent mark on a task id.
    escalations.onTick([snapshot(ws, rows)], START + 10 * WINDOW);
    expect(sent).toHaveLength(FLEET_TELL_CAP);
    escalations.onTick([snapshot(ws, rows)], START + 11 * WINDOW);
    expect(sent).toHaveLength(FLEET_TELL_CAP + 1);
    expect((sent[sent.length - 1]?.unfiled ?? []).map((r) => r.id)).toEqual([ids[0] as string]);
  });

  it('a wake nobody received spends no wake, and neither does one that throws', () => {
    const { store, ws, ids } = boardWith(['Rebuild the timetable']);
    const { reach, sent, delivered } = recordingTeamLead(ws);
    const escalations = new WaitingUnfiledEscalations({ store, agingMs: WINDOW, teamLead: reach });
    const rows = [waitingRow(ids[0] as string, 'Rebuild the timetable')];

    // Five windows where the send reaches nobody. The frames were built and
    // handed over; none was delivered.
    delivered.n = 0;
    for (let w = 0; w <= 5; w++) escalations.onTick([snapshot(ws, rows)], START + w * WINDOW);
    expect(sent.length).toBeGreaterThan(FLEET_TELL_CAP);
    expect(escalations.aging()[0]?.tells ?? 0).toBe(0);

    // And one where it throws.
    delivered.throws = true;
    escalations.onTick([snapshot(ws, rows)], START + 6 * WINDOW);
    expect(escalations.aging()[0]?.tells ?? 0).toBe(0);
    delivered.throws = false;

    // Team Lead comes back. The row still has its full three chances: an
    // undelivered wake is not a wake, so the cap cannot be spent by an
    // addressee who was never there.
    delivered.n = 1;
    const before = sent.length;
    for (let w = 7; w <= 20; w++) escalations.onTick([snapshot(ws, rows)], START + w * WINDOW);
    expect(sent.length - before).toBe(FLEET_TELL_CAP);
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
