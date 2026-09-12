/**
 * A person moves a row to `todo`, and the lead hears about it in that tick.
 *
 * The spec is Bryan's, on the ticket this branch came from: *"I moved the
 * ticket to Todo after editing and expected immediate pickup since the
 * workspace had capacity."* So the trigger is the deliberate transition, not
 * a quieter clock — the idle window stays the backstop and is unchanged.
 *
 * Every test here runs with the PRODUCTION idle window (fifteen minutes) and
 * asserts against a `nudgeReadyWork()` pass that provably produces nothing
 * under it. That is what makes "immediate" mean anything: the sibling suite
 * `ready-nudge-routes.test.ts` runs with `readyNudgeIdleMs: 0`, where every
 * board is idle the moment it is read, so a wake arriving with no window is
 * invisible to it by construction.
 *
 * The three rules the narrowness is made of, one test each:
 *   1. a person's move fires it, with no window;
 *   2. an agent's identical move fires nothing — otherwise every builder
 *      transition wakes the lead, which is the noise the window exists for;
 *   3. a move that leaves the row HELD fires nothing, whether the hold is an
 *      enforced `after` edge or a goal still in triage.
 * And the one thing it must NOT do: gate on free capacity.
 *
 * All fixtures are synthetic — invented names in the jordan@partner.example
 * register. The repo is public.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { READY_IDLE_EVENT, ReadyWorkNudger } from '../src/ready-nudge.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { seedGoalsOverHttp } from './goal-seed.ts';
import { type Frame, listenFrames, waitForFrames } from './sse-frames.ts';

const PERSON = { id: 'known-jordan', name: 'Jordan', kind: 'person' };
const LEAD = { id: 'agent-cartographer', name: 'Cartographer', kind: 'agent' };

/** The production window. Nothing in this file may wait it out. */
const IDLE_MS = 15 * 60_000;

const settle = (ms = 120) => new Promise((r) => setTimeout(r, ms));

describe('a person queueing a row wakes the lead in that tick', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let workspaceId: string;
  let goals: Record<string, string>;
  let lead: ReturnType<typeof listenFrames>;
  let tab: ReturnType<typeof listenFrames>;

  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  /** Fail with the server's own words rather than with `undefined` three
   *  lines later — a setup that quietly 400s is how a wake test passes by
   *  never having had a board to wake. */
  const jj = async <T>(res: Response): Promise<T> => {
    expect(res.ok, `${res.status} ${await res.clone().text()}`).toBe(true);
    return res.json() as Promise<T>;
  };

  const nudges = (frames: readonly Frame[]) => frames.filter((f) => f.event === READY_IDLE_EVENT);

  /**
   * A row as Bryan files one: his own, in triage, owned by the board's agent
   * and in an agreed band. Everything except the status that dispatch reads.
   */
  async function triageRow(title: string, extra: Record<string, unknown> = {}): Promise<string> {
    const { task } = await jj<{ task: { id: string; status: string } }>(
      await post(`/workspaces/${workspaceId}/tasks`, {
        title,
        body: `Agent can ${title.toLowerCase()} so that the queue keeps moving.`,
        assignee: LEAD.name,
        assigneeKind: 'agent',
        goal: goals.rank,
        // His own create lands in `todo`; this is the blank row he builds up
        // in pieces, which is the case that started all of this.
        triage: true,
        author: PERSON,
        ...extra,
      }),
    );
    expect(task.status, 'the fixture must start held off the queue').toBe('triage');
    return task.id;
  }

  const moveToTodo = (taskId: string, author: unknown) =>
    post(`/workspaces/${workspaceId}/tasks/${taskId}/transition`, {
      to: 'todo',
      author,
      workspaceId,
    });

  /** A timed pass that must find nothing: proof the window really is shut,
   *  so every frame this file sees came from the immediate path. */
  async function expectWindowStillShut(): Promise<void> {
    handle.nudgeReadyWork();
    await settle();
    expect(
      nudges(lead.frames).map((f) => f.data?.taskId),
      'the idle window should not have elapsed',
    ).toEqual([]);
  }

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nudge-person-'));
    handle = createServer({ port: 0, dataDir, readyNudgeIdleMs: IDLE_MS });
    base = `http://127.0.0.1:${handle.port}`;
    const { workspace } = await jj<{ workspace: { id: string } }>(
      await post('/workspaces', { name: 'search-revamp', leadAgentId: LEAD.id }),
    );
    workspaceId = workspace.id;
    await jj(
      await post(`/workspaces/${workspaceId}/agents`, {
        agentId: LEAD.id,
        runtime: 'claude-code-local',
      }),
    );
    const leadRes = await fetch(
      `${base}/workspaces/${workspaceId}/events:stream?agentId=${encodeURIComponent(LEAD.id)}`,
      { headers: { accept: 'text/event-stream' } },
    );
    // A browser tab on the same channel. Nothing addressed may reach it.
    const tabRes = await fetch(`${base}/workspaces/${workspaceId}/events:stream`, {
      headers: { accept: 'text/event-stream' },
    });
    lead = listenFrames(leadRes);
    tab = listenFrames(tabRes);
    goals = await seedGoalsOverHttp(
      base,
      workspaceId,
      [{ key: 'rank', title: 'Rank results' }],
      PERSON,
    );
  });

  afterEach(async () => {
    await lead.stop();
    await tab.stop();
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('names the row he queued, with no window and only to him', async () => {
    const taskId = await triageRow('Rank results by recency');
    // Agreeing the band is a person's transition too, and it fired nothing:
    // a goal row is owned by nobody, so it is never ready work.
    await expectWindowStillShut();

    await jj(await moveToTodo(taskId, PERSON));
    const got = await waitForFrames(lead.frames, READY_IDLE_EVENT, 1);

    expect(got).toHaveLength(1);
    expect(got[0]?.data?.taskId).toBe(taskId);
    // The name, off the board's own ready set rather than off the caller.
    expect(got[0]?.data?.title).toBe('Rank results by recency');
    // The discriminator between the two paths: a timed pass always says how
    // long the board stood still, and this one never stood still at all.
    expect(got[0]?.data?.idleMs).toBeUndefined();
    // Addressed. The tab is on the same channel and heard the row change —
    // the positive control that says it was listening at all.
    await settle();
    expect(nudges(tab.frames)).toHaveLength(0);
    expect(tab.frames.length).toBeGreaterThan(0);
  }, 60_000);

  it('stays silent when an agent makes the same move, and still fires for his', async () => {
    const agentMoved = await triageRow('Cache the facet counts');
    await jj(await moveToTodo(agentMoved, LEAD));
    await settle(400);
    // Ready, and deliberately unannounced: a builder moving its own rows must
    // not wake the lead once per transition.
    await expectWindowStillShut();

    const hisMove = await triageRow('Rank results by recency');
    await jj(await moveToTodo(hisMove, PERSON));
    const got = await waitForFrames(lead.frames, READY_IDLE_EVENT, 1);
    expect(got).toHaveLength(1);
    // His row, not the one the agent queued first — the wake names what he
    // just did, and the silence above was about the actor rather than about a
    // board that could not be woken.
    expect(got[0]?.data?.taskId).toBe(hisMove);
  }, 60_000);

  it('stays silent when his move leaves the row held behind an open dependency', async () => {
    const blocker = await triageRow('Rebuild the crawler queue');
    const held = await triageRow('Rank results by recency');
    await jj(
      await post(`/workspaces/${workspaceId}/tasks/${held}/after`, {
        // `afterEnforce` is a SUBSET of `after` — an id in one and not the
        // other is never visited and blocks nothing.
        after: [blocker],
        afterEnforce: [blocker],
        author: PERSON,
        workspaceId,
      }),
    );

    await jj(await moveToTodo(held, PERSON));
    await settle(400);
    expect(
      nudges(lead.frames).map((f) => f.data?.taskId),
      'a held row was announced as ready',
    ).toEqual([]);

    // Same person, same verb, a row nothing holds: the silence above was the
    // hold, not a wake that had stopped working.
    const free = await triageRow('Cache the facet counts');
    await jj(await moveToTodo(free, PERSON));
    const got = await waitForFrames(lead.frames, READY_IDLE_EVENT, 1);
    expect(got).toHaveLength(1);
    expect(got[0]?.data?.taskId).toBe(free);
  }, 60_000);

  it('stays silent when his move leaves the row under a band still in triage', async () => {
    const pending = await seedGoalsOverHttp(
      base,
      workspaceId,
      [
        { key: 'rank', title: 'Rank results' },
        { key: 'later', title: 'Rewrite the crawler' },
      ],
      PERSON,
      { leaveInTriage: true },
    );
    // `setGoalList` is a full replace, so re-agree the band the rows above use
    // and leave the second one where it was minted.
    await jj(await moveToTodo(pending.rank as string, PERSON));
    goals = pending as Record<string, string>;

    const held = await triageRow('Rank results by recency', { goal: pending.later });
    await jj(await moveToTodo(held, PERSON));
    await settle(400);
    expect(
      nudges(lead.frames).map((f) => f.data?.taskId),
      'a row under a triage band was announced as ready',
    ).toEqual([]);

    const free = await triageRow('Cache the facet counts', { goal: pending.rank });
    await jj(await moveToTodo(free, PERSON));
    const got = await waitForFrames(lead.frames, READY_IDLE_EVENT, 1);
    expect(got).toHaveLength(1);
    expect(got[0]?.data?.taskId).toBe(free);
  }, 60_000);
});

/**
 * The one rule with no board behind it: a full parallelism cap must not
 * swallow the wake.
 *
 * He mentioned capacity because it was what he believed governed pickup, not
 * as a condition he asked for — and a wake suppressed because the cap was
 * full is a wake nobody ever learns was owed. The lead reads the cap itself
 * and queues.
 *
 * Driven against the nudger directly, because the fact under test is a shape
 * of snapshot: `ready` has already been trimmed to the free slots by
 * `readyWorkSnapshot`, so a board at its cap presents an EMPTY ready list and
 * a perfectly ready row. Building that over HTTP would take a dispatch, a
 * worktree and a cap change to reach one `if`.
 */
describe('the immediate wake is not gated on free capacity', () => {
  const row = { id: 't-rank', title: 'Rank results by recency' };

  function nudgerOver(snapshot: Record<string, unknown>) {
    const frames: Array<Record<string, unknown>> = [];
    const nudger = new ReadyWorkNudger({
      snapshot: () => [],
      lookup: () =>
        ({
          workspaceId: 'w-search',
          leadAgentId: LEAD.id,
          retired: false,
          ready: [],
          considered: 1,
          held: {},
          undetermined: [],
          lastActivityAt: 0,
          ...snapshot,
        }) as never,
      canReach: () => true,
      send: (_workspaceId, _agentId, frame) => {
        frames.push(frame as unknown as Record<string, unknown>);
        return 1;
      },
      report: () => {},
    });
    return { nudger, frames };
  }

  it('fires for a row the cap trimmed out of the ready set', () => {
    const { nudger, frames } = nudgerOver({ capacityHeld: 1, capacityTrimmed: [row] });
    nudger.personQueuedTask({ workspaceId: 'w-search', taskId: row.id });
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ event: READY_IDLE_EVENT, taskId: row.id, title: row.title });
  });

  it('still fires nothing for a row in neither list', () => {
    const { nudger, frames } = nudgerOver({ capacityHeld: 1, capacityTrimmed: [row] });
    nudger.personQueuedTask({ workspaceId: 'w-search', taskId: 't-other' });
    expect(frames).toHaveLength(0);
  });
});
