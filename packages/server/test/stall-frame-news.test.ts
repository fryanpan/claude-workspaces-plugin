/**
 * The two readings the stall wake takes of a frame before it spends a turn.
 *
 * Unit-level, over built frames rather than through the nudger, because each
 * answer has edges the nudger cannot easily be driven into: a frame that
 * names a held item AND a moving row, a window of zero.
 *
 * A third reading lived here, `withoutPersonBlocked`, which took a row the
 * board says a person owns off the wake's copy of `unfiled`. Its cases are
 * gone with it: the gate no longer puts such a row on that list at all, and
 * `person-owned-quiet.test.ts` is where that is now asserted.
 *
 * Fixtures are synthetic; the repo is public.
 */
import { describe, expect, it } from 'bun:test';
import {
  STALL_MOVED_WITHIN_DEFAULT_MS,
  checkInTokens,
  everyNamedTaskMoved,
  rowBucketTokens,
  undeterminedTokens,
} from '../src/stall-frame-news.ts';
import type { StalledRow, UnresumedRow } from '../src/stall-gate.ts';
import { STALL_EVENT, type StallNudgeFrame } from '../src/stall-nudge.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;

function row(over: Partial<StalledRow> = {}): StalledRow {
  return {
    id: 't-1',
    title: 'Agree the rollout window',
    bucket: 'in-progress',
    quietMs: 40 * MIN,
    ...over,
  };
}

/** The same silence reading, wearing the shape the unresumed list carries. */
function lifted(from: StalledRow): UnresumedRow {
  return {
    ...from,
    lift: 'done-when-met',
    liftedAt: 1_000_000,
    liftedMs: 5 * MIN,
    what: 'The rollout window is agreed',
  };
}

function frame(over: Partial<StallNudgeFrame> = {}): StallNudgeFrame {
  return {
    event: STALL_EVENT,
    workspaceId: 'w-harbor',
    stalledCount: 1,
    consideredCount: 6,
    rows: [row()],
    ts: 1_000_000,
    ...over,
  };
}

describe('the window is an hour by default', () => {
  it('is twice the default quiet window, so a row is named on its second', () => {
    expect(STALL_MOVED_WITHIN_DEFAULT_MS).toBe(HOUR);
  });
});

describe('a frame whose every named task moved inside the window', () => {
  it('waits — nothing on it is work nobody is on', () => {
    expect(everyNamedTaskMoved(frame({ rows: [row({ quietMs: 40 * MIN })] }), HOUR)).toBe(true);
  });

  it('goes the moment ONE named task has been quiet longer', () => {
    const f = frame({ rows: [row({ quietMs: 40 * MIN }), row({ id: 't-2', quietMs: 70 * MIN })] });

    expect(everyNamedTaskMoved(f, HOUR)).toBe(false);
  });

  it('reads the unfiled and unresumed lists too, not only `rows`', () => {
    // Each list is driven BOTH ways. An empty list reads false through the
    // `quiet.length === 0` branch, which is the answer to a different
    // question — so a case that passes an empty array proves nothing about
    // whether the list is read at all.
    const quiet = { ...row({ id: 't-9', quietMs: 90 * MIN }) };
    const moving = { ...row({ id: 't-8', quietMs: 10 * MIN }) };
    expect(everyNamedTaskMoved(frame({ rows: [], unfiled: [quiet] }), HOUR)).toBe(false);
    expect(everyNamedTaskMoved(frame({ rows: [], unfiled: [moving] }), HOUR)).toBe(true);
    expect(everyNamedTaskMoved(frame({ rows: [], unresumed: [lifted(quiet)] }), HOUR)).toBe(false);
    expect(everyNamedTaskMoved(frame({ rows: [], unresumed: [lifted(moving)] }), HOUR)).toBe(true);
  });

  it('never defers a DUE CHECK-IN, whose whole window sits inside this one', () => {
    // A check-in falls due at 30 minutes and the same row is a silent builder
    // at 60. Deferring the ask to the hour does not delay it, it deletes it.
    const fresh = row({ id: 't-9', quietMs: 35 * MIN });
    expect(everyNamedTaskMoved(frame({ rows: [], checkIn: [fresh] }), HOUR)).toBe(false);
    // And it carries the stalls named beside it, exactly as a hold would.
    expect(
      everyNamedTaskMoved(frame({ rows: [row({ quietMs: 10 * MIN })], checkIn: [fresh] }), HOUR),
    ).toBe(false);
  });

  it('never holds back a frame naming something that is not a silence', () => {
    // A hold, a question asked back, an unanswered comment, a row built past
    // the UI gate, a row the pass could not read: none of them says the work
    // is moving, so none may be deferred by a clock about movement.
    const held = [{ id: 't-1', quietMs: 10 * MIN }] as unknown as StallNudgeFrame['heldItems'];
    expect(everyNamedTaskMoved(frame({ heldItems: held }), HOUR)).toBe(false);
    expect(
      everyNamedTaskMoved(
        frame({ undetermined: { count: 1, reasons: ['review-items-unreadable'] } }),
        HOUR,
      ),
    ).toBe(false);
  });

  it('is off at a window of zero, whatever the frame says', () => {
    expect(everyNamedTaskMoved(frame({ rows: [row({ quietMs: MIN })] }), 0)).toBe(false);
  });

  it('holds back nothing when the frame names no task at all', () => {
    expect(everyNamedTaskMoved(frame({ rows: [] }), HOUR)).toBe(false);
  });
});

describe('the tokens the sent set is compared over', () => {
  it('name a check-in by its row AND the window it is due in', () => {
    // Never told: its own window, and the one every check-in starts in.
    expect(checkInTokens([{ id: 't-7' }], () => undefined)).toEqual(['checkin:t-7@first']);
    // Told once: a different token, so the next window is not read as a
    // repeat of the first. Without this the row is asked about once ever.
    expect(checkInTokens([{ id: 't-7' }], () => 1_000)).toEqual(['checkin:t-7@1000']);
    expect(checkInTokens([{ id: 't-7' }], () => 2_000)).not.toEqual(
      checkInTokens([{ id: 't-7' }], () => 1_000),
    );
  });

  it('name an unreadable row by its REASON as well, so a new one is news', () => {
    expect(undeterminedTokens([{ id: 't-7', reason: 'review-items-unreadable' }])).toEqual([
      'undet:t-7:review-items-unreadable',
    ]);
    expect(undeterminedTokens([{ id: 't-7', reason: 'body-unreadable' }])).not.toEqual(
      undeterminedTokens([{ id: 't-7', reason: 'review-items-unreadable' }]),
    );
  });

  it('name a row under the bucket it was handed over in', () => {
    expect(rowBucketTokens([row({ id: 't-7', bucket: 'in-progress' })])).toEqual([
      'bucket:t-7:in-progress',
    ]);
    expect(rowBucketTokens([row({ id: 't-7', bucket: 'waiting-unfiled' })])).not.toEqual(
      rowBucketTokens([row({ id: 't-7', bucket: 'in-progress' })]),
    );
  });
});
