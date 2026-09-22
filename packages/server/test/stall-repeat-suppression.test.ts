/**
 * The frames the fleet was paying for that told nobody anything.
 *
 * A week of the fleet's transcripts put repeat or empty reminders at 11% of
 * all model spend — 265M of 2,417M tokens — and the largest single share of
 * that, 5.4%, was `workspace.stalled` frames naming exactly the task set the
 * previous frame had named. A wake is the reader's whole turn, so a frame
 * that names nothing new is a turn bought and thrown away.
 *
 * Three rules answer it here, and the file is ordered the way the work was:
 * the SURVIVAL cases first, because a suppression that also swallows a real
 * stall is worse than the repetition it removes.
 *
 *  1. A frame naming nothing the reader was not last handed is not sent.
 *  2. A frame whose every named task moved inside the moved-within window is
 *     not sent YET — it stays owed, and goes the tick a named task crosses.
 *  3. A row only a person can unblock reaches the person's queue and wakes
 *     no agent at all (`waiting-unfiled-routing.test.ts` holds that half).
 *
 * Each suppression carries its mutation control: the case that fails when the
 * guard is taken out, so a green table cannot come from a build that never
 * sent anything.
 *
 * All fixtures are synthetic — invented titles on a made-up board. The repo
 * is public.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { STALL_MOVED_WITHIN_DEFAULT_MS } from '../src/stall-frame-news.ts';
import { CHECK_IN_BUCKET, type StalledRow } from '../src/stall-gate.ts';
import {
  STALL_NUDGE_STAMP_FILENAME,
  STALL_REPEAT_DEFAULT_MS,
  type StallNudgeFrame,
  StallNudger,
  type StallSnapshot,
} from '../src/stall-nudge.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
const LEAD = 'agent-cartographer';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'stall-repeat-'));
  dirs.push(dir);
  return dir;
}

function row(id: string, quietMs: number, over: Partial<StalledRow> = {}): StalledRow {
  return { id, title: `Land ${id}`, bucket: 'in-progress', quietMs, ...over };
}

function board(over: Partial<StallSnapshot> = {}): StallSnapshot {
  return {
    workspaceId: 'w-harbor',
    leadAgentId: LEAD,
    retired: false,
    stalled: [row('t-1', 90 * MIN)],
    unfiled: [],
    considered: 4,
    undetermined: [],
    ...over,
  };
}

/**
 * One nudger over one mutable board, with the moved-within window at its
 * production default rather than off — this file's whole subject is the two
 * windows, so neither may be neutralised.
 */
function harness(opts: { stampFile?: string; start?: number; initial?: StallSnapshot } = {}) {
  const world = { now: opts.start ?? 10_000_000, boards: [opts.initial ?? board()] };
  const sent: StallNudgeFrame[] = [];
  const nudger = new StallNudger({
    now: () => world.now,
    snapshot: () => world.boards,
    canReach: () => true,
    attachedAgents: () => [LEAD],
    send: (_workspaceId, _agentId, frame) => {
      sent.push(frame);
      return 1;
    },
    report: () => {},
    ...(opts.stampFile !== undefined ? { stampFile: opts.stampFile } : {}),
  });
  return {
    world,
    sent,
    nudger,
    set: (next: StallSnapshot) => {
      world.boards[0] = next;
    },
    current: () => world.boards[0] as StallSnapshot,
    /** Move the clock, ticking every minute the way the server does, and age
     *  every named row by the same amount so a wait is a real one. */
    run: (ms: number) => {
      for (let i = 0; i < Math.floor(ms / MIN); i += 1) {
        world.now += MIN;
        const b = world.boards[0] as StallSnapshot;
        world.boards[0] = {
          ...b,
          stalled: b.stalled.map((r) => ({ ...r, quietMs: r.quietMs + MIN })),
          unfiled: b.unfiled.map((r) => ({ ...r, quietMs: r.quietMs + MIN })),
        };
        nudger.tick();
      }
    },
  };
}

// ───────────────────────── survival ─────────────────────────

describe('the wakes that must survive', () => {
  it('a NEW stall quiet for over an hour still wakes the lead', () => {
    const h = harness();

    h.nudger.tick();

    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.rows?.map((r) => r.id)).toEqual(['t-1']);
  });

  it('a set that GAINS a task wakes the lead again, inside the same window', () => {
    const h = harness();
    h.nudger.tick();
    expect(h.sent).toHaveLength(1);

    h.set({ ...h.current(), stalled: [row('t-1', 91 * MIN), row('t-2', 70 * MIN)] });
    h.world.now += MIN;
    h.nudger.tick();

    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]?.changed?.rows?.map((r) => r.id)).toEqual(['t-2']);
  });

  it('a task that left the findings for a whole window is news when it returns', () => {
    const h = harness();
    h.nudger.tick();
    expect(h.sent).toHaveLength(1);

    // Picked up and worked: off every list. The board still has a finding, so
    // nothing here is the board simply going quiet.
    h.set({ ...h.current(), stalled: [row('t-other', 90 * MIN)] });
    h.world.now += MIN;
    h.nudger.tick();
    expect(h.sent).toHaveLength(2);

    // A whole repeat window later it stops again.
    h.run(STALL_REPEAT_DEFAULT_MS + 2 * MIN);
    h.set({ ...h.current(), stalled: [row('t-other', 200 * MIN), row('t-1', 200 * MIN)] });
    h.world.now += MIN;
    h.nudger.tick();

    expect(h.sent).toHaveLength(3);
    expect(h.sent[2]?.rows?.map((r) => r.id)).toContain('t-1');
  });

  it('a frame deferred for moving work is OWED, not dropped', () => {
    // Every named task moved inside the window, so nothing goes out — and the
    // moment one crosses it, the frame that was owed is sent.
    const h = harness();
    h.set({ ...h.current(), stalled: [row('t-1', 40 * MIN)] });

    h.run(15 * MIN);
    expect(h.sent).toHaveLength(0);

    h.run(10 * MIN);

    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.rows?.map((r) => r.id)).toEqual(['t-1']);
  });
});

// ─────────────────────── suppression ────────────────────────

describe('the same list twice', () => {
  it('sends one reminder, not two', () => {
    const h = harness();

    h.nudger.tick();
    h.run(3 * STALL_REPEAT_DEFAULT_MS);

    expect(h.sent).toHaveLength(1);
  });

  it('MUTATION CONTROL: a changed list sends the second', () => {
    // The same run, with one row added partway. Without this the case above
    // would pass against a build that had simply stopped sending.
    const h = harness();

    h.nudger.tick();
    h.run(STALL_REPEAT_DEFAULT_MS);
    h.set({ ...h.current(), stalled: [...h.current().stalled, row('t-2', 80 * MIN)] });
    h.run(STALL_REPEAT_DEFAULT_MS);

    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]?.rows?.map((r) => r.id)).toContain('t-2');
  });
});

describe('across a restart', () => {
  /**
   * A deploy lands between the two ticks, and the board has got LOUDER in
   * between — the oldest row crossed another repeat window, which moves the
   * armed stamp and is the one thing that used to re-wake the lead over an
   * unchanged set. So the stamp cannot carry this case: only the sent sets,
   * written beside it, can say the reader already has these rows.
   */
  const afterDeploy = (
    stampFile: string,
  ): { first: ReturnType<typeof harness>; restart: () => ReturnType<typeof harness> } => {
    const first = harness({ stampFile });
    first.nudger.tick();
    const later = first.world.now + STALL_REPEAT_DEFAULT_MS + MIN;
    return {
      first,
      restart: () =>
        harness({
          stampFile,
          start: later,
          initial: board({ stalled: [row('t-1', 90 * MIN + STALL_REPEAT_DEFAULT_MS + MIN)] }),
        }),
    };
  };

  it('does not re-send the set the previous process delivered', () => {
    const stampFile = join(tmp(), STALL_NUDGE_STAMP_FILENAME);
    const { first, restart } = afterDeploy(stampFile);
    expect(first.sent).toHaveLength(1);

    const second = restart();
    second.nudger.tick();

    expect(second.sent).toHaveLength(0);
  });

  it('MUTATION CONTROL: with the sent sets stripped from the file it re-sends', () => {
    const stampFile = join(tmp(), STALL_NUDGE_STAMP_FILENAME);
    const { first, restart } = afterDeploy(stampFile);
    expect(first.sent).toHaveLength(1);

    const stored = JSON.parse(readFileSync(stampFile, 'utf8')) as Record<string, unknown>;
    expect(stored.sent).toBeDefined();
    // JSON.stringify omits an undefined value, so the key leaves the file.
    stored.sent = undefined;
    writeFileSync(stampFile, JSON.stringify(stored));

    const second = restart();
    second.nudger.tick();

    expect(second.sent).toHaveLength(1);
  });
});

describe('work that moved inside the window', () => {
  it('is not named while every task on the frame moved inside it', () => {
    const h = harness();
    h.set({ ...h.current(), stalled: [row('t-1', 35 * MIN), row('t-2', 40 * MIN)] });

    h.run(15 * MIN);

    expect(h.sent).toHaveLength(0);
  });

  it('MUTATION CONTROL: one task quiet past the window carries the whole frame', () => {
    const h = harness();
    h.set({
      ...h.current(),
      stalled: [row('t-1', 35 * MIN), row('t-2', 40 * MIN), row('t-old', 61 * MIN)],
    });

    h.nudger.tick();

    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.rows?.map((r) => r.id)).toContain('t-old');
  });

  it('still makes a DUE CHECK-IN, though every stall beside it moved', () => {
    // The shape the check-in's exemption from this gate exists for, and the
    // one a reviewer read as dead code. A board whose stall rows are all
    // moving would defer the whole frame — and by the time it could go, the
    // row has stopped being a check-in and become a silent builder, so the
    // ask is not delayed, it is deleted. The control below is the same board
    // with the check-in taken off: nothing goes.
    const due = { id: 't-ask', title: 'Land t-ask', bucket: CHECK_IN_BUCKET, quietMs: 35 * MIN };
    const h = harness();
    h.set({ ...h.current(), stalled: [row('t-1', 10 * MIN)], checkIn: [due] });

    h.nudger.tick();

    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.checkIn?.map((r) => r.id)).toEqual(['t-ask']);
  });

  it('MUTATION CONTROL: the same board with no check-in on it stays quiet', () => {
    const h = harness();
    h.set({ ...h.current(), stalled: [row('t-1', 10 * MIN)], checkIn: [] });

    h.nudger.tick();

    expect(h.sent).toHaveLength(0);
  });

  it('is an hour by default, and off when the window is zero', () => {
    expect(STALL_MOVED_WITHIN_DEFAULT_MS).toBe(HOUR);
    const world = { now: 10_000_000, boards: [board({ stalled: [row('t-1', 5 * MIN)] })] };
    const sent: StallNudgeFrame[] = [];
    const nudger = new StallNudger({
      movedWithinMs: 0,
      now: () => world.now,
      snapshot: () => world.boards,
      canReach: () => true,
      attachedAgents: () => [LEAD],
      send: (_w, _a, frame) => {
        sent.push(frame);
        return 1;
      },
      report: () => {},
    });

    nudger.tick();

    expect(sent).toHaveLength(1);
  });
});

describe('a row only a person can unblock', () => {
  it('is not on the frame the lead is woken with', () => {
    // The gate hands such a row over on `awaitingPerson` rather than on
    // `unfiled` (2026-09-22), so there is nothing on the lists the wake reads
    // — not for one tick and not for three repeat windows. It used to arrive
    // on `unfiled` and be filtered out here by `withoutPersonBlocked`, which
    // is the reading this case tested and the one that is gone.
    const h = harness();
    h.set({
      ...h.current(),
      stalled: [],
      unfiled: [],
      awaitingPerson: [row('t-owner', 90 * MIN, { bucket: 'blocked-on-owner-unfiled' })],
    });

    h.nudger.tick();
    h.run(3 * STALL_REPEAT_DEFAULT_MS);

    expect(h.sent).toHaveLength(0);
  });

  it('MUTATION CONTROL: the agent-declared wait on the same list still wakes', () => {
    const h = harness();
    h.set({
      ...h.current(),
      stalled: [],
      unfiled: [row('t-agent', 90 * MIN, { bucket: 'waiting-unfiled' })],
    });

    h.nudger.tick();

    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.unfiled?.map((r) => r.id)).toEqual(['t-agent']);
  });
});
