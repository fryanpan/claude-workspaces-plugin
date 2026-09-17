/**
 * A schedule rule may not swallow an ask.
 *
 * `classifyOpenTasks` decided two questions in one branch: a row carrying a
 * `schedule` was bucketed `scheduled-rule` before anything looked for an ask,
 * so the `blocked-on-owner-unfiled` reading — the one that exists to catch a
 * question sitting on nobody's queue — was unreachable for every rule row.
 * Raised from another board, where a comment on a scheduled row went unread
 * while the rule kept closing green.
 *
 * The two questions are now answered separately, in two modules: `bucket`
 * still says whether the row is work anyone picks up, and `owner-ask.ts` says
 * whether a person is owed an answer and can see the question. The first two
 * blocks below drive that module on its own; the rest drive the classifier
 * and the gate over it. So every case below comes in a
 * pair — the rule row, and the same row without the rule — because the claim
 * being tested is that a rule row's ask reads EXACTLY like any other row's.
 *
 * The first block is the regression the rest must not break: reading a rule
 * row as ready-unpicked sent a session at a runbook on 2026-09-07, and a rule
 * row is still never dispatched, never stalled and never counted as work in
 * flight.
 *
 * All fixtures are synthetic — invented titles and a made-up board. The repo
 * is public.
 */
import { describe, expect, it } from 'bun:test';
import { type ReviewItemRow, type TaskRow, classifyOpenTasks } from '../src/keep-moving.ts';
import { indexFiledAsks, ownerAskOf } from '../src/owner-ask.ts';
import { OWNER_UNFILED_BUCKET, evaluateStalls } from '../src/stall-gate.ts';
import type { TaskSchedule } from '@claude-workspaces/core/task-schedule';
import { WAITING_UNFILED_BUCKET, noteClockOf, noteClocks } from '../src/waiting-unfiled.ts';

const MIN = 60_000;
const now = 1_000 * MIN;
const STALL = 30 * MIN;
const bands = { dispatchable: new Set(['g1']), ownerBand: new Set(['decisions']) };
const OWNERS = ['Harborlight'];

/**
 * A rule that has ALREADY come due — armed three days ago on a daily cadence,
 * so its first occurrence sits two days behind `now`. Deliberately past-due:
 * every case below that expects a rule row to read as an ask needs the rule
 * to be owed, because a rule whose date has not arrived is a deferral rather
 * than a question (`FUTURE_RULE`). The old fixture was armed at epoch+1 with
 * a daily cadence and `now` two-thirds of a day later, which made it
 * not-yet-due by accident while nothing read dueness.
 */
const RULE: TaskSchedule = {
  rule: { kind: 'every', everyMs: 86_400_000 },
  armedAt: now - 3 * 86_400_000,
};

/** The Octoturtle shape: a one-off deferred a month out, armed an hour ago. */
const FUTURE_RULE: TaskSchedule = {
  rule: { kind: 'once', at: now + 30 * 86_400_000 },
  armedAt: now - 60 * MIN,
};

/** A row in the dispatch band that nothing has touched since it was filed. */
function quietRow(over: Partial<TaskRow> & { id: string }): TaskRow {
  return {
    title: 'Sweep the release folder',
    status: 'todo',
    goal: 'g1',
    createdAt: now - 500 * MIN,
    transitions: [{ ts: now - 500 * MIN, to: 'todo' }],
    ownerKind: 'agent',
    ...over,
  };
}

/** An open item on the person's queue, filed for `taskId`. */
function filedFor(taskId: string, askedAt = now - 90 * MIN): ReviewItemRow {
  return { taskId, askedAt, address: { kind: 'task', taskId, reviewItemId: 'ri-1' } };
}

function classify(tasks: TaskRow[], reviewItems: ReviewItemRow[] = []) {
  const out = classifyOpenTasks(tasks, [], reviewItems, now, STALL, bands);
  return new Map(out.map((r) => [r.id, r]));
}

describe('ownerAskOf — the reading, driven on its own', () => {
  it('a pending item is a filed ask whatever else is true of the task', () => {
    expect(ownerAskOf({ hasPendingAsk: true, boardSaysOwnerWaits: false, inBacklog: true })).toBe(
      'filed',
    );
  });

  it('the board saying a person waits, with nothing filed, is an unfiled ask', () => {
    expect(ownerAskOf({ hasPendingAsk: false, boardSaysOwnerWaits: true, inBacklog: false })).toBe(
      'unfiled',
    );
  });

  it('the backlog carries no ask, because there is none anyone could file', () => {
    expect(
      ownerAskOf({ hasPendingAsk: false, boardSaysOwnerWaits: true, inBacklog: true }),
    ).toBeUndefined();
  });

  it('a task nobody is waiting on reads as no ask at all, not as a filed one', () => {
    expect(
      ownerAskOf({ hasPendingAsk: false, boardSaysOwnerWaits: false, inBacklog: false }),
    ).toBeUndefined();
  });
});

describe('indexFiledAsks — which task an item was filed for', () => {
  it('reads a thread-borne item addressed as task:<id> under that id', () => {
    const asks = indexFiledAsks([{ docId: 'task:t-1', askedAt: 5 }]);
    expect(asks.has('t-1')).toBe(true);
    expect(asks.newestAt('t-1')).toBe(5);
    // Control: the raw docId is not itself a task id.
    expect(asks.has('task:t-1')).toBe(false);
  });

  it('gives the addresses newest first, and none for a task with no items', () => {
    const asks = indexFiledAsks([
      { taskId: 't-1', askedAt: 10, address: { kind: 'task', taskId: 't-1', reviewItemId: 'old' } },
      { taskId: 't-1', askedAt: 30, address: { kind: 'task', taskId: 't-1', reviewItemId: 'new' } },
      { taskId: 't-2', askedAt: 20 },
    ]);
    expect(asks.newestAt('t-1')).toBe(30);
    expect(asks.addressesFor('t-1')?.map((a) => (a.kind === 'task' ? a.reviewItemId : ''))).toEqual(
      ['new', 'old'],
    );
    // Filed, but with no address to name — not the same as not filed.
    expect(asks.has('t-2')).toBe(true);
    expect(asks.addressesFor('t-2')).toBeUndefined();
    expect(asks.has('t-3')).toBe(false);
  });

  it('drops an item that names no task at all', () => {
    const asks = indexFiledAsks([{ docId: 'doc-7', askedAt: 5 }]);
    expect(asks.has('doc-7')).toBe(false);
  });
});

describe('a rule row is still never dispatched and never stalls as work', () => {
  it('buckets an agent-owned rule row as scheduled-rule however long it has sat', () => {
    const rows = classify([
      quietRow({ id: 't-rule', schedule: RULE }),
      // Control: the same row without the rule is work, and it stalls.
      quietRow({ id: 't-plain' }),
    ]);
    expect(rows.get('t-rule')?.bucket).toBe('scheduled-rule');
    expect(rows.get('t-rule')?.stalled).toBe(false);
    expect(rows.get('t-rule')?.unfiledAsk).toBe(false);
    expect(rows.get('t-rule')?.ownerAsk).toBeUndefined();
    expect(rows.get('t-plain')?.bucket).toBe('ready-unpicked');
    expect(rows.get('t-plain')?.stalled).toBe(true);
  });

  it('the gate names it nowhere, and it spends no parallelism slot', () => {
    const verdict = evaluateStalls({
      tasks: [quietRow({ id: 't-rule', schedule: RULE }), quietRow({ id: 't-plain' })],
      events: [],
      reviewItems: [],
      bands,
      now,
      quietMs: STALL,
      // One slot, and the rule row ahead of the plain one in priority order.
      parallelismCap: 1,
      priorityOrder: ['t-rule', 't-plain'],
    });
    expect(verdict.unfiled).toHaveLength(0);
    expect(verdict.waiting).toHaveLength(0);
    // The rule row is not runnable, so it does not take the slot: the plain
    // row keeps it and is judged. Were the rule row counted as work, the
    // plain row would be beyond the cap and named nowhere.
    expect(verdict.beyondCapacity).toBe(0);
    expect(verdict.stalled.map((r) => r.id)).toEqual(['t-plain']);
  });
});

describe('an unfiled ask on a rule row reads like an unfiled ask anywhere else', () => {
  it('a person-owned rule row with nothing filed is an unfiled ask', () => {
    const rows = classify([
      quietRow({ id: 't-rule', ownerKind: 'person', schedule: RULE }),
      // Control: the same row without the rule — the reading this one was
      // unreachable for.
      quietRow({ id: 't-plain', ownerKind: 'person' }),
    ]);
    expect(rows.get('t-rule')?.ownerAsk).toBe('unfiled');
    expect(rows.get('t-rule')?.unfiledAsk).toBe(true);
    // …and the dispatch answer is unchanged.
    expect(rows.get('t-rule')?.bucket).toBe('scheduled-rule');
    expect(rows.get('t-rule')?.stalled).toBe(false);
    expect(rows.get('t-plain')?.ownerAsk).toBe('unfiled');
    expect(rows.get('t-plain')?.unfiledAsk).toBe(true);
    expect(rows.get('t-plain')?.bucket).toBe('blocked-on-owner-unfiled');
  });

  it('an owner-band rule row with nothing filed is an unfiled ask too', () => {
    const rows = classify([
      quietRow({ id: 't-rule', goal: 'decisions', schedule: RULE }),
      quietRow({ id: 't-plain', goal: 'decisions' }),
    ]);
    expect(rows.get('t-rule')?.ownerAsk).toBe('unfiled');
    expect(rows.get('t-plain')?.ownerAsk).toBe('unfiled');
  });

  it('control: a rule row in the BACKLOG asks nothing, exactly as a plain one does', () => {
    const rows = classify([
      quietRow({ id: 't-rule', goal: 'someday', ownerKind: 'person', schedule: RULE }),
      quietRow({ id: 't-plain', goal: 'someday', ownerKind: 'person' }),
    ]);
    expect(rows.get('t-rule')?.ownerAsk).toBeUndefined();
    expect(rows.get('t-rule')?.unfiledAsk).toBe(false);
    expect(rows.get('t-plain')?.ownerAsk).toBeUndefined();
    expect(rows.get('t-plain')?.bucket).toBe('backlog-unranked');
  });

  it('the gate puts it on the unfiled list under the ask word, not the rule word', () => {
    const verdict = evaluateStalls({
      tasks: [quietRow({ id: 't-rule', ownerKind: 'person', schedule: RULE })],
      events: [],
      reviewItems: [],
      bands,
      now,
      quietMs: STALL,
    });
    expect(verdict.stalled).toHaveLength(0);
    expect(verdict.unfiled.map((r) => r.id)).toEqual(['t-rule']);
    // 'scheduled-rule' here would render as "a schedule rule, whose instances
    // are the work" — the swallowing, one file downstream.
    expect(verdict.unfiled[0]?.bucket).toBe(OWNER_UNFILED_BUCKET);
  });

  it('control: inside the quiet window it is not yet a finding', () => {
    const fresh = quietRow({
      id: 't-rule',
      ownerKind: 'person',
      schedule: RULE,
      createdAt: now - 10 * MIN,
      transitions: [{ ts: now - 10 * MIN, to: 'todo' }],
    });
    const verdict = evaluateStalls({
      tasks: [fresh],
      events: [],
      reviewItems: [],
      bands,
      now,
      quietMs: STALL,
    });
    expect(verdict.unfiled).toHaveLength(0);
    expect(verdict.stalled).toHaveLength(0);
  });
});

describe('a FILED ask on a rule row is a traceable wait, not a silence', () => {
  it('carries the item address and its age, like any other waiting row', () => {
    const rows = classify(
      [
        quietRow({ id: 't-rule', ownerKind: 'person', schedule: RULE }),
        quietRow({ id: 't-plain', ownerKind: 'person' }),
      ],
      [filedFor('t-rule'), filedFor('t-plain')],
    );
    expect(rows.get('t-rule')?.ownerAsk).toBe('filed');
    expect(rows.get('t-rule')?.unfiledAsk).toBe(false);
    expect(rows.get('t-rule')?.waitingOn).toEqual([
      { kind: 'task', taskId: 't-rule', reviewItemId: 'ri-1' },
    ]);
    expect(rows.get('t-rule')?.askAgeMs).toBe(90 * MIN);
    expect(rows.get('t-rule')?.bucket).toBe('scheduled-rule');
    expect(rows.get('t-plain')?.ownerAsk).toBe('filed');
    expect(rows.get('t-plain')?.bucket).toBe('blocked-on-owner');
  });

  it('the gate lists it as waiting, by address, and as no finding', () => {
    const verdict = evaluateStalls({
      tasks: [quietRow({ id: 't-rule', ownerKind: 'person', schedule: RULE })],
      events: [],
      reviewItems: [filedFor('t-rule')],
      bands,
      now,
      quietMs: STALL,
    });
    expect(verdict.stalled).toHaveLength(0);
    expect(verdict.unfiled).toHaveLength(0);
    expect(verdict.waiting).toHaveLength(1);
    expect(verdict.waiting[0]?.waitingOn).toEqual([
      { kind: 'task', taskId: 't-rule', reviewItemId: 'ri-1' },
    ]);
  });
});

describe("a chain that bottoms out on a rule row inherits the rule row's ask", () => {
  const chain = (reviewItems: ReviewItemRow[] = []) =>
    classify(
      [
        quietRow({ id: 't-rule', ownerKind: 'person', schedule: RULE }),
        quietRow({ id: 't-behind', status: 'in-progress', after: ['t-rule'] }),
      ],
      reviewItems,
    );

  it('the row behind it is unfiled too, and names the rule row as its terminal', () => {
    const rows = chain();
    expect(rows.get('t-behind')?.bucket).toBe('blocked-on-dependency');
    expect(rows.get('t-behind')?.unfiledAsk).toBe(true);
    expect(rows.get('t-behind')?.terminal?.id).toBe('t-rule');
  });

  it('control: with the ask filed on the rule row, nothing behind it is unfiled', () => {
    const rows = chain([filedFor('t-rule')]);
    expect(rows.get('t-behind')?.unfiledAsk).toBe(false);
    expect(rows.get('t-behind')?.terminal?.id).toBe('t-rule');
  });
});

describe("a rule row's agent saying it is stuck reaches the person too", () => {
  /** The note the check reads: the agent asking a person, in its own words. */
  const WAIT_NOTE = {
    ts: now - 5 * MIN,
    kind: 'turn',
    text: 'Sweep ran clean. Waiting on Harborlight to say whether to keep the old releases.',
    agent: 'Millwright',
  };
  const PLAIN_NOTE = { ...WAIT_NOTE, text: 'Sweep ran clean. Filing the next one.' };

  const gate = (note: typeof WAIT_NOTE, reviewItems: ReviewItemRow[] = []) => {
    const row = quietRow({ id: 't-rule', schedule: RULE, notes: [note] });
    return evaluateStalls({
      tasks: [row],
      events: [],
      reviewItems,
      bands,
      now,
      quietMs: STALL,
      noteClocks: noteClocks([{ id: row.id, notes: row.notes ?? [] }], OWNERS),
    });
  };

  it('names the rule row on the unfiled list under the declared-wait word', () => {
    // The note itself is what the check reads; assert it reads as an ask
    // before asserting what the gate does with it.
    expect(noteClockOf([WAIT_NOTE], OWNERS).askedAt).toBe(WAIT_NOTE.ts);
    const verdict = gate(WAIT_NOTE);
    expect(verdict.stalled).toHaveLength(0);
    expect(verdict.unfiled.map((r) => r.bucket)).toEqual([WAITING_UNFILED_BUCKET]);
  });

  it('control: the same turn reporting rather than asking is no finding', () => {
    const verdict = gate(PLAIN_NOTE);
    expect(verdict.unfiled).toHaveLength(0);
    expect(verdict.stalled).toHaveLength(0);
  });

  it('control: the asking note with the item filed leaves a plain traceable wait', () => {
    const verdict = gate(WAIT_NOTE, [filedFor('t-rule')]);
    expect(verdict.unfiled).toHaveLength(0);
    expect(verdict.waiting).toHaveLength(1);
  });
});

/**
 * The other half of #1077, found live on a peer board the day after it
 * shipped. Reading the ask off the same facts as the bucket made every
 * FUTURE-DATED person-owned row an unfiled ask: six rows on one board were
 * named "waiting on a person with NO question filed" at 06:10 PT, scheduled
 * for dates between 2026-09-22 and 2027-01-12, and the quiet time reported
 * was just the time since the rule was armed. One of them had been deferred
 * by its owner in as many words, so an agent following the notice would
 * re-ask a question he had closed — the prescribed remedy producing the
 * failure it exists to prevent.
 *
 * A row deferred to January owes nobody an answer today. What stays is
 * #1077's actual subject: a rule row whose AGENT asks a person in its own
 * words is still readable, because those words were written now.
 */
describe('a rule whose date has not arrived defers the ask with the work', () => {
  it('ownerAskOf reads no ask on a row whose rule has not fired yet', () => {
    expect(
      ownerAskOf({
        hasPendingAsk: false,
        boardSaysOwnerWaits: true,
        inBacklog: false,
        schedule: FUTURE_RULE,
        now,
      }),
    ).toBeUndefined();
    // Control: the same facts on a rule that HAS come due still ask.
    expect(
      ownerAskOf({
        hasPendingAsk: false,
        boardSaysOwnerWaits: true,
        inBacklog: false,
        schedule: RULE,
        now,
      }),
    ).toBe('unfiled');
    // Control: and so does the same row with no rule at all, which is the
    // reading this narrowing must not touch.
    expect(
      ownerAskOf({ hasPendingAsk: false, boardSaysOwnerWaits: true, inBacklog: false, now }),
    ).toBe('unfiled');
  });

  it("an item already on the person's queue is still filed, deferred or not", () => {
    // A deferral says nothing about a question already asked: withdrawing the
    // reading here would drop the row off the `waiting` list and lose the
    // address of the item excusing it.
    expect(
      ownerAskOf({
        hasPendingAsk: true,
        boardSaysOwnerWaits: true,
        inBacklog: false,
        schedule: FUTURE_RULE,
        now,
      }),
    ).toBe('filed');
  });

  it('the classifier leaves a future-dated person-owned row asking nothing', () => {
    const rows = classify([
      quietRow({ id: 't-later', ownerKind: 'person', schedule: FUTURE_RULE }),
      // Control: the same row on a rule that has come due is still an ask.
      quietRow({ id: 't-due', ownerKind: 'person', schedule: RULE }),
    ]);
    expect(rows.get('t-later')?.ownerAsk).toBeUndefined();
    expect(rows.get('t-later')?.unfiledAsk).toBe(false);
    // …and the dispatch answer is untouched: it is still a rule row.
    expect(rows.get('t-later')?.bucket).toBe('scheduled-rule');
    expect(rows.get('t-due')?.ownerAsk).toBe('unfiled');
    expect(rows.get('t-due')?.unfiledAsk).toBe(true);
  });

  it('an owner-BAND future-dated row is equally quiet', () => {
    const rows = classify([
      quietRow({ id: 't-later', goal: 'decisions', schedule: FUTURE_RULE }),
      quietRow({ id: 't-due', goal: 'decisions', schedule: RULE }),
    ]);
    expect(rows.get('t-later')?.ownerAsk).toBeUndefined();
    expect(rows.get('t-due')?.ownerAsk).toBe('unfiled');
  });

  it('the gate names it nowhere, so no frame tells anyone to file an ask', () => {
    const verdict = evaluateStalls({
      tasks: [quietRow({ id: 't-later', ownerKind: 'person', schedule: FUTURE_RULE })],
      events: [],
      reviewItems: [],
      bands,
      now,
      quietMs: STALL,
    });
    expect(verdict.unfiled).toHaveLength(0);
    expect(verdict.stalled).toHaveLength(0);
    expect(verdict.waiting).toHaveLength(0);
  });

  it('nothing behind it inherits an ask it does not have', () => {
    const rows = classify([
      quietRow({ id: 't-later', ownerKind: 'person', schedule: FUTURE_RULE }),
      quietRow({ id: 't-behind', status: 'in-progress', after: ['t-later'] }),
    ]);
    expect(rows.get('t-behind')?.unfiledAsk).toBe(false);
    expect(rows.get('t-behind')?.terminal?.id).toBe('t-later');
  });

  it("#1077's subject survives: the agent's own words still reach the person", () => {
    // The whole point of the narrowing: board STATE about a future date is
    // not an ask, while an agent asking a person today is — on the same row.
    const note = {
      ts: now - 5 * MIN,
      kind: 'turn',
      text: 'Draft is ready. Waiting on Harborlight to pick the launch date.',
      agent: 'Millwright',
    };
    const row = quietRow({
      id: 't-later',
      ownerKind: 'person',
      schedule: FUTURE_RULE,
      notes: [note],
    });
    const verdict = evaluateStalls({
      tasks: [row],
      events: [],
      reviewItems: [],
      bands,
      now,
      quietMs: STALL,
      noteClocks: noteClocks([{ id: row.id, notes: row.notes ?? [] }], OWNERS),
    });
    expect(verdict.unfiled.map((r) => r.bucket)).toEqual([WAITING_UNFILED_BUCKET]);
  });
});
