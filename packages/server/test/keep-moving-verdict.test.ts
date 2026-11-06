/**
 * The keep-moving verdict (`keep-moving-verdict.ts`): PASS or FAIL per
 * board, once per cadence, persisted. Fixtures are invented.
 */
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  KEEP_MOVING_HISTORY_KEEP,
  KeepMovingRecorder,
  keepMovingVerdictFor,
} from '../src/keep-moving-verdict.ts';
import type { TaskRow } from '../src/keep-moving.ts';
import { type HeldItemRow, type StalledRow, evaluateStalls } from '../src/stall-gate.ts';
import type { StallSnapshot } from '../src/stall-nudge.ts';

const T0 = Date.UTC(2026, 8, 8, 12, 0, 0);
const HOUR = 3_600_000;
const CADENCE = 4 * HOUR;
const HELD_OVER = 20 * 60_000;

function board(workspaceId: string, parts: Partial<StallSnapshot> = {}): StallSnapshot {
  return {
    workspaceId,
    leadAgentId: 'agent-lead',
    retired: false,
    stalled: [],
    unfiled: [],
    considered: 3,
    undetermined: [],
    ...parts,
  };
}

function row(id: string, bucket = 'in-progress'): StalledRow {
  return { id, title: `row ${id}`, bucket, quietMs: HOUR };
}

function held(reviewItemId: string, heldMs: number): HeldItemRow {
  return {
    id: 't-held',
    title: 'a ticket',
    reviewItemId,
    headline: 'an ask',
    reason: 'no stakes',
    heldMs,
    heldAt: T0 - heldMs,
    filedBy: 'Builder',
  };
}

const quiet = { heldOverMs: HELD_OVER, escalated: 0 };

describe('what a verdict says', () => {
  it('is PASS on a board with nothing wrong, and names the denominator', () => {
    const v = keepMovingVerdictFor(board('w-1'), T0, quiet);
    expect(v.verdict).toBe('PASS');
    expect(v.considered).toBe(3);
    expect(v.at).toBe(T0);
  });

  it('is FAIL for each finding on its own, naming the rows', () => {
    expect(keepMovingVerdictFor(board('w-1', { stalled: [row('t-a')] }), T0, quiet)).toMatchObject({
      verdict: 'FAIL',
      stalled: ['t-a'],
    });
    expect(
      keepMovingVerdictFor(
        board('w-1', { unfiled: [row('t-b', 'blocked-on-owner-unfiled')] }),
        T0,
        quiet,
      ),
    ).toMatchObject({ verdict: 'FAIL', unfiled: ['t-b'] });
    expect(
      keepMovingVerdictFor(
        board('w-1', { undetermined: [{ id: 't-c', reason: 'review-items-unreadable' }] }),
        T0,
        quiet,
      ),
    ).toMatchObject({ verdict: 'FAIL', unreadable: ['t-c'] });
    // The last resort, counted: an item the board filed to the reader is a
    // FAIL of the promise that nothing reaches them an agent could handle.
    expect(keepMovingVerdictFor(board('w-1'), T0, { ...quiet, escalated: 1 })).toMatchObject({
      verdict: 'FAIL',
      escalated: 1,
    });
    // A row being BUILT past the UI gate: the one finding here about work
    // that is moving, and a FAIL on its own.
    expect(
      keepMovingVerdictFor(
        board('w-1', {
          ungatedUi: [
            {
              id: 't-ui',
              title: 'move the button',
              file: 'packages/workspaces-app/src/board.css',
              from: 'dispatch' as const,
              keyword: 'button',
            },
          ],
        }),
        T0,
        quiet,
      ),
    ).toMatchObject({ verdict: 'FAIL', ungatedUi: ['t-ui'] });
    // A row whose blockage LIFTED and which nothing has touched since: the
    // answer it was waiting on is already in, so the promise "every open row
    // is moving or names its blocker" is broken here too.
    expect(
      keepMovingVerdictFor(
        board('w-1', {
          unresumed: [
            {
              id: 't-lift',
              title: 'rebuild the index nightly',
              bucket: 'in-progress',
              quietMs: 21 * HOUR,
              lift: 'review-item-answered' as const,
              liftedAt: T0 - 21 * HOUR,
              liftedMs: 21 * HOUR,
              what: 'Which key should the rebuild sort on?',
            },
          ],
        }),
        T0,
        quiet,
      ),
    ).toMatchObject({ verdict: 'FAIL', unresumed: ['t-lift'] });
  });

  it('stays PASS and names no ungated row on a board with none', () => {
    expect(keepMovingVerdictFor(board('w-1'), T0, quiet)).toMatchObject({
      verdict: 'PASS',
      ungatedUi: [],
    });
  });

  it('records a waiting row with the address of its ask, and stays PASS', () => {
    const address = { kind: 'task' as const, taskId: 't-w', reviewItemId: 'r-1' };
    const v = keepMovingVerdictFor(
      board('w-1', { waiting: [{ id: 't-w', title: 'a wait', waitingOn: [address] }] }),
      T0,
      quiet,
    );
    expect(v).toMatchObject({ verdict: 'PASS', waiting: [{ id: 't-w', waitingOn: [address] }] });
  });

  it('counts a held item only once it has stood longer than the window', () => {
    const fresh = keepMovingVerdictFor(
      board('w-1', { held: [held('r-new', HELD_OVER - 1)] }),
      T0,
      quiet,
    );
    expect(fresh).toMatchObject({ verdict: 'PASS', held: [] });
    const stale = keepMovingVerdictFor(
      board('w-1', { held: [held('r-old', HELD_OVER + 1)] }),
      T0,
      quiet,
    );
    expect(stale).toMatchObject({ verdict: 'FAIL', held: ['r-old'] });
  });
});

describe('a declared wait and the verdict', () => {
  const LAPSES_AT = T0 + HOUR;

  /** A task quiet for two hours at T0, on a dispatchable band. */
  function task(id: string, over: Partial<TaskRow> = {}): TaskRow {
    return {
      id,
      title: `Rebuild the ${id} index`,
      status: 'in-progress',
      goal: 'g1',
      createdAt: T0 - 2 * HOUR,
      transitions: [{ ts: T0 - 2 * HOUR, to: 'in-progress' }],
      ownerKind: 'agent',
      ...over,
    };
  }

  function waiting(id: string, until = LAPSES_AT): TaskRow {
    const externalWait = {
      what: 'the Riverbend queue to drain',
      since: T0 - HOUR,
      declaredAt: T0 - HOUR,
      until,
      by: 'Index Keeper',
    };
    return task(id, { externalWait });
  }

  /** The gate's own reading of the rows, shaped the way the wiring shapes it,
   *  so a lapse is decided by `until` and never set by the test. */
  function gated(tasks: TaskRow[], now: number): StallSnapshot {
    const verdict = evaluateStalls({
      tasks,
      events: [],
      reviewItems: [],
      bands: { dispatchable: new Set(['g1']), ownerBand: new Set(['decisions']) },
      now,
    });
    return board('w-1', {
      stalled: verdict.stalled,
      unfiled: verdict.unfiled,
      declaredWaits: verdict.declaredWaits,
      considered: verdict.considered,
      undetermined: verdict.undetermined,
    });
  }

  it('is PASS when every stalled row carries a standing wait, and records the waits', () => {
    const snapshot = gated([waiting('t-a'), waiting('t-b')], T0);
    // The control: the gate did read both rows as stalled, so a PASS here is
    // the verdict excusing them rather than the fixture being too young.
    expect(snapshot.stalled.map((r) => r.id).sort()).toEqual(['t-a', 't-b']);

    const v = keepMovingVerdictFor(snapshot, T0, quiet);
    expect(v.verdict).toBe('PASS');
    expect(v.stalled).toEqual([]);
    expect(v.declaredWaits.map((w) => w.id).sort()).toEqual(['t-a', 't-b']);
    expect(v.declaredWaits[0]).toMatchObject({
      what: 'the Riverbend queue to drain',
      since: T0 - HOUR,
      until: LAPSES_AT,
    });
  });

  it('is FAIL on the tick the wait lapses, naming the row', () => {
    const tasks = [waiting('t-a')];
    expect(keepMovingVerdictFor(gated(tasks, LAPSES_AT - 1), LAPSES_AT - 1, quiet).verdict).toBe(
      'PASS',
    );

    const v = keepMovingVerdictFor(gated(tasks, LAPSES_AT), LAPSES_AT, quiet);
    expect(v).toMatchObject({ verdict: 'FAIL', stalled: ['t-a'], declaredWaits: [] });
  });

  it('is FAIL for a wait whose lapse time cannot be read', () => {
    const v = keepMovingVerdictFor(gated([waiting('t-a', Number.NaN)], T0), T0, quiet);
    expect(v).toMatchObject({ verdict: 'FAIL', stalled: ['t-a'], declaredWaits: [] });
  });

  it('is FAIL for a stalled row beside a waiting one, and names only that row', () => {
    const v = keepMovingVerdictFor(gated([waiting('t-a'), task('t-b')], T0), T0, quiet);
    expect(v).toMatchObject({ verdict: 'FAIL', stalled: ['t-b'] });
    expect(v.declaredWaits.map((w) => w.id)).toEqual(['t-a']);
  });

  it('excuses no finding but the stall: an unfiled row with a standing wait is FAIL', () => {
    const wait = {
      id: 't-a',
      title: 'row t-a',
      what: 'the Riverbend queue to drain',
      since: T0 - HOUR,
      until: LAPSES_AT,
      by: 'Index Keeper',
    };
    const v = keepMovingVerdictFor(
      board('w-1', { unfiled: [row('t-a', 'waiting-unfiled')], declaredWaits: [wait] }),
      T0,
      quiet,
    );
    expect(v).toMatchObject({ verdict: 'FAIL', unfiled: ['t-a'], declaredWaits: [] });
  });

  it('counts the waits on the log line', () => {
    const lines: string[] = [];
    const r = new KeepMovingRecorder({
      cadenceMs: CADENCE,
      escalatedSince: () => 0,
      say: (l) => lines.push(l),
    });
    r.observe([gated([waiting('t-a')], T0)], T0);
    expect(lines[0]).toContain('verdict=PASS');
    expect(lines[0]).toContain('stalled=0');
    expect(lines[0]).toContain('declared-waits=1');
  });
});

describe('once per board per cadence, and no more', () => {
  const recorder = () =>
    new KeepMovingRecorder({ cadenceMs: CADENCE, escalatedSince: () => 0, say: () => {} });

  it('records every live board on the first tick and skips a retired one', () => {
    const r = recorder();
    const recorded = r.observe([board('w-1'), board('w-2', { retired: true }), board('w-3')], T0);
    expect(recorded.map((v) => v.workspaceId)).toEqual(['w-1', 'w-3']);
    expect(r.latest('w-2')).toBeUndefined();
  });

  it('records nothing inside the cadence and one verdict past it', () => {
    const r = recorder();
    r.observe([board('w-1')], T0);
    expect(r.observe([board('w-1')], T0 + CADENCE - 1)).toEqual([]);
    expect(r.observe([board('w-1')], T0 + CADENCE)).toHaveLength(1);
    expect(r.history('w-1')).toHaveLength(2);
  });

  it('reads the board as it is at recording time, not as it was', () => {
    const r = recorder();
    r.observe([board('w-1', { stalled: [row('t-a')] })], T0);
    expect(r.latest('w-1')?.verdict).toBe('FAIL');
    // The row moved; the next verdict says so.
    r.observe([board('w-1')], T0 + CADENCE);
    expect(r.latest('w-1')?.verdict).toBe('PASS');
  });

  it('asks how many items the board filed to the reader in the last day', () => {
    const asked: Array<[string, number]> = [];
    const r = new KeepMovingRecorder({
      cadenceMs: CADENCE,
      say: () => {},
      escalatedSince: (ws, since) => {
        asked.push([ws, since]);
        return 2;
      },
    });
    r.observe([board('w-1')], T0);
    expect(asked).toEqual([['w-1', T0 - 24 * HOUR]]);
    expect(r.latest('w-1')).toMatchObject({ verdict: 'FAIL', escalated: 2 });
  });

  it('keeps a week of history and drops the oldest beyond it', () => {
    const r = recorder();
    for (let i = 0; i < KEEP_MOVING_HISTORY_KEEP + 5; i += 1) {
      r.observe([board('w-1')], T0 + i * CADENCE);
    }
    const history = r.history('w-1');
    expect(history).toHaveLength(KEEP_MOVING_HISTORY_KEEP);
    expect(history[0]?.at).toBe(T0 + 5 * CADENCE);
  });

  it('logs one line per verdict with the counts', () => {
    const lines: string[] = [];
    const r = new KeepMovingRecorder({
      cadenceMs: CADENCE,
      escalatedSince: () => 0,
      say: (l) => lines.push(l),
    });
    r.observe([board('w-1', { stalled: [row('t-a')], unfiled: [row('t-b')] })], T0);
    expect(lines).toEqual([
      '[keep-moving] ws=w-1 verdict=FAIL considered=3 stalled=1 unfiled=1 awaiting-person=0 waiting=0 declared-waits=0 unreadable=0 held=0 escalated=0 ungated-ui=0 unresumed=0',
    ]);
  });
});

describe('a restart resumes the window instead of re-recording every board', () => {
  it('persists verdicts and reads them back', () => {
    const dir = mkdtempSync(join(tmpdir(), 'keep-moving-'));
    try {
      const path = join(dir, 'verdicts.json');
      const first = new KeepMovingRecorder({
        path,
        cadenceMs: CADENCE,
        escalatedSince: () => 0,
        say: () => {},
      });
      first.observe([board('w-1', { stalled: [row('t-a')] })], T0);
      expect(JSON.parse(readFileSync(path, 'utf8'))).toHaveProperty('w-1');

      const restarted = new KeepMovingRecorder({
        path,
        cadenceMs: CADENCE,
        escalatedSince: () => 0,
        say: () => {},
      });
      expect(restarted.latest('w-1')?.verdict).toBe('FAIL');
      // Inside the window still: nothing recorded on the boot tick.
      expect(restarted.observe([board('w-1')], T0 + HOUR)).toEqual([]);
      expect(restarted.observe([board('w-1')], T0 + CADENCE)).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
