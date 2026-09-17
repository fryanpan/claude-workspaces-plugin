/**
 * The ready_idle wake the lead had already been handed.
 *
 * The armed stamp holds `lastActivityAt`, so ANY activity on the board rearms
 * the wake: work the board a little, let it go quiet again, and the lead is
 * woken with the same ready list it was woken with before. A week of the
 * fleet's transcripts put repeat or empty reminders at 11% of all model spend,
 * and these repeats were part of it.
 *
 * So a second frame naming nothing the reader was not last handed is not sent
 * (`wake-sent-sets.ts`). The survival cases come first, because a suppression
 * that swallows a real wake is worse than the repetition it removes, and each
 * suppression carries the control that fails when the guard is taken out.
 *
 * The ticks are every minute, as the server's are. That matters: a row is
 * forgotten only after a whole idle window with nobody LOOKING at it, and a
 * test that jumps the clock instead of ticking measures the forgetting rather
 * than the suppression.
 *
 * All fixtures are synthetic — invented titles on a made-up board. The repo is
 * public.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type NudgeFrame,
  READY_IDLE_DEFAULT_MS,
  READY_NUDGE_STAMP_FILENAME,
  ReadyWorkNudger,
  type ReadyWorkSnapshot,
} from '../src/ready-nudge.ts';

const MIN = 60_000;
const LEAD = 'agent-cartographer';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ready-repeat-'));
  dirs.push(dir);
  return dir;
}

function board(over: Partial<ReadyWorkSnapshot> = {}): ReadyWorkSnapshot {
  return {
    workspaceId: 'w-harbor',
    leadAgentId: LEAD,
    retired: false,
    ready: [{ id: 't-1', title: 'Rank results by recency' }],
    considered: 1,
    held: {},
    undetermined: [],
    lastActivityAt: 0,
    ...over,
  };
}

function harness(opts: { stampFile?: string; start?: number; sinks?: () => number } = {}) {
  const world = { now: opts.start ?? 10_000_000, boards: [board()] };
  const sent: NudgeFrame[] = [];
  const nudger = new ReadyWorkNudger({
    now: () => world.now,
    snapshot: () => world.boards,
    lookup: (id) => world.boards.find((b) => b.workspaceId === id),
    canReach: () => true,
    send: (_workspaceId, _agentId, frame) => {
      sent.push(frame);
      return opts.sinks ? opts.sinks() : 1;
    },
    report: () => {},
    ...(opts.stampFile !== undefined ? { stampFile: opts.stampFile } : {}),
  });
  return {
    world,
    sent,
    nudger,
    current: () => world.boards[0] as ReadyWorkSnapshot,
    set: (next: ReadyWorkSnapshot) => {
      world.boards[0] = next;
    },
    /** Somebody worked the board: the idle clock restarts and the stamp moves. */
    worked: () => {
      (world.boards[0] as ReadyWorkSnapshot).lastActivityAt = world.now;
      nudger.noteActivity('w-harbor', world.now);
    },
    /** The server's own cadence — one tick a minute. */
    run: (ms: number) => {
      for (let i = 0; i < Math.floor(ms / MIN); i += 1) {
        world.now += MIN;
        nudger.tick();
      }
    },
  };
}

/** Idle from the start, so the first tick is already owed a wake. */
function idleFromTheStart(h: ReturnType<typeof harness>): void {
  h.current().lastActivityAt = h.world.now - 2 * READY_IDLE_DEFAULT_MS;
}

// ───────────────────────── survival ─────────────────────────

describe('the wakes that must survive', () => {
  it('a board idle past its window wakes the lead', () => {
    const h = harness();
    idleFromTheStart(h);

    h.nudger.tick();

    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.taskId).toBe('t-1');
  });

  it('a ready set that GAINS a task wakes the lead again', () => {
    const h = harness();
    idleFromTheStart(h);
    h.nudger.tick();
    expect(h.sent).toHaveLength(1);

    h.set({
      ...h.current(),
      ready: [
        { id: 't-1', title: 'Rank results by recency' },
        { id: 't-2', title: 'Cache the facet counts' },
      ],
      considered: 2,
    });
    h.run(MIN);

    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]?.readyCount).toBe(2);
  });

  it('a board that went quiet for a whole window with nobody looking is news again', () => {
    // Nothing ticks while the server is down or the board is off the sweep, so
    // the reader's memory of the set ages out and the row is a fresh telling.
    const h = harness();
    idleFromTheStart(h);
    h.nudger.tick();
    expect(h.sent).toHaveLength(1);

    h.world.now += 2 * READY_IDLE_DEFAULT_MS;
    h.worked();
    h.world.now += 2 * READY_IDLE_DEFAULT_MS;
    h.nudger.tick();

    expect(h.sent).toHaveLength(2);
  });
});

// ─────────────────────── suppression ────────────────────────

describe('a board worked and left idle again', () => {
  it('does not wake the lead a second time with the same ready list', () => {
    const h = harness();
    idleFromTheStart(h);
    h.nudger.tick();
    expect(h.sent).toHaveLength(1);

    // Somebody touches the board — which is all it used to take, because the
    // armed stamp carries `lastActivityAt`.
    h.run(2 * MIN);
    h.worked();
    h.run(2 * READY_IDLE_DEFAULT_MS);

    expect(h.sent).toHaveLength(1);
  });

  it('MUTATION CONTROL: the same run with the list changed sends the second', () => {
    const h = harness();
    idleFromTheStart(h);
    h.nudger.tick();
    expect(h.sent).toHaveLength(1);

    h.run(2 * MIN);
    h.worked();
    h.set({
      ...h.current(),
      ready: [{ id: 't-9', title: 'Retire the old index' }],
    });
    h.run(2 * READY_IDLE_DEFAULT_MS);

    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]?.taskId).toBe('t-9');
  });
});

describe('a frame that reached nobody', () => {
  it('is not remembered as handed over, so the list is said again', () => {
    // `canReach` said yes and the send delivered nothing — a stream that went
    // away between the two. The stamp re-arms on the next activity either
    // way; what must not happen is this list being buried for good.
    let sinks = 0;
    const h = harness({ sinks: () => sinks });
    idleFromTheStart(h);
    h.nudger.tick();
    expect(h.sent).toHaveLength(1);

    sinks = 1;
    h.run(2 * MIN);
    h.worked();
    h.run(2 * READY_IDLE_DEFAULT_MS);

    expect(h.sent).toHaveLength(2);
  });

  it('MUTATION CONTROL: the same run with the frame DELIVERED is said once', () => {
    const h = harness({ sinks: () => 1 });
    idleFromTheStart(h);
    h.nudger.tick();
    expect(h.sent).toHaveLength(1);

    h.run(2 * MIN);
    h.worked();
    h.run(2 * READY_IDLE_DEFAULT_MS);

    expect(h.sent).toHaveLength(1);
  });
});

describe('across a restart', () => {
  /**
   * A deploy lands, and the board is worked across it — so the armed stamp
   * moves and cannot be what holds the second wake back. Only the sent sets,
   * written beside it, can say the lead already has this list.
   */
  const afterDeploy = (stampFile: string) => {
    const first = harness({ stampFile });
    idleFromTheStart(first);
    first.nudger.tick();
    first.run(2 * MIN);
    first.worked();
    const later = first.world.now + 2 * READY_IDLE_DEFAULT_MS;
    return {
      first,
      restart: () => {
        const second = harness({ stampFile, start: later });
        second.current().lastActivityAt = later - 2 * READY_IDLE_DEFAULT_MS;
        return second;
      },
    };
  };

  it('does not re-send the list the previous process delivered', () => {
    const stampFile = join(tmp(), READY_NUDGE_STAMP_FILENAME);
    const { first, restart } = afterDeploy(stampFile);
    expect(first.sent).toHaveLength(1);

    const second = restart();
    second.nudger.tick();

    expect(second.sent).toHaveLength(0);
  });

  it('MUTATION CONTROL: with the sent sets stripped from the file it re-sends', () => {
    const stampFile = join(tmp(), READY_NUDGE_STAMP_FILENAME);
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
