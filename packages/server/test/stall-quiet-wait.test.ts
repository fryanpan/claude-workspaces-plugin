/**
 * A wait that has not changed is not news.
 *
 * The stall wake gets louder on purpose: the board's escalation bucket is its
 * oldest quiet row's silence divided by the repeat window, so a board nobody
 * is driving is named again every window it stays that way. That is the
 * owner's own number and it stays.
 *
 * What it must not do is get louder about a row whose silence the board has
 * ALREADY explained. A ticket whose review item is held, or whose reader asked
 * a question back, is quiet for a reason that belongs to somebody else — and
 * the frame already names that reason, armed on the hold or the question
 * rather than on a clock. Before `clockRows` such a ticket drove the bucket
 * too, so the lead was woken every repeat window with `changed: { escalated:
 * true }` and nothing else: the same sentence with a bigger number on it,
 * about a wait they could not move.
 *
 * So what is asserted here is silence over an UNCHANGED wait, and speech the
 * moment the wait's identity changes — a second question, a re-hold, or the
 * wait clearing. The control at the bottom is the other half: a plain stalled
 * row, with no wait on it, must still be re-said every window.
 *
 * All fixtures are synthetic — invented titles in a made-up workspace. The
 * repo is public.
 */
import { describe, expect, it } from 'bun:test';
import type { AskedBackRow, HeldItemRow, StalledRow } from '../src/stall-gate.ts';
import {
  STALL_REPEAT_DEFAULT_MS,
  type StallNudgeFrame,
  StallNudger,
  type StallSnapshot,
} from '../src/stall-nudge.ts';

const MIN = 60_000;
const START = 1_000_000;

/** The ticket every case here is about: quiet long enough to be named. */
function quietRow(over: Partial<StalledRow> = {}): StalledRow {
  return {
    id: 't-rollout',
    title: 'Agree the rollout window',
    bucket: 'in-progress',
    quietMs: 45 * MIN,
    ...over,
  };
}

/** A question a reader asked back on that ticket's review item. */
function askedBackOn(over: Partial<AskedBackRow> = {}): AskedBackRow {
  return {
    id: 't-rollout',
    title: 'Agree the rollout window',
    reviewItemId: 'ri-1',
    headline: 'Which window do you want?',
    askedBy: 'Reader',
    askedAt: START - 40 * MIN,
    askedMs: 40 * MIN,
    revise: 'revise_review_item(...)',
    ...over,
  };
}

/** A review item the quality gate is holding on that ticket. */
function heldOn(over: Partial<HeldItemRow> = {}): HeldItemRow {
  return {
    id: 't-rollout',
    title: 'Agree the rollout window',
    reviewItemId: 'ri-1',
    headline: 'ok?',
    reason: 'The headline is not a question the reader can answer.',
    heldMs: 40 * MIN,
    heldAt: START - 40 * MIN,
    filedBy: 'Index Keeper',
    filerAgentId: 'agent-index-keeper',
    ...over,
  };
}

function board(over: Partial<StallSnapshot> = {}): StallSnapshot {
  return {
    workspaceId: 'w-atlas',
    leadAgentId: 'agent-cartographer',
    retired: false,
    stalled: [quietRow()],
    unfiled: [],
    considered: 4,
    undetermined: [],
    ...over,
  };
}

/**
 * One nudger over one mutable board, with a clock the test moves.
 *
 * `windows(n)` walks the clock forward n repeat windows, ticking twice per
 * window and ageing the named rows by the same amount — the board's own tick
 * is more frequent than its repeat window, so a wake owed only to the clock
 * shows up as an extra frame rather than as a missed one.
 */
function harness(initial: StallSnapshot = board()) {
  const world = { now: START, boards: [initial] };
  const sent: StallNudgeFrame[] = [];
  const nudger = new StallNudger({
    now: () => world.now,
    snapshot: () => world.boards,
    canReach: () => true,
    attachedAgents: () => ['agent-cartographer'],
    send: (_workspaceId, _agentId, frame) => {
      sent.push(frame);
      return 1;
    },
    report: () => {},
  });
  const age = (by: number): void => {
    const current = world.boards[0] as StallSnapshot;
    world.boards[0] = {
      ...current,
      stalled: current.stalled.map((row) => ({ ...row, quietMs: row.quietMs + by })),
      unfiled: current.unfiled.map((row) => ({ ...row, quietMs: row.quietMs + by })),
      ...(current.held
        ? { held: current.held.map((item) => ({ ...item, heldMs: item.heldMs + by })) }
        : {}),
      ...(current.askedBack
        ? { askedBack: current.askedBack.map((item) => ({ ...item, askedMs: item.askedMs + by })) }
        : {}),
    };
  };
  return {
    sent,
    nudger,
    set: (next: StallSnapshot) => {
      world.boards[0] = next;
    },
    current: () => world.boards[0] as StallSnapshot,
    tick: () => nudger.tick(),
    windows: (count: number) => {
      const step = STALL_REPEAT_DEFAULT_MS / 2;
      for (let i = 0; i < count * 2; i++) {
        world.now += step;
        age(step);
        nudger.tick();
      }
    },
  };
}

describe('a ticket waiting on a question its reader asked back', () => {
  it('is named once, then says nothing for three repeat windows', () => {
    const h = harness(board({ askedBack: [askedBackOn()] }));

    h.tick();
    expect(h.sent).toHaveLength(1);
    // Named, not hidden: the lead is told what the silence is and which call
    // ends it. The filter is about the REPEAT, never about the first telling.
    expect(h.sent[0]?.askedBack?.[0]?.reviewItemId).toBe('ri-1');
    expect(h.sent[0]?.rows?.[0]?.id).toBe('t-rollout');

    h.windows(3);

    expect(h.sent).toHaveLength(1);
  });

  it('speaks again when the reader asks a SECOND question — a different wait', () => {
    const h = harness(board({ askedBack: [askedBackOn()] }));
    h.tick();
    h.windows(2);
    expect(h.sent).toHaveLength(1);

    // A new question on the same item: a different `askedAt`, so a different
    // wait, so the lead hears at the next tick rather than at the next window.
    h.set({
      ...h.current(),
      askedBack: [askedBackOn({ askedAt: START + 10 * MIN, askedMs: 5 * MIN })],
    });
    h.tick();

    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]?.changed?.askedBack?.[0]?.askedAt).toBe(START + 10 * MIN);
  });

  it('escalates again once the question is gone and the row is a plain stall', () => {
    const h = harness(board({ askedBack: [askedBackOn()] }));
    h.tick();
    h.windows(2);
    expect(h.sent).toHaveLength(1);

    // The filer revised: the question is off the board, and the ticket's
    // silence is nobody else's any more. The ordinary clock resumes.
    h.set({ ...h.current(), askedBack: [] });
    h.windows(2);

    expect(h.sent.length).toBeGreaterThan(1);
    expect(h.sent[h.sent.length - 1]?.changed?.escalated).toBe(true);
  });
});

describe('a ticket waiting on a held review item', () => {
  it('is named once, then says nothing for three repeat windows', () => {
    const h = harness(board({ held: [heldOn()] }));

    h.tick();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.heldItems?.[0]?.reviewItemId).toBe('ri-1');

    h.windows(3);

    expect(h.sent).toHaveLength(1);
  });

  it('speaks again when the item is revised and held AGAIN — a new hold', () => {
    const h = harness(board({ held: [heldOn()] }));
    h.tick();
    h.windows(2);
    expect(h.sent).toHaveLength(1);

    // Past the lead's window again — a hold younger than that is still the
    // filer's alone and never reaches this frame.
    h.set({ ...h.current(), held: [heldOn({ heldAt: START + 10 * MIN, heldMs: 45 * MIN })] });
    h.tick();

    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]?.changed?.heldItems?.[0]?.heldAt).toBe(START + 10 * MIN);
  });
});

describe('a long wait beside a short stall', () => {
  // The high-water mark has to be filtered too, not just the stamp. It holds
  // the board's bucket UP while the row that set it is still remembered, so a
  // finding flickering off the list for one pass cannot make its own return
  // read as an escalation. Let a waiting ticket set that mark and it holds the
  // board at ITS number — five hours of somebody else's wait — and the plain
  // stall beside it can never climb high enough to be re-said at all.
  it("does not let the wait swallow the plain stall's own escalation", () => {
    const h = harness(
      board({
        stalled: [
          quietRow({ id: 't-plain', title: 'Trim the index writer', quietMs: 10 * MIN }),
          quietRow({ id: 't-rollout', quietMs: 300 * MIN }),
        ],
        held: [heldOn()],
      }),
    );

    h.tick();
    expect(h.sent).toHaveLength(1);

    h.windows(2);

    const last = h.sent[h.sent.length - 1];
    expect(h.sent.length).toBeGreaterThan(1);
    expect(last?.changed?.escalated).toBe(true);
  });
});

describe('a row whose ask is filed and pending', () => {
  // Disjoint from the named lists today — `stall-gate.ts` sorts a row into
  // exactly one — so this pins the defensive half: were a classifier change
  // ever to name such a row, it still must not put the clock back.
  it('does not drive the clock even when it is also named', () => {
    const h = harness(
      board({
        stalled: [quietRow({ id: 't-palette', title: 'Pick the palette' })],
        waiting: [
          {
            id: 't-palette',
            title: 'Pick the palette',
            waitingOn: [{ kind: 'task', taskId: 't-palette', reviewItemId: 'ri-2' }],
          },
        ],
      }),
    );

    h.tick();
    expect(h.sent).toHaveLength(1);

    h.windows(3);

    expect(h.sent).toHaveLength(1);
  });
});

describe('a row queued behind the parallelism cap', () => {
  // The gate never judges such a row (`stall-gate.ts` counts it and moves on;
  // `stall-gate.test.ts` pins that). What is pinned HERE is the other half:
  // the count it leaves on the frame must not arm a wake by itself, or a cap
  // that moves would re-report rows nobody was supposed to be on.
  it('never arms a wake by itself, however the count moves', () => {
    const h = harness(board({ stalled: [], beyondCapacity: 17, parallelismCap: { value: 2 } }));

    h.tick();
    expect(h.sent).toHaveLength(0);

    h.set({ ...h.current(), beyondCapacity: 19 });
    h.windows(3);

    expect(h.sent).toHaveLength(0);
  });

  it('does not stop the board escalating over a row the lead CAN act on', () => {
    const h = harness(board({ beyondCapacity: 17, parallelismCap: { value: 2 } }));

    h.tick();
    h.windows(2);

    // The stalled row still gets louder; the 17 beyond the cap ride along in
    // the frame without ever being the reason for one.
    expect(h.sent.length).toBeGreaterThan(1);
    expect(h.sent[1]?.changed?.escalated).toBe(true);
    expect(h.sent[1]?.beyondCapacity).toBe(17);
  });
});

describe('the control: a plain stall still gets louder', () => {
  // The half this change must not break. A row with no wait on it is the
  // lead's to move, and the owner asked to hear about it again every half
  // hour it stays put (2026-09-11).
  it('is re-said every repeat window', () => {
    const h = harness();

    h.tick();
    expect(h.sent).toHaveLength(1);

    h.windows(3);

    expect(h.sent.length).toBeGreaterThan(3);
    for (const frame of h.sent.slice(1)) expect(frame.changed?.escalated).toBe(true);
  });
});
