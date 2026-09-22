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
 * The last describe is the other half of the same question: which declared
 * waits answer the LIFTED-BLOCKAGE finding, whose whole sentence is that the
 * board has no record of anybody reading the answer. A wait FIRST declared at
 * or after the lift IS that record; one declared before it, one merely
 * renewed after it, and one that has lapsed are not — and the finding it was
 * built from is a wait of exactly the second kind.
 *
 * All fixtures are synthetic — invented titles in a made-up workspace. The
 * repo is public.
 */
import { describe, expect, it } from 'bun:test';
import { LIFT_CLOCK_EPSILON_MS, type Lift } from '../src/blockage-lift.ts';
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
 * A wait FIRST declared at `since` and renewed at `declaredAt` — the shape
 * `setExternalWait` writes when the words are unchanged, which keeps `since`
 * and moves `declaredAt`. The gate reads `since`, so this is the shape that
 * separates "somebody read the answer" from "somebody re-stated an old wait".
 */
function renewedWait(
  what: string,
  since: number,
  declaredAt: number,
  forMs: number,
): NonNullable<TaskRow['externalWait']> {
  return { what, since, declaredAt, until: declaredAt + forMs, by: 'Index Keeper' };
}

/**
 * The server's tick with the store taken out: `evaluateStalls` over the rows
 * at the current clock, shaped into the snapshot the wiring hands the nudger.
 */
function loop(tasks: TaskRow[], lifts?: Map<string, Lift>) {
  const world = { now: START };
  const sent: StallNudgeFrame[] = [];
  const snapshot = (): StallSnapshot[] => {
    const verdict = evaluateStalls({
      tasks,
      events: [],
      reviewItems: [],
      bands,
      now: world.now,
      ...(lifts !== undefined ? { lifts } : {}),
    });
    return [
      {
        workspaceId: 'w-atlas',
        leadAgentId: 'agent-lead',
        retired: false,
        stalled: verdict.stalled,
        unfiled: verdict.unfiled,
        ...(verdict.unresumed.length > 0 ? { unresumed: verdict.unresumed } : {}),
        ...(verdict.declaredWaits.length > 0 ? { declaredWaits: verdict.declaredWaits } : {}),
        considered: verdict.considered,
        undetermined: verdict.undetermined,
      },
    ];
  };
  const nudger = new StallNudger({
    // Off: this file's subject is not the moved-within-the-hour rule
    // (`stall-frame-news.test.ts`), and its fixtures are younger than an hour.
    movedWithinMs: 0,
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

  it('the control: the same quiet task with no wait DOES wake, once', () => {
    // The control the silence above needs: without a declared wait the row is
    // named at once. It is named once and not again — the half-hourly re-say
    // is retired (`stall-repeat-suppression.test.ts`) — so what this proves is
    // that the wait, not the suppression, is what kept the case above at zero.
    const h = loop([task('t-rollout', 'Agree the rollout window', 5 * 60 * MIN)]);

    h.tick();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.rows?.map((row) => row.id)).toEqual(['t-rollout']);

    h.advance(3 * STALL_REPEAT_DEFAULT_MS);

    expect(h.sent).toHaveLength(1);
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

  it('comes back loud when a wait lapses on a task the lead had already been told about', () => {
    // The lapse must be news in its own right. Here the lead heard about
    // t-rollout before its wait was declared, and a quieter task beside it
    // holds the board's bucket steady across the lapse — so neither "a task
    // the lead never heard of" nor "the board crossed a window" would carry
    // the wake. Only forgetting a task while it waits does.
    //
    // The wait outlasts a repeat window on purpose: that is how long a task
    // stays in the set the lead was last handed (`wake-sent-sets.ts`). A wait
    // shorter than that ends with the lead's memory of the row still standing,
    // and re-naming a row they were handed minutes ago is the repeat this
    // whole change exists to stop.
    const tasks = [
      task('t-index', 'Trim the index writer', 100 * MIN),
      task('t-rollout', 'Agree the rollout window', 40 * MIN),
    ];
    const h = loop(tasks);
    h.tick();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.rows?.map((row) => row.id)).toEqual(['t-index', 't-rollout']);

    (tasks[1] as TaskRow).externalWait = waitOn(
      'the fleet restart',
      h.now(),
      STALL_REPEAT_DEFAULT_MS + 10 * MIN,
    );
    h.advance(5 * MIN);
    expect(h.sent).toHaveLength(1);

    h.advance(STALL_REPEAT_DEFAULT_MS + 10 * MIN);

    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]?.changed?.rows?.map((row) => row.id)).toEqual(['t-rollout']);
  });
});

describe('a wake that fires for another reason', () => {
  it('lists waiting tasks only as declared waits, never under "stopped moving"', () => {
    // The live board's shape: two waiting tasks beside one that simply
    // stopped, which is what the one wake is about.
    const tasks = [
      task('t-rollout', 'Agree the rollout window', 5 * 60 * MIN, {
        externalWait: waitOn('the fleet restart', START - 20 * MIN, 8 * 60 * MIN),
      }),
      task('t-palette', 'Settle the chart palette', 4 * 60 * MIN, {
        externalWait: waitOn('a peer landing the token export', START - 20 * MIN, 8 * 60 * MIN),
      }),
      // A plain stall, quiet with nothing explaining it: an agent owns it and
      // nobody has declared anything. It used to be a person-owned row with
      // the ask filed nowhere, which no longer wakes anyone at all — that
      // reading goes to the owner's queue (`waiting-unfiled-escalation.ts`)
      // rather than to the lead. Either way the row here is only the REASON
      // the frame exists; what is asserted is where the waiting two appear.
      task('t-copy', 'Pick the empty-state copy', 6 * 60 * MIN),
    ];
    const h = loop(tasks);
    // The gate judges all three stalled; the nudger is what drops the two
    // with a standing wait on them.
    expect(h.verdict().stalled.map((row) => row.id)).toContain('t-copy');

    h.tick();
    h.advance(2 * STALL_REPEAT_DEFAULT_MS);

    expect(h.sent).toHaveLength(1);
    for (const frame of h.sent) {
      expect(frame.stalledCount).toBe(1);
      expect(frame.rows?.map((row) => row.id)).toEqual(['t-copy']);
      expect(frame.taskId).toBe('t-copy');
      expect(frame.unfiled).toBeUndefined();
      expect(frame.declaredWaits?.map((wait) => wait.id).sort()).toEqual([
        't-palette',
        't-rollout',
      ]);
    }
  });
});

describe('a declared wait against a lifted blockage', () => {
  /** Four hours before START, with a later line still open — the shape
   *  `liftOf` returns for a done-when line reported met mid-ticket. */
  const LIFT_AT = START - 240 * MIN;
  /** The eleven seconds the live timeline measured between the two reports
   *  and the declaration that followed them. */
  const DECLARED_AFTER = 11_000;

  const lift = (): Map<string, Lift> =>
    new Map([
      [
        't-index',
        {
          kind: 'done-when-met' as const,
          at: LIFT_AT,
          what: 'The nightly rebuild runs green twice in a row.',
          next: 'Search reads the new index.',
        },
      ],
    ]);

  /** Quiet since before the lift, so nothing has touched the row since it —
   *  which is the other half of what the finding asks. */
  const row = (over: Partial<TaskRow> = {}): TaskRow =>
    task('t-index', 'Trim the index writer', 300 * MIN, over);

  it('drops the row from every finding when the wait was declared after the lift', () => {
    const h = loop(
      [
        row({
          externalWait: waitOn('the fleet restart', LIFT_AT + DECLARED_AFTER, 8 * 60 * MIN),
        }),
      ],
      lift(),
    );

    expect(h.verdict().unresumed ?? []).toHaveLength(0);

    h.tick();
    h.advance(6 * STALL_REPEAT_DEFAULT_MS);

    // Not a wake with a quieter sentence — no wake at all. The declaration is
    // the record the finding says is missing, and the stall half of the row
    // was already covered by the same standing wait.
    expect(h.sent).toHaveLength(0);
  });

  it('still names the row when the wait was declared BEFORE the lift', () => {
    // The 21-hour shape: the wait was declared on something, the answer then
    // arrived, and nothing about the declaration says anybody read it.
    const h = loop(
      [row({ externalWait: waitOn('the fleet restart', LIFT_AT - 20 * MIN, 8 * 60 * MIN) })],
      lift(),
    );

    expect((h.verdict().unresumed ?? []).map((r) => r.id)).toEqual(['t-index']);

    h.tick();

    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.unresumed?.map((r) => r.id)).toEqual(['t-index']);
  });

  it('still names the row when a wait declared after the lift has lapsed', () => {
    const declaredAt = LIFT_AT + DECLARED_AFTER;
    const h = loop(
      [row({ externalWait: waitOn('the fleet restart', declaredAt, 60 * MIN) })],
      lift(),
    );

    expect((h.verdict().unresumed ?? []).map((r) => r.id)).toEqual(['t-index']);

    h.tick();

    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.unresumed?.map((r) => r.id)).toEqual(['t-index']);
  });

  it('ages a lapsed cover from the lapse, not from the lift it answered', () => {
    // The declaration answered the lift, so the hours it stood are not hours
    // nobody read the answer. Measured from the lift the lead would be told
    // the answer had sat unread for four hours; measured from the lapse, for
    // the three it has actually been loud.
    const declaredAt = LIFT_AT + DECLARED_AFTER;
    const lapsesAfter = 60 * MIN;
    const h = loop(
      [row({ externalWait: waitOn('the fleet restart', declaredAt, lapsesAfter) })],
      lift(),
    );

    const named = (h.verdict().unresumed ?? [])[0];
    expect(named?.liftedAt, 'the stamp is the lapse').toBe(declaredAt + lapsesAfter);
    expect(named?.liftedMs, 'and the age runs from it').toBe(START - (declaredAt + lapsesAfter));
    // The control: the same row with no wait at all is aged from the lift.
    const bare = (loop([row()], lift()).verdict().unresumed ?? [])[0];
    expect(bare?.liftedAt).toBe(LIFT_AT);
    expect(bare?.liftedMs).toBe(START - LIFT_AT);
  });

  it('still names the row when a standing wait was only RENEWED after the lift', () => {
    // The mute button this rule must not be. The wait was first declared
    // twenty minutes before the answer landed, and re-stating it afterwards
    // says nothing about having read the answer — `setExternalWait` keeps
    // `since` across a same-words renewal, and `since` is what the gate reads.
    const h = loop(
      [
        row({
          externalWait: renewedWait(
            'the fleet restart',
            LIFT_AT - 20 * MIN,
            LIFT_AT + DECLARED_AFTER,
            8 * 60 * MIN,
          ),
        }),
      ],
      lift(),
    );

    expect((h.verdict().unresumed ?? []).map((r) => r.id)).toEqual(['t-index']);

    h.tick();

    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.unresumed?.map((r) => r.id)).toEqual(['t-index']);
  });

  it('treats a declaration and a report made in one turn as one action', () => {
    // Which of the two calls the server stamps first must not decide the
    // verdict, so the cover reaches back by `LIFT_CLOCK_EPSILON_MS` — the same
    // tolerance `blockage-lift.ts` spends on the lift's own row edit. The
    // third reading is the control: one millisecond further back is a
    // different turn, and the row is named.
    const covered = (since: number): string[] =>
      (
        loop(
          [row({ externalWait: waitOn('the fleet restart', since, 8 * 60 * MIN) })],
          lift(),
        ).verdict().unresumed ?? []
      ).map((r) => r.id);

    expect(covered(LIFT_AT), 'declared on the lift’s own stamp').toEqual([]);
    expect(covered(LIFT_AT - LIFT_CLOCK_EPSILON_MS), 'the far edge of one turn').toEqual([]);
    expect(covered(LIFT_AT - LIFT_CLOCK_EPSILON_MS - 1), 'one millisecond past it').toEqual([
      't-index',
    ]);
  });

  it('the control: the same row with no wait at all is named', () => {
    // Without it, the first case's silence could be a board that never wakes
    // over a lifted blockage rather than the rule under test.
    const h = loop([row()], lift());

    expect((h.verdict().unresumed ?? []).map((r) => r.id)).toEqual(['t-index']);

    h.tick();

    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.unresumed?.map((r) => r.id)).toEqual(['t-index']);
  });
});
