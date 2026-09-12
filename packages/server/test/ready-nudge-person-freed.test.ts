/**
 * A person FREEING held rows wakes the lead, not just one queueing a fresh row.
 *
 * `ready-nudge-person-queued.test.ts` next door covers the move that
 * transitions the row that became ready. This covers the two moves that make
 * work dispatchable WITHOUT transitioning it, which is the gesture Bryan
 * actually makes — the report behind that branch was a row built up in pieces
 * and then regrouped into a real goal, which is a goal-band release:
 *
 *   1. agreeing a goal band releases every row under it at once, and the
 *      transition is on the GOAL row;
 *   2. closing a blocker releases whatever waited on the `after` edge, and the
 *      transition is on the BLOCKER.
 *
 * Measured on this branch before the fix, with these exact fixtures: the goal
 * agreement made two rows ready and delivered ZERO frames; the blocker close
 * made one row ready and delivered zero. Both fell back to the fifteen-minute
 * window, and the goal case is silent in BULK — one gesture, ten rows, nobody
 * told about any of them.
 *
 * Every test here runs with the PRODUCTION idle window and asserts against a
 * `nudgeReadyWork()` pass that provably produces nothing under it, for the
 * same reason the sibling suite does: that is what makes "immediate" mean
 * anything rather than being invisible to a suite where every board is idle on
 * sight.
 *
 * All fixtures are synthetic — invented names, a public repo.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FREED_ROWS_NAMED, READY_IDLE_EVENT, ReadyWorkNudger } from '../src/ready-nudge.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { seedGoalsOverHttp } from './goal-seed.ts';
import { type Frame, listenFrames, waitForFrames } from './sse-frames.ts';
import { waitFor } from './wait-for.ts';

const PERSON = { id: 'known-owner', name: 'Board Owner', kind: 'person' };
const LEAD = { id: 'agent-cartographer', name: 'Cartographer', kind: 'agent' };

/** The production window. Nothing in this file may wait it out. */
const IDLE_MS = 15 * 60_000;

describe('a person freeing held rows wakes the lead once, naming them', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let workspaceId: string;
  /** `agreed` dispatches; `pending` is left in triage and holds its band. */
  let goals: Record<string, string>;
  let lead: ReturnType<typeof listenFrames>;
  let tab: ReturnType<typeof listenFrames>;

  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  /** Fail with the server's own words rather than with `undefined` three lines
   *  later — a setup that quietly 400s is how a wake test passes by never
   *  having had a board to wake. */
  const jj = async <T>(res: Response): Promise<T> => {
    expect(res.ok, `${res.status} ${await res.clone().text()}`).toBe(true);
    return res.json() as Promise<T>;
  };

  const nudges = (frames: readonly Frame[]) => frames.filter((f) => f.event === READY_IDLE_EVENT);

  /** A row as Bryan files one: his own, in triage, owned by the board's agent.
   *  Everything except the status and the band agreement that dispatch reads. */
  async function row(title: string, extra: Record<string, unknown> = {}): Promise<string> {
    const { task } = await jj<{ task: { id: string; status: string } }>(
      await post(`/workspaces/${workspaceId}/tasks`, {
        title,
        body: `Agent can ${title.toLowerCase()} so that the queue keeps moving.`,
        assignee: LEAD.name,
        assigneeKind: 'agent',
        goal: goals.agreed,
        triage: true,
        author: PERSON,
        ...extra,
      }),
    );
    expect(task.status, 'the fixture must start held off the queue').toBe('triage');
    return task.id;
  }

  const moveTo = (taskId: string, to: string, author: unknown) =>
    post(`/workspaces/${workspaceId}/tasks/${taskId}/transition`, { to, author, workspaceId });

  const blockOn = (taskId: string, after: string[]) =>
    post(`/workspaces/${workspaceId}/tasks/${taskId}/after`, {
      // `afterEnforce` is a SUBSET of `after` — an id in one and not the other
      // is never visited and blocks nothing.
      after,
      afterEnforce: after,
      author: PERSON,
      workspaceId,
    });

  /**
   * Two rows queued under the band nobody has agreed yet. Each move is a
   * person's, and each fires nothing — the sibling suite proves that silence
   * is the goal-triage hold rather than a broken wake.
   */
  async function twoHeldUnderPendingBand(): Promise<[string, string]> {
    const a = await row('Rank results by recency', { goal: goals.pending });
    const b = await row('Cache the facet counts', { goal: goals.pending });
    await jj(await moveTo(a, 'todo', PERSON));
    await jj(await moveTo(b, 'todo', PERSON));
    // A timed pass over a board built seconds ago: the window is shut, so every
    // frame below came from the immediate path and nowhere else.
    handle.nudgeReadyWork();
    expect(nudges(lead.frames), 'held rows are silent before the release').toHaveLength(0);
    return [a, b];
  }

  /**
   * Move that must have announced nothing, then queue a free row and wait for
   * the wake THAT one is owed — and assert the stream holds only it.
   *
   * Ordering rather than a sleep, and it is the stronger assertion: both moves
   * run on one SSE stream, the first route call returns before the second is
   * sent, and a `nudgeReadyWork()` pass in between is synchronous. Anything the
   * release would have delivered is already on the stream by the time the
   * second move's frame lands.
   */
  async function expectOnlyTheSecondWake(what: string, freeTitle: string): Promise<void> {
    handle.nudgeReadyWork();
    const free = await row(freeTitle);
    await jj(await moveTo(free, 'todo', PERSON));
    const got = await waitForFrames(lead.frames, READY_IDLE_EVENT, 1);
    expect(
      got.map((f) => f.data?.taskId),
      `${what} should not have been announced`,
    ).toEqual([free]);
  }

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nudge-freed-'));
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
      [
        { key: 'agreed', title: 'Rank results' },
        { key: 'pending', title: 'Rewrite the crawler' },
      ],
      PERSON,
      { leaveInTriage: true },
    );
    // Agree the first band only. Agreeing it releases nothing — no row exists
    // yet — which is itself the "a release that frees nothing is silent" rule
    // running in every one of these fixtures.
    await jj(await moveTo(goals.agreed as string, 'todo', PERSON));
  });

  afterEach(async () => {
    await lead.stop();
    await tab.stop();
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('agreeing a band sends ONE wake naming every row it freed', async () => {
    const [a, b] = await twoHeldUnderPendingBand();

    await jj(await moveTo(goals.pending as string, 'todo', PERSON));

    const got = await waitForFrames(lead.frames, READY_IDLE_EVENT, 1);
    // One frame for the gesture, not one per row: ten rows freed by one
    // agreement must not cost ten turns.
    expect(got).toHaveLength(1);
    const freed = got[0]?.data?.freed as { count: number; rows: { id: string }[] } | undefined;
    expect(freed?.count).toBe(2);
    expect(freed?.rows.map((r) => r.id)).toEqual([a, b]);
    // The first freed row is also on `taskId`/`title`, so a plugin older than
    // `freed` still names a row rather than waking with no subject.
    expect(got[0]?.data?.taskId).toBe(a);
    expect(got[0]?.data?.title).toBe('Rank results by recency');
    // The discriminator against the timed pass, which always says how long the
    // board stood still. This board never stood still at all.
    expect(got[0]?.data?.idleMs).toBeUndefined();
    // Addressed. The tab is on the same channel and heard the board move —
    // waited for, so "the tab got no wake" cannot be satisfied by a tab that
    // had not yet received anything at all.
    await waitFor(() => tab.frames.length > 0, { describe: 'the tab to hear the board move' });
    expect(nudges(tab.frames)).toHaveLength(0);
  }, 60_000);

  it('closing a blocker wakes the lead about the row it released', async () => {
    const blocker = await row('Rebuild the crawler queue');
    const held = await row('Rank results by recency');
    await jj(await blockOn(held, [blocker]));
    await jj(await moveTo(held, 'todo', PERSON));
    // The blocker is the agent's own work, so neither of its moves wakes
    // anybody — the wake below is the release and nothing else.
    await jj(await moveTo(blocker, 'todo', LEAD));
    await jj(await moveTo(blocker, 'in-progress', LEAD));
    handle.nudgeReadyWork();
    expect(nudges(lead.frames), 'the held row is silent while blocked').toHaveLength(0);

    await jj(await moveTo(blocker, 'done', PERSON));

    const got = await waitForFrames(lead.frames, READY_IDLE_EVENT, 1);
    expect(got).toHaveLength(1);
    expect(got[0]?.data?.taskId).toBe(held);
    const freed = got[0]?.data?.freed as { count: number; rows: { id: string }[] } | undefined;
    expect(freed?.count).toBe(1);
    expect(freed?.rows.map((r) => r.id)).toEqual([held]);
  }, 60_000);

  it('stays silent when an AGENT agrees the band, and still fires for a person’s move', async () => {
    const [a] = await twoHeldUnderPendingBand();
    // The identical gesture from a builder. Agents agree bands and close their
    // own blockers constantly; waking the lead on each is the noise the idle
    // window exists to suppress.
    await jj(await moveTo(goals.pending as string, 'todo', LEAD));

    await expectOnlyTheSecondWake(`the band holding ${a}`, 'Tune the ranker');
  }, 60_000);

  it('stays silent when an AGENT closes the blocker', async () => {
    const blocker = await row('Rebuild the crawler queue');
    const held = await row('Rank results by recency');
    await jj(await blockOn(held, [blocker]));
    await jj(await moveTo(held, 'todo', PERSON));
    await jj(await moveTo(blocker, 'todo', LEAD));
    await jj(await moveTo(blocker, 'in-progress', LEAD));
    await jj(await moveTo(blocker, 'done', LEAD));

    await expectOnlyTheSecondWake(held, 'Tune the ranker');
  }, 60_000);

  it('names only the rows a release really freed, not the ones still held', async () => {
    const first = await row('Rebuild the crawler queue');
    const second = await row('Re-index the archive');
    const freedRow = await row('Rank results by recency');
    const stillHeld = await row('Cache the facet counts');
    // `freedRow` waits on one blocker; `stillHeld` waits on two. Closing the
    // first frees one of them and not the other, so a release that named both
    // would be naming a row the lead would be told is blocked.
    await jj(await blockOn(freedRow, [first]));
    await jj(await blockOn(stillHeld, [first, second]));
    await jj(await moveTo(freedRow, 'todo', PERSON));
    await jj(await moveTo(stillHeld, 'todo', PERSON));
    for (const id of [first, second]) {
      await jj(await moveTo(id, 'todo', LEAD));
      await jj(await moveTo(id, 'in-progress', LEAD));
    }
    handle.nudgeReadyWork();
    expect(nudges(lead.frames)).toHaveLength(0);

    await jj(await moveTo(first, 'done', PERSON));

    const got = await waitForFrames(lead.frames, READY_IDLE_EVENT, 1);
    const freed = got[0]?.data?.freed as { count: number; rows: { id: string }[] } | undefined;
    expect(freed?.count).toBe(1);
    expect(freed?.rows.map((r) => r.id)).toEqual([freedRow]);
  }, 60_000);

  it('says nothing at all when a person’s move frees nothing', async () => {
    const [a] = await twoHeldUnderPendingBand();
    // A person parking a held row and un-parking it. Both transitions read the
    // board twice and must produce no frame: the band is still in triage, so
    // nothing became dispatchable either time and the wake is about what did.
    await jj(await moveTo(a, 'triage', PERSON));
    await jj(await moveTo(a, 'todo', PERSON));

    await expectOnlyTheSecondWake(a, 'Tune the ranker');
  }, 60_000);

  it('does not announce the moved row twice when it is the one freed', async () => {
    // A person queueing a free row is `personQueuedTask`'s wake. The release
    // path reads the same board and must EXCLUDE that row, or one move puts
    // two frames on the channel about one thing.
    const queued = await row('Rank results by recency');
    await jj(await moveTo(queued, 'todo', PERSON));

    const got = await waitForFrames(lead.frames, READY_IDLE_EVENT, 1);
    expect(got).toHaveLength(1);
    expect(got[0]?.data?.taskId).toBe(queued);
    // And it is the queued wake, not a release one: `freed` is the field that
    // tells the two apart on the wire.
    expect(got[0]?.data?.freed).toBeUndefined();
  }, 60_000);
});

/**
 * The arming rules, and the size cap — driven against the nudger directly.
 *
 * PR 958's arming bug is the one this path must not reintroduce: it spent the
 * board's arming BEFORE confirming the lead was reachable, and because the
 * immediate path also moves the idle clock through `noteActivity`, the arming
 * it recorded matched the very stamp the next tick computes. So the wake was
 * dropped AND the fifteen-minute backstop was disarmed with it — for exactly
 * the state that produces an unattached lead: a restart, a plugin update, a
 * session that has not come back.
 *
 * Building a forty-row band and a detached lead over HTTP would take a fixture
 * far larger than the `if` it reaches.
 */
describe('the release wake spends nothing it did not deliver', () => {
  const rank = { id: 't-rank', title: 'Rank results by recency' };
  const facets = { id: 't-facets', title: 'Cache the facet counts' };

  function harness(board: Record<string, unknown>, opts: Record<string, unknown> = {}) {
    const frames: Array<Record<string, unknown>> = [];
    const state = { reachable: true, sinks: 1, now: 1_000_000 };
    const nudger = new ReadyWorkNudger({
      snapshot: () => [board] as never,
      lookup: () => board as never,
      canReach: () => state.reachable,
      send: (_workspaceId, _agentId, frame) => {
        frames.push(frame as unknown as Record<string, unknown>);
        return state.sinks;
      },
      now: () => state.now,
      idleMs: IDLE_MS,
      report: () => {},
      ...opts,
    });
    return { nudger, frames, state };
  }

  const emptyBoard = () => ({
    workspaceId: 'w-search',
    leadAgentId: LEAD.id,
    retired: false,
    ready: [] as Array<{ id: string; title: string }>,
    considered: 2,
    held: {},
    undetermined: [],
    lastActivityAt: 0,
  });

  it('leaves the release owed when the lead is holding no stream', () => {
    const board = emptyBoard();
    const { nudger, frames, state } = harness(board);
    const before = nudger.markReady('w-search');
    board.ready = [rank];
    state.reachable = false;

    nudger.personFreedWork({ workspaceId: 'w-search', before });
    expect(frames, 'there was nobody to tell').toHaveLength(0);

    // He comes back and the window elapses. The board still owes him this.
    state.reachable = true;
    state.now += IDLE_MS + 1;
    nudger.tick();
    expect(frames).toHaveLength(1);
    // The TIMED frame, not a replay of the release: it carries the
    // denominator, which the immediate path never sends.
    expect(frames[0]).toMatchObject({ taskId: rank.id, readyCount: 1, consideredCount: 2 });
  });

  it('leaves the release owed when the send reaches no sink', () => {
    // The socket closed between the reachability probe and the send. Same
    // consequence as an absent lead, and the same rule.
    const board = emptyBoard();
    const { nudger, frames, state } = harness(board);
    const before = nudger.markReady('w-search');
    board.ready = [rank];
    state.sinks = 0;

    nudger.personFreedWork({ workspaceId: 'w-search', before });
    expect(frames, 'the frame was written to a closed socket').toHaveLength(1);

    state.sinks = 1;
    state.now += IDLE_MS + 1;
    nudger.tick();
    expect(frames).toHaveLength(2);
    expect(frames[1]).toMatchObject({ taskId: rank.id, readyCount: 1 });
  });

  it('spends the arming on a delivered release, so no second frame follows', () => {
    const board = emptyBoard();
    const { nudger, frames, state } = harness(board);
    const before = nudger.markReady('w-search');
    board.ready = [rank, facets];

    nudger.personFreedWork({ workspaceId: 'w-search', before });
    expect(frames).toHaveLength(1);

    // The window elapses over the same facts. One release, one wake.
    state.now += IDLE_MS + 1;
    nudger.tick();
    expect(frames).toHaveLength(1);
  });

  it('names the first few of a large band and says how many more', () => {
    const band = Array.from({ length: FREED_ROWS_NAMED + 3 }, (_, i) => ({
      id: `t-band-${i}`,
      title: `Band row ${i}`,
    }));
    const board = emptyBoard();
    const { nudger, frames } = harness(board);
    const before = nudger.markReady('w-search');
    board.ready = band;

    nudger.personFreedWork({ workspaceId: 'w-search', before });
    expect(frames).toHaveLength(1);
    const freed = frames[0]?.freed as { count: number; rows: Array<{ id: string }> };
    // The TRUE total, with only the first few named: a band of forty is one
    // wake, and the reader's next act is `next_tasks` for the rest.
    expect(freed.count).toBe(band.length);
    expect(freed.rows).toHaveLength(FREED_ROWS_NAMED);
    expect(freed.rows.map((r) => r.id)).toEqual(band.slice(0, FREED_ROWS_NAMED).map((r) => r.id));
  });

  it('mentions the moved task once when one act both queues it and frees others', () => {
    // The two immediate wakes side by side. No transition reaches this today —
    // an `after` edge clears on `done`, not on `todo`, so a move that queues a
    // task cannot free a sibling — but the invariant is what a reader trusts,
    // and a board that named the same task in two frames reads as one that has
    // lost track of its own state. Driven here rather than over HTTP because
    // the route cannot currently build it.
    const board = emptyBoard();
    const { nudger, frames } = harness(board);
    const before = nudger.markReady('w-search');
    board.ready = [rank, facets];

    nudger.personQueuedTask({ workspaceId: 'w-search', taskId: rank.id });
    nudger.personFreedWork({ workspaceId: 'w-search', before, except: rank.id });

    expect(frames).toHaveLength(2);
    // One frame is about the moved task, the other about what it freed, and
    // the moved task is named in exactly one of them.
    expect(frames[0]).toMatchObject({ taskId: rank.id });
    expect(frames[0]?.freed).toBeUndefined();
    const freed = frames[1]?.freed as { count: number; rows: Array<{ id: string }> };
    expect(freed.rows.map((r) => r.id)).toEqual([facets.id]);
    const mentions = frames.filter(
      (f) =>
        f.taskId === rank.id ||
        ((f.freed as { rows?: Array<{ id: string }> } | undefined)?.rows ?? []).some(
          (r) => r.id === rank.id,
        ),
    );
    expect(mentions, 'the moved task is announced once, by one wake').toHaveLength(1);
  });

  it('marks a board it cannot read UNREADABLE, and then frees nothing', () => {
    // The pre-write lookup threw and the post-write one succeeds. An empty mark
    // would make every ready row read as just released; an unreadable one says
    // nothing, which is the only honest answer.
    const board = emptyBoard();
    let readable = false;
    const { nudger, frames } = harness(board, { lookup: () => (readable ? board : undefined) });
    const before = nudger.markReady('w-search');
    expect(before.readable).toBe(false);
    board.ready = [rank, facets];
    readable = true;
    nudger.personFreedWork({ workspaceId: 'w-search', before });
    expect(frames).toHaveLength(0);
  });

  it('never wakes a retired board', () => {
    const board = { ...emptyBoard(), retired: true, ready: [rank] };
    const { nudger, frames } = harness(board);
    nudger.personFreedWork({
      workspaceId: 'w-search',
      before: { readable: true, ids: new Set<string>() },
    });
    expect(frames).toHaveLength(0);
  });
});
