/**
 * Every row a stall frame names has to be attributable to a board that
 * actually holds it — so a lead reading one can act on it without first
 * recognising the task ids.
 *
 * ── What went wrong ─────────────────────────────────────────────────────
 *
 * Measured 2026-09-17: one `workspace.stalled` frame, tagged with a single
 * board, named three rows belonging to three different boards. The peer that
 * received it could only tell which row was its own because it recognised the
 * id, which is luck rather than a rule.
 *
 * The composition is the fleet-wide unfiled escalation
 * (`waiting-unfiled-escalation.ts`). `onTick` walks EVERY board's snapshot
 * into one `present` map — deliberately: a wake is a session's whole turn, so
 * the fleet's unfiled asks are reported once rather than once per board. But
 * `tellTeamLead` then dropped each row's board on the floor and tagged the
 * whole frame with `due[0]`'s, which made rows from every other board read as
 * that board's.
 *
 * ── What this file drives ───────────────────────────────────────────────
 *
 * Two real boards on one real server, through the real tick
 * (`handle.nudgeStalls()`), with Team Lead attached to only one of them. Each
 * board gets one row whose closing note says it is waiting on a person with
 * nothing filed — the shape that ages into the fleet escalation. Every frame
 * that reaches any of the three streams is then checked against the store:
 * the board a frame ATTRIBUTES a row to must be the board that holds it.
 *
 * The attribution is `row.workspaceId ?? frame.workspaceId`, because that is
 * the reading an agent has to do. A frame that spans boards says so per row;
 * one that does not carry per-row ids is claiming every row for its own tag.
 *
 * The control is in the same run and needs no second fixture: the two
 * per-board wakes are themselves single-board frames whose rows must resolve
 * to their own tag. A fix that simply stopped the fleet frame being sent
 * would be caught by `it('still escalates …')` below, which asserts the fleet
 * frame arrives and names BOTH rows.
 *
 * All fixtures are synthetic — invented names on made-up boards. The repo is
 * public.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { STALL_EVENT } from '../src/stall-nudge.ts';
import { type Frame, PERSON, QUIET_MS, listenFrames } from './doc-activity-stall-harness.ts';
import { waitFor } from './wait-for.ts';
import { seedBoard } from './workspace-seed.ts';

const TEAM_LEAD = 'agent-conductor';
/** One lead per board, so each board's ordinary wake has its own addressee
 *  and Team Lead is never picked as a stand-in for it. */
const LEAD_A = { id: 'agent-harborlight', name: 'Harborlight', kind: 'agent' as const };
const LEAD_B = { id: 'agent-saltmarsh', name: 'Saltmarsh', kind: 'agent' as const };

/** The sentence the unfiled detector has to read as an ask. The person's name
 *  comes off the board's own transitions, never from this file. */
const WAIT_TEXT = (who: string) =>
  `Branch is cut and the smoke run is green. Waiting on ${who} to pick the release window.`;

type Named = { id?: string; workspaceId?: string };

/** Every row a frame names, in the order a reader meets them, each paired
 *  with the board the frame attributes it to. */
function attributions(frame: Frame): Array<{ id: string; claimedBoard: string }> {
  const data = (frame.data ?? {}) as Record<string, unknown>;
  const frameBoard = typeof data.workspaceId === 'string' ? data.workspaceId : '';
  const out: Array<{ id: string; claimedBoard: string }> = [];
  for (const key of ['rows', 'unfiled', 'checkIn'] as const) {
    for (const row of (data[key] ?? []) as Named[]) {
      if (typeof row.id !== 'string') continue;
      out.push({ id: row.id, claimedBoard: row.workspaceId ?? frameBoard });
    }
  }
  return out;
}

describe('a stall frame attributes every row it names to the board that holds it', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  const streams: Array<{ frames: Frame[]; stop: () => Promise<void> }> = [];

  const post = (path: string, body: unknown): Promise<Response> =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const jj = async <T>(res: Response): Promise<T> => {
    expect(res.ok, `${res.status} ${await res.clone().text()}`).toBe(true);
    return res.json() as Promise<T>;
  };

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'stall-attrib-'));
    handle = createServer({
      port: 0,
      dataDir,
      // Doubles as the fleet escalation's aging window
      // (`WaitingUnfiledEscalations.agingMs`), so a row becomes due on the
      // second tick past it rather than half an hour later.
      stallNudgeQuietMs: QUIET_MS,
      keepMovingCadenceMs: 0,
      spawnerAgentId: TEAM_LEAD,
    });
    base = `http://127.0.0.1:${handle.port}`;
    await seedBoard(base);
  });

  afterEach(async () => {
    for (const s of streams.splice(0)) await s.stop();
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  /** A stream held open as `agentId`, whose frames are collected. */
  async function attach(workspaceId: string, agentId: string): Promise<Frame[]> {
    await jj(
      await post(`/workspaces/${workspaceId}/agents`, { agentId, runtime: 'claude-code-local' }),
    );
    const res = await fetch(
      `${base}/workspaces/${workspaceId}/events:stream?agentId=${encodeURIComponent(agentId)}`,
      { headers: { accept: 'text/event-stream' } },
    );
    const s = listenFrames(res);
    streams.push(s);
    return s.frames;
  }

  /**
   * A board carrying one in-progress row whose closing note says its holder is
   * waiting on a person, with nothing filed — the `waiting-unfiled` shape the
   * fleet escalation ages.
   */
  async function boardWithUnfiledWait(
    name: string,
    lead: typeof LEAD_A,
    title: string,
  ): Promise<{ ws: string; taskId: string }> {
    const { workspace } = await jj<{ workspace: { id: string } }>(
      await post('/workspaces', { name, leadAgentId: lead.id }),
    );
    const ws = workspace.id;
    const { task } = await jj<{ task: { id: string } }>(
      await post(`/workspaces/${ws}/tasks`, {
        title,
        body: `Agent can ${title.toLowerCase()} so that the train leaves on time.`,
        assignee: lead.name,
        assigneeKind: 'agent',
        author: lead,
      }),
    );
    // The `todo` step is taken BY THE PERSON, which is also how the board
    // learns who its people are — the detector reads the name off that.
    for (const [to, author] of [
      ['todo', PERSON],
      ['in-progress', lead],
    ] as const) {
      await jj(
        await post(`/workspaces/${ws}/tasks/${task.id}/transition`, {
          to,
          author,
          workspaceId: ws,
        }),
      );
    }
    await jj(
      await post(`/workspaces/${ws}/tasks/${task.id}/notes`, {
        kind: 'turn',
        text: WAIT_TEXT(PERSON.name),
        agent: lead.name,
        at: Date.now(),
      }),
    );
    return { ws, taskId: task.id };
  }

  /**
   * Both boards, both leads listening, and Team Lead attached to the FIRST
   * board only — so the fleet frame is delivered over board A's channel while
   * the rows it carries come from both.
   */
  async function twoBoards(): Promise<{
    a: { ws: string; taskId: string };
    b: { ws: string; taskId: string };
    teamLeadFrames: Frame[];
    leadAFrames: Frame[];
    leadBFrames: Frame[];
  }> {
    const a = await boardWithUnfiledWait('release-train', LEAD_A, 'Cut the release branch');
    const b = await boardWithUnfiledWait('ferry-timetable', LEAD_B, 'Publish the winter timetable');
    const leadAFrames = await attach(a.ws, LEAD_A.id);
    const leadBFrames = await attach(b.ws, LEAD_B.id);
    const teamLeadFrames = await attach(a.ws, TEAM_LEAD);
    return { a, b, teamLeadFrames, leadAFrames, leadBFrames };
  }

  /**
   * Tick until Team Lead has been told. Polled rather than slept: the rows
   * have to out-quiet the stall window and then age a further window before
   * the fleet escalation is due, and both clocks are real.
   */
  const tickUntilFleetFrame = (teamLeadFrames: Frame[]): Promise<unknown> =>
    waitFor(
      () => {
        handle.nudgeStalls();
        return teamLeadFrames.some((f) => f.event === STALL_EVENT);
      },
      { describe: 'Team Lead received a stall frame', timeout: 20_000 },
    );

  it('names no row the frame cannot attribute to the board that holds it', async () => {
    const { a, b, teamLeadFrames, leadAFrames, leadBFrames } = await twoBoards();
    await tickUntilFleetFrame(teamLeadFrames);

    const boardOf = (taskId: string): string | undefined =>
      handle.tasks.getTask(taskId)?.workspaceId;
    const misattributed: string[] = [];
    let named = 0;
    for (const frame of [...teamLeadFrames, ...leadAFrames, ...leadBFrames]) {
      if (frame.event !== STALL_EVENT) continue;
      for (const { id, claimedBoard } of attributions(frame)) {
        named += 1;
        const actual = boardOf(id);
        if (actual !== undefined && actual !== claimedBoard) {
          misattributed.push(`${id} is on ${actual}, frame attributed it to ${claimedBoard}`);
        }
      }
    }
    // The run has to have examined something, or an empty sweep would pass by
    // saying nothing: both rows are named somewhere across the three streams.
    const everyNamed = [...teamLeadFrames, ...leadAFrames, ...leadBFrames]
      .filter((f) => f.event === STALL_EVENT)
      .flatMap((f) => attributions(f).map((r) => r.id));
    expect(everyNamed).toContain(a.taskId);
    expect(everyNamed).toContain(b.taskId);
    expect(named).toBeGreaterThan(0);
    expect(misattributed).toEqual([]);
  }, 60_000);

  it('still escalates the whole fleet in ONE frame, both rows in it', async () => {
    const { a, b, teamLeadFrames } = await twoBoards();
    await tickUntilFleetFrame(teamLeadFrames);

    // The fleet frame is the one carrying no stalled rows and an unfiled list:
    // a per-board wake for this fixture would name one row, not two.
    const fleet = teamLeadFrames
      .filter((f) => f.event === STALL_EVENT)
      .find((f) => attributions(f).length > 1);
    expect(fleet, 'Team Lead was told about the fleet in one frame').toBeDefined();
    const named = attributions(fleet as Frame).map((r) => r.id);
    expect(named).toContain(a.taskId);
    expect(named).toContain(b.taskId);
  }, 60_000);
});
