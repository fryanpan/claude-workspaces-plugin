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
 *   - **It drives the REAL projection.** The fixture is `Task` rows and the
 *     bytes come out of `projectTask` + `slimClosedRow`, so a field added to
 *     the projection lands in the measurement whether or not anybody thought
 *     to add it to a fixture. That is the regression this exists for, and it
 *     is exactly what a hand-built row object cannot see.
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
 *     the fixture from 722,484 bytes to 1,099,156 and failed the CEILING.
 *   - Adding one extra string field to every projected row took it to
 *     733,784, which is UNDER the ceiling's 2% headroom and failed the DRIFT
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
import { projectTask } from '../src/task-row.ts';
import { FIXTURE_NOW, boardFixture } from './board-payload-fixture.ts';

const baseline = JSON.parse(
  readFileSync(join(import.meta.dir, 'board-payload.baseline.json'), 'utf8'),
) as { budgetBytes: number; measuredBytes: number; driftPct: number; rows: number };

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
function syncStep2Bytes(trim: boolean): number {
  const { tasks, workspace } = boardFixture();
  const doc = new Y.Doc();
  doc.clientID = FIXTURE_CLIENT_ID;
  doc.transact(() => {
    const tasksMap = doc.getMap('tasks');
    for (const task of tasks) {
      const row = projectTask(task, 0, 'agent', task.assigneeId);
      tasksMap.set(task.id, trim ? slimClosedRow(row, FIXTURE_NOW) : row);
    }
    const wsMap = doc.getMap('workspace');
    for (const [key, value] of Object.entries(workspace)) wsMap.set(key, value);
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

describe('the control — a payload nobody trimmed', () => {
  it('is far over the budget, so the fixture is heavy enough to mean something', () => {
    // Without this, a green budget proves only that the fixture was small.
    // The same 500 rows with `slimClosedRow` skipped is what the board looked
    // like before PR 848, and it must fail the gate loudly.
    const untrimmed = syncStep2Bytes(false);
    expect(untrimmed).toBeGreaterThan(baseline.budgetBytes * 2);
  });
});
