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
import type { AskedBackRow, DeclaredWaitRow, HeldItemRow, StalledRow } from '../src/stall-gate.ts';
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
    leadAgentId: 'agent-lead',
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
    // Off: this file's subject is not the moved-within-the-hour rule
    // (`stall-frame-news.test.ts`), and its fixtures are younger than an hour.
    movedWithinMs: 0,
    now: () => world.now,
    snapshot: () => world.boards,
    canReach: () => true,
    attachedAgents: () => ['agent-lead'],
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

  it('says nothing more once the question is gone and the row is a plain stall', () => {
    const h = harness(board({ askedBack: [askedBackOn()] }));
    h.tick();
    h.windows(2);
    expect(h.sent).toHaveLength(1);

    // The filer revised: the question is off the board, and the ticket's
    // silence is nobody else's any more. The lead was handed this ticket in
    // the first frame, so there is nothing left to hand it — the row losing
    // one of its two readings names LESS than last time, and less is never
    // news (`wake-sent-sets.ts`).
    h.set({ ...h.current(), askedBack: [] });
    h.windows(2);

    expect(h.sent).toHaveLength(1);
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
  it('still speaks for the plain stall the moment its own list changes', () => {
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

    // Two windows of pure ageing. Nothing joined the list, so nothing is said
    // — the escalation clock no longer sends by itself.
    h.windows(2);
    expect(h.sent).toHaveLength(1);

    // A row the lead has not been handed, though, is through at once: the
    // five-hour wait beside it holds nothing down.
    h.set({
      ...h.current(),
      stalled: [
        ...h.current().stalled,
        quietRow({ id: 't-new', title: 'Rebuild the shard index', quietMs: 40 * MIN }),
      ],
    });
    h.tick();

    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]?.rows?.map((row) => row.id)).toContain('t-new');
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

describe('a row carrying a DECLARED wait on something off the board', () => {
  // The case the other three could not cover. `t-rollout` here has no held
  // item, no question asked back and nothing on anybody's Home queue: its
  // holder has simply said, in words, that it is waiting on a thing the board
  // cannot see. Before this the row was a plain stall — measured at seven
  // frames over six windows, every one of them `changed: { escalated: true }`
  // and nothing else.
  const declared = (over: Partial<DeclaredWaitRow> = {}): DeclaredWaitRow => ({
    id: 't-rollout',
    title: 'Agree the rollout window',
    what: 'the fleet restart, then a peer filing the follow-up',
    since: START - 20 * MIN,
    until: START + 4 * 60 * MIN,
    by: 'Team Lead',
    ...over,
  });

  it('is never named while it stands, across three repeat windows', () => {
    // A standing wait is not a finding. The frame used to name the row once
    // under "stopped moving" and then fall quiet; a board whose only quiet
    // row is waiting now wakes nobody at all.
    const h = harness(board({ declaredWaits: [declared()] }));

    h.tick();
    h.windows(3);

    expect(h.sent).toHaveLength(0);
  });

  it('comes back loud the moment the declaration LAPSES', () => {
    // The anti-mute property. The silence a declaration buys is deferred,
    // never cancelled: the row returns as a finding on the lapse tick itself,
    // carrying every minute it accumulated.
    const h = harness(board({ declaredWaits: [declared()] }));
    h.tick();
    h.windows(3);
    expect(h.sent).toHaveLength(0);

    h.set({ ...h.current(), declaredWaits: [declared({ lapsed: true })] });
    h.tick();

    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.rows?.[0]?.id).toBe('t-rollout');
    // …and the frame says which sentence ran out, so the lead knows why the
    // row got loud rather than only that it did.
    expect(h.sent[0]?.declaredWaits?.[0]?.lapsed).toBe(true);
    expect(h.sent[0]?.declaredWaits?.[0]?.what).toBe(
      'the fleet restart, then a peer filing the follow-up',
    );
  });

  it('speaks once the wait is cleared, and then only once', () => {
    const h = harness(board({ declaredWaits: [declared()] }));
    h.tick();
    h.windows(2);
    expect(h.sent).toHaveLength(0);

    h.set({ ...h.current(), declaredWaits: [] });
    h.windows(2);

    // The row is a finding again, so the lead hears about it — and hears
    // about it ONCE, however many windows the clock then crosses.
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.rows?.map((row) => row.id)).toEqual(['t-rollout']);
  });

  it('does NOT quieten a row waiting on a person with nothing filed', () => {
    // The mute-button guard. `unfiled` is a protocol violation whose remedy —
    // file the ask — is the lead's and available right now, so a sentence
    // about waiting on something else annotates it and never excuses it.
    const h = harness(
      board({
        stalled: [],
        unfiled: [quietRow({ id: 't-palette', title: 'Pick the palette' })],
        declaredWaits: [declared({ id: 't-palette', title: 'Pick the palette' })],
      }),
    );

    h.tick();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.unfiled?.map((row) => row.id)).toEqual(['t-palette']);

    // Named despite the sentence — and then not re-named, because the list
    // does not change. The annotation never becomes a mute button; the
    // repeat it used to prove is now the sent-set rule's business.
    h.windows(3);
    expect(h.sent).toHaveLength(1);
  });

  it("does not let one row's declared wait swallow another row's arrival", () => {
    // The high-water mark is filtered with the stamp, so a five-hour declared
    // wait must not hold the board's bucket up where a short plain stall
    // beside it can never climb high enough to be re-said. Same failure the
    // held-item case pins one describe up.
    const h = harness(
      board({
        stalled: [
          quietRow({ id: 't-plain', title: 'Trim the index writer', quietMs: 10 * MIN }),
          quietRow({ id: 't-rollout', quietMs: 300 * MIN }),
        ],
        declaredWaits: [declared()],
      }),
    );

    h.tick();
    expect(h.sent).toHaveLength(1);

    h.windows(2);
    expect(h.sent).toHaveLength(1);

    h.set({
      ...h.current(),
      stalled: [
        ...h.current().stalled,
        quietRow({ id: 't-new', title: 'Rebuild the shard index', quietMs: 40 * MIN }),
      ],
    });
    h.tick();

    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]?.rows?.map((row) => row.id)).toContain('t-new');
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

  it('does not stop the board speaking over a row the lead CAN act on', () => {
    const h = harness(board({ beyondCapacity: 17, parallelismCap: { value: 2 } }));

    h.tick();

    // The stalled row is named; the 17 beyond the cap ride along in the frame
    // without ever being the reason for one.
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.rows?.map((row) => row.id)).toEqual(['t-rollout']);
    expect(h.sent[0]?.beyondCapacity).toBe(17);

    h.windows(2);
    expect(h.sent).toHaveLength(1);
  });
});

/**
 * The control, and the owner decision it used to carry.
 *
 * This describe asserted the other half of the wait rules: a row with no wait
 * on it is the lead's to move, and the owner asked to hear about it again
 * every half hour it stayed put (2026-09-11). That repeat is RETIRED. A week
 * of the fleet's transcripts put `workspace.stalled` frames naming exactly the
 * previous frame's task set at 5.4% of all model spend, and the half-hourly
 * re-say was where almost all of it came from: the same sentence with a bigger
 * number on it. The wake now fires on the list changing and on nothing else.
 *
 * So the control below is inverted on purpose — it pins the silence, and the
 * survival half (a list that GAINS a row still speaks at once) is pinned in
 * `stall-repeat-suppression.test.ts`.
 */
describe('the control: a plain stall is said once', () => {
  it('is not re-said while its list does not change', () => {
    const h = harness();

    h.tick();
    expect(h.sent).toHaveLength(1);

    h.windows(3);

    expect(h.sent).toHaveLength(1);
  });
});
