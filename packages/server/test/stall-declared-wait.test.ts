/**
 * A declared wait silences its task's stall wake until the wait lapses.
 *
 * `stall-quiet-wait.test.ts` pins the nudger's arming rules against snapshots
 * written by hand, with `lapsed` set by the test. This file drives the gate
 * AND the nudger together on one clock the test moves, so the lapse is the
 * gate's own reading of `until` and every row ages because time passed — the
 * same two calls the server's tick makes, with the store left out.
 *
 * The defect it was written against, measured on a live board: a wake every
 * half hour for five hours listing two waiting tasks under "stopped moving",
 * with the frame addressed to the first of them. What actually crossed each
 * window was an unfiled ask further down the frame; the waits were read as
 * the cause because they were named as the stall.
 *
 * All fixtures are synthetic — invented titles in a made-up workspace. The
 * repo is public.
 */
import { describe, expect, it } from 'bun:test';
import type { TaskRow } from '../src/keep-moving.ts';
import { evaluateStalls } from '../src/stall-gate.ts';
import {
  STALL_REPEAT_DEFAULT_MS,
  type StallNudgeFrame,
  StallNudger,
  type StallSnapshot,
} from '../src/stall-nudge.ts';

const MIN = 60_000;
const START = 10_000 * MIN;
const bands = { dispatchable: new Set(['g1']), ownerBand: new Set(['decisions']) };

/** An in-progress task whose last movement was `quietFor` before START. */
function task(id: string, title: string, quietFor: number, over: Partial<TaskRow> = {}): TaskRow {
  return {
    id,
    title,
    status: 'in-progress',
    goal: 'g1',
    createdAt: START - quietFor,
    transitions: [{ ts: START - quietFor, to: 'in-progress' }],
    ownerKind: 'agent',
    ...over,
  };
}

/** A wait declared at `at`, standing for `forMs`. */
function waitOn(what: string, at: number, forMs: number): NonNullable<TaskRow['externalWait']> {
  return { what, since: at, declaredAt: at, until: at + forMs, by: 'Index Keeper' };
}

/**
 * The server's tick with the store taken out: `evaluateStalls` over the rows
 * at the current clock, shaped into the snapshot the wiring hands the nudger.
 */
function loop(tasks: TaskRow[]) {
  const world = { now: START };
  const sent: StallNudgeFrame[] = [];
  const snapshot = (): StallSnapshot[] => {
    const verdict = evaluateStalls({
      tasks,
      events: [],
      reviewItems: [],
      bands,
      now: world.now,
    });
    return [
      {
        workspaceId: 'w-atlas',
        leadAgentId: 'agent-lead',
        retired: false,
        stalled: verdict.stalled,
        unfiled: verdict.unfiled,
        ...(verdict.declaredWaits.length > 0 ? { declaredWaits: verdict.declaredWaits } : {}),
        considered: verdict.considered,
        undetermined: verdict.undetermined,
      },
    ];
  };
  const nudger = new StallNudger({
    now: () => world.now,
    snapshot,
    canReach: () => true,
    attachedAgents: () => ['agent-lead'],
    send: (_workspaceId, _agentId, frame) => {
      sent.push(frame);
      return 1;
    },
    report: () => {},
  });
  const step = STALL_REPEAT_DEFAULT_MS / 6;
  return {
    sent,
    verdict: () => snapshot()[0] as StallSnapshot,
    tick: () => nudger.tick(),
    /** Move the clock by `ms`, ticking every five minutes on the way. */
    advance: (ms: number) => {
      const end = world.now + ms;
      while (world.now < end) {
        world.now = Math.min(end, world.now + step);
        nudger.tick();
      }
    },
    now: () => world.now,
  };
}

describe('a task with a standing declared wait', () => {
  it('sends no wake on a board whose only quiet tasks are waiting, across six windows', () => {
    const tasks = [
      task('t-rollout', 'Agree the rollout window', 5 * 60 * MIN, {
        externalWait: waitOn('the fleet restart', START - 20 * MIN, 8 * 60 * MIN),
      }),
      task('t-palette', 'Settle the chart palette', 4 * 60 * MIN, {
        externalWait: waitOn('a peer landing the token export', START - 20 * MIN, 8 * 60 * MIN),
      }),
    ];
    const h = loop(tasks);
    // The gate still judges both rows stalled — the silence is real, and the
    // keep-moving measurement counts it. What changes is only whether it wakes.
    expect(h.verdict().stalled.map((row) => row.id)).toEqual(['t-rollout', 't-palette']);

    h.tick();
    h.advance(6 * STALL_REPEAT_DEFAULT_MS);

    expect(h.sent).toHaveLength(0);
  });

  it('the control: the same quiet task with no wait wakes, and is re-said every window', () => {
    const h = loop([task('t-rollout', 'Agree the rollout window', 5 * 60 * MIN)]);

    h.tick();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.rows?.map((row) => row.id)).toEqual(['t-rollout']);

    h.advance(3 * STALL_REPEAT_DEFAULT_MS);

    expect(h.sent).toHaveLength(4);
  });

  it('comes back loud on the first tick after the wait lapses', () => {
    const tasks = [
      task('t-rollout', 'Agree the rollout window', 5 * 60 * MIN, {
        externalWait: waitOn('the fleet restart', START, 60 * MIN),
      }),
    ];
    const h = loop(tasks);
    h.tick();
    h.advance(55 * MIN);
    expect(h.sent).toHaveLength(0);

    h.advance(10 * MIN);

    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.rows?.map((row) => row.id)).toEqual(['t-rollout']);
    expect(h.sent[0]?.declaredWaits?.[0]?.lapsed).toBe(true);
  });

  it('comes back loud when a short wait lapses on a task the lead had already been told about', () => {
    // The lapse must be news in its own right. Here the lead heard about
    // t-rollout before its wait was declared, and a quieter task beside it
    // holds the board's bucket steady across the lapse — so neither "a task
    // the lead never heard of" nor "the board crossed a window" would carry
    // the wake. Only forgetting a task while it waits does.
    const tasks = [
      task('t-index', 'Trim the index writer', 100 * MIN),
      task('t-rollout', 'Agree the rollout window', 40 * MIN),
    ];
    const h = loop(tasks);
    h.tick();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.rows?.map((row) => row.id)).toEqual(['t-index', 't-rollout']);

    (tasks[1] as TaskRow).externalWait = waitOn('the fleet restart', h.now(), 10 * MIN);
    h.advance(5 * MIN);
    expect(h.sent).toHaveLength(1);

    h.advance(10 * MIN);

    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]?.changed?.rows?.map((row) => row.id)).toEqual(['t-rollout']);
    expect(h.sent[1]?.changed?.escalated).toBeUndefined();
  });
});

describe('a wake that fires for another reason', () => {
  it('lists waiting tasks only as declared waits, never under "stopped moving"', () => {
    // The live board's shape: two waiting tasks and an ask filed nowhere,
    // which is re-said every window it stays unfiled.
    const tasks = [
      task('t-rollout', 'Agree the rollout window', 5 * 60 * MIN, {
        externalWait: waitOn('the fleet restart', START - 20 * MIN, 8 * 60 * MIN),
      }),
      task('t-palette', 'Settle the chart palette', 4 * 60 * MIN, {
        externalWait: waitOn('a peer landing the token export', START - 20 * MIN, 8 * 60 * MIN),
      }),
      task('t-copy', 'Pick the empty-state copy', 6 * 60 * MIN, { ownerKind: 'person' }),
    ];
    const h = loop(tasks);
    expect(h.verdict().unfiled.map((row) => row.id)).toEqual(['t-copy']);

    h.tick();
    h.advance(2 * STALL_REPEAT_DEFAULT_MS);

    expect(h.sent.length).toBeGreaterThan(1);
    for (const frame of h.sent) {
      expect(frame.stalledCount).toBe(0);
      expect(frame.rows).toBeUndefined();
      expect(frame.taskId).toBe('t-copy');
      expect(frame.unfiled?.map((row) => row.id)).toEqual(['t-copy']);
      expect(frame.declaredWaits?.map((wait) => wait.id).sort()).toEqual([
        't-palette',
        't-rollout',
      ]);
    }
  });
});
