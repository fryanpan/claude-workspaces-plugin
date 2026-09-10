/**
 * What a fresh tab downloads before the board can draw its first list, and
 * the ceiling that number is not allowed to cross.
 *
 * The board's `ws:<workspaceId>` doc answers a new connection with ONE
 * sync-step-2 frame carrying the whole state, so the cost of opening a board
 * is the size of every row it holds rather than the size of the list on
 * screen. PR 848 took the live board's persisted state from 5,482,494 bytes
 * to 978,302 and its first list paint on loopback to a median of 151 ms — but
 * loopback is this Mac talking to itself. Over an emulated 50 Mbps / 25 ms
 * link the same load reads 1.3–2.0 s, over 10 Mbps / 60 ms 1.8–5.5 s, and the
 * interval whose only outstanding work is that transfer is 65–90% of it. So
 * the remaining term is the size of the frame, and nothing in CI was watching
 * it: `SlowLoadAlarm` is a RUNTIME alarm over real load reports, and its unit
 * test drives the verdict function against synthetic input — it cannot go red
 * because the board got bigger. `task-row-slim.test.ts` holds a per-row
 * ceiling for CLOSED rows over a hand-written fixture, which catches the trim
 * being weakened and nothing else.
 *
 * This is the whole-payload gate. Three things make it worth its runtime:
 *
 *   - **It drives the REAL projection — BOTH halves.** The fixture is `Task`
 *     rows and store-shaped goal rows; the bytes come out of `projectTask` +
 *     `slimClosedRow` for the rows and `projectWorkspaceFields` +
 *     `projectGoalMeta` for the board's own fields. So a field added to any
 *     of the four lands in the measurement whether or not anybody thought to
 *     add it to a fixture. The first version of this test hand-built the
 *     workspace half, which left a field added there invisible — the reason
 *     `projectWorkspaceFields` was extracted from `TaskProjection.refresh`
 *     rather than copied.
 *   - **It measures the frame, not a proxy.** `writeSyncStep2` against an
 *     empty state vector is the message the server actually sends a fresh
 *     tab, encoded by the real Yjs encoder.
 *   - **It is a byte count, not a clock.** The same number on a loaded runner
 *     as on an idle laptop — no wall-clock assertion, nothing to flake.
 *
 * The budget lives in `board-payload.baseline.json` so it moves in a diff
 * line a reviewer sees, and it is a CEILING that ratchets down, in the style
 * of `scripts/test-audit.baseline.json`. Two assertions, because they catch
 * different sizes of regression — both were run red before this landed:
 *
 *   - Dropping `notes` from `TRIMMED_ROW_FIELDS` — one word off a list — took
 *     the fixture from 722,804 bytes to 1,099,476 and failed the CEILING.
 *   - Adding one extra string field to every projected row took it to
 *     734,104, which is UNDER the ceiling's 2% headroom and failed the DRIFT
 *     check instead. That is the division of labour: the ceiling refuses a
 *     payload that is simply too big, and the drift band makes a smaller
 *     move land in the baseline diff rather than being absorbed by headroom.
 *
 * Deliberately measured RAW rather than deflated, and the distinction is
 * worth stating because it is easy to over-read this number. The doc socket
 * really does negotiate `permessage-deflate` (`socket-handlers.ts`; confirmed
 * on 2026-09-10 by a raw handshake that got
 * `Sec-WebSocket-Extensions: permessage-deflate` back, against a control
 * handshake offering nothing that got no such header), and the live board's
 * 1,006,719 bytes of state deflate to 253,839 — about 4:1. So what a reader
 * WAITS for is roughly a quarter of what this test measures.
 *
 * Raw is still the right subject for a ratchet. A fixture's compressibility
 * is a property of its filler text rather than of the board — this one
 * deflates about 16:1, because the filler repeats one sentence — so a
 * deflated budget here would ratchet a number that says nothing about the
 * real board, and would move under any zlib change. Raw bytes are what the
 * projection actually controls, and they fall and rise with it one-for-one.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import { slimClosedRow } from '../src/task-row-slim.ts';
import { projectGoalMeta, projectTask, projectWorkspaceFields } from '../src/task-row.ts';
import { FIXTURE_NOW, boardFixture } from './board-payload-fixture.ts';

const baseline = JSON.parse(
  readFileSync(join(import.meta.dir, 'board-payload.baseline.json'), 'utf8'),
) as {
  budgetBytes: number;
  measuredBytes: number;
  workspaceBytes: number;
  driftPct: number;
  rows: number;
};

/** Pinned so the update's client-block header is the same width every run.
 *  A Y.Doc mints a random clientID, which varints to between one and five
 *  bytes — the one thing in this measurement that would otherwise wobble. */
const FIXTURE_CLIENT_ID = 424_242;

const MSG_SYNC = 0;

/**
 * The `ws:` doc as `TaskProjection.refresh` builds it, and the sync-step-2
 * frame a fresh tab is answered with.
 *
 * `trim: false` is the positive control's door: it writes the same rows with
 * `slimClosedRow` skipped, which is what a regression that dropped the trim
 * would produce.
 */
function syncStep2Bytes(trim: boolean, half: 'all' | 'workspace' = 'all'): number {
  const { tasks, workspace, goalRows } = boardFixture();
  const doc = new Y.Doc();
  doc.clientID = FIXTURE_CLIENT_ID;
  doc.transact(() => {
    const tasksMap = doc.getMap('tasks');
    for (const task of half === 'workspace' ? [] : tasks) {
      const row = projectTask(task, 0, 'agent', task.assigneeId);
      tasksMap.set(task.id, trim ? slimClosedRow(row, FIXTURE_NOW) : row);
    }
    // The board's OWN fields go through the same projector `refresh` calls,
    // for the reason this whole test exists: a hand-built literal here would
    // leave the gate green when a field is added to `projectWorkspaceFields`
    // or a goal list grows. Only 1.7% of today's payload — but an unmeasured
    // 1.7% is how the next field arrives unnoticed.
    const goalMeta = new Map(
      goalRows.map((row) => [row.id, projectGoalMeta(row, 0, () => true)] as const),
    );
    const wsMap = doc.getMap('workspace');
    for (const [key, value] of Object.entries(projectWorkspaceFields(workspace, goalMeta))) {
      wsMap.set(key, value);
    }
    if (half === 'workspace') return;
    const meta = doc.getMap('meta');
    meta.set('docId', 'ws:w-fixture');
    meta.set('type', 'workspace');
    meta.set('title', workspace.name);
    meta.set('createdAt', workspace.createdAt);
  });
  // What the server writes when a client connects with nothing: the sync
  // message type, then step 2 against an empty state vector.
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MSG_SYNC);
  syncProtocol.writeSyncStep2(enc, doc, new Uint8Array([0]));
  return encoding.length(enc);
}

describe('the board sync payload budget', () => {
  const measured = syncStep2Bytes(true);

  it('stays under the recorded ceiling', () => {
    // On a failure the number is the whole message: what it reads now, what
    // it is allowed to reach, and where the line lives.
    if (measured > baseline.budgetBytes) {
      throw new Error(
        `board sync-step-2 payload is ${measured} bytes for ${baseline.rows} rows, over the ` +
          `${baseline.budgetBytes}-byte budget in packages/server/test/board-payload.baseline.json ` +
          `(recorded last at ${baseline.measuredBytes}). This is what a fresh tab downloads before ` +
          'the board draws a list. Either take the bytes back out of the projection, or raise ' +
          'budgetBytes deliberately and say in the PR body what a reader is now waiting for.',
      );
    }
    expect(measured).toBeLessThanOrEqual(baseline.budgetBytes);
  });

  it('has not drifted far from the value recorded in the baseline', () => {
    // The ratchet's other half. A change that MOVES the number without
    // crossing the ceiling — a new small field, a shorter default — should
    // still land the new reading in the baseline diff rather than being
    // absorbed by headroom. A yjs upgrade that shifts the encoding is
    // exactly the kind of thing that should show up in this diff line too.
    const drift = Math.abs(measured - baseline.measuredBytes) / baseline.measuredBytes;
    const band = baseline.driftPct / 100;
    if (drift > band) {
      throw new Error(
        `board sync-step-2 payload reads ${measured} bytes; the baseline records ` +
          `${baseline.measuredBytes} (${(drift * 100).toFixed(1)}% drift). Update measuredBytes in ` +
          'packages/server/test/board-payload.baseline.json so the change is visible in the diff.',
      );
    }
    expect(drift).toBeLessThanOrEqual(band);
  });

  it('measures the same bytes every run', () => {
    // Determinism is what lets this be a byte count rather than a range: one
    // seeded fixture, one pinned clientID, one fixed clock. Two independent
    // builds of the whole board must agree exactly.
    expect(syncStep2Bytes(true)).toBe(measured);
    expect(syncStep2Bytes(true)).toBe(measured);
  });
});

describe('the workspace half of the map', () => {
  /**
   * An EXACT byte count, and the only exact one here, because the total
   * cannot see this half.
   *
   * The `workspace` map is about 1.7% of the payload, so a new scalar field
   * on it — `schemaVersion: 3`, say — moves the total by twenty bytes out of
   * seven hundred thousand. Measured: adding one left every band above GREEN.
   * That is the hole Codex found in the first version of this test, and
   * routing the fixture through `projectWorkspaceFields` closed only half of
   * it: the projector now runs, but a change too small for the total's 1%
   * drift band still reaches the wire unremarked.
   *
   * So this half gets its own scale. Seventeen kilobytes is small enough to
   * assert to the byte, deterministic for the same reasons the total is, and
   * a field added to `projectWorkspaceFields` or `projectGoalMeta` fails here
   * whatever its size. A yjs upgrade that shifts the encoding fails it too —
   * that is a one-line baseline update, and it is the right trade for a gate
   * that can see a single added key.
   */
  it('is exactly the recorded size, so any added field is refused', () => {
    const measured = syncStep2Bytes(true, 'workspace');
    if (measured !== baseline.workspaceBytes) {
      throw new Error(
        `the board doc's workspace map is ${measured} bytes; the baseline records ` +
          `${baseline.workspaceBytes}. A field added to projectWorkspaceFields or ` +
          'projectGoalMeta lands here. If the field is intended, record the new number in ' +
          'packages/server/test/board-payload.baseline.json and say in the PR body what a ' +
          'board reader now downloads that they did not before.',
      );
    }
    expect(measured).toBe(baseline.workspaceBytes);
  });

  it('measures the same bytes every run', () => {
    expect(syncStep2Bytes(true, 'workspace')).toBe(syncStep2Bytes(true, 'workspace'));
  });
});

describe('the control — a payload nobody trimmed', () => {
  it('is far over the budget, so the fixture is heavy enough to mean something', () => {
    // Without this, a green budget proves only that the fixture was small.
    // The same 500 rows with `slimClosedRow` skipped is what the board looked
    // like before PR 848, and it must fail the gate loudly.
    const untrimmed = syncStep2Bytes(false);
    expect(untrimmed).toBeGreaterThan(baseline.budgetBytes * 2);
  });
});
