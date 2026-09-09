/**
 * The per-tick timing reader, and the one answer it must never give.
 *
 * The record it reads is written elsewhere — by the work that owns the notes
 * clocks — so the properties asserted here are the ones that hold whatever
 * that writer is doing on any given day: an absent file is `null` and not an
 * empty average, a torn line costs one row rather than the file, and only a
 * tick that actually reached the doc contributes a wait.
 *
 * The rows below are shaped like the ones `notes-timing.ts` writes, including
 * the summary object it appends when a meeting ends, which carries no tick
 * fields at all and must not be read as one.
 *
 * All fixtures are invented. The repo is public.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { latenessFrom } from '../src/notes-quality-report.ts';
import { readTickWaits, tickTimingPath } from '../src/notes-tick-timing.ts';

const dirs: string[] = [];
const freshDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'cw-tick-timing-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const writeTicks = (dir: string, lines: string[]): void => {
  const path = tickTimingPath(dir, 'd-harbour', 'm-d-harbour-1');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${lines.join('\n')}\n`);
};

/** One tick, as the timing log writes it. */
const tick = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    tick: 1,
    reason: 'pause',
    settledAt: 1_000,
    startedAt: 1_200,
    waitedMs: 0,
    promptChars: 400,
    replyChars: 90,
    firstTokenMs: null,
    composeMs: 900,
    model: 'test',
    applyMs: 40,
    edits: 1,
    blocks: 1,
    merged: 1,
    outcome: 'written',
    settledToWrittenMs: 3_500,
    ...over,
  });

describe('the tick timing record', () => {
  it('is written where the pipeline writes it', () => {
    expect(tickTimingPath('/data', 'd-hbr', 'm-1')).toBe('/data/meetings/d-hbr/m-1-timing.jsonl');
  });

  it('is null — not empty — for a meeting that wrote none', () => {
    expect(readTickWaits(freshDir(), 'd-harbour', 'm-d-harbour-1')).toBeNull();
  });

  it('turns a null reading into an unknown lateness rather than a fast one', () => {
    const waits = readTickWaits(freshDir(), 'd-harbour', 'm-d-harbour-1');
    const lateness = latenessFrom(waits ?? []);
    expect(lateness.source).toBe('unavailable');
    expect(lateness.medianMs).toBeNull();
  });

  it('takes the wait the writer already measured', () => {
    const dir = freshDir();
    writeTicks(dir, [tick()]);
    expect(readTickWaits(dir, 'd-harbour', 'm-d-harbour-1')).toEqual([{ waitMs: 3_500 }]);
  });

  it('skips a tick whose write never reached the doc', () => {
    const dir = freshDir();
    writeTicks(dir, [
      tick({ tick: 1, outcome: 'failed', settledToWrittenMs: 200 }),
      tick({ tick: 2, outcome: 'empty', settledToWrittenMs: null }),
      tick({ tick: 3, settledToWrittenMs: 1_000 }),
    ]);
    expect(readTickWaits(dir, 'd-harbour', 'm-d-harbour-1')).toEqual([{ waitMs: 1_000 }]);
  });

  it('skips a tick that carried nothing settled', () => {
    const dir = freshDir();
    writeTicks(dir, [
      tick({ tick: 1, settledAt: null, settledToWrittenMs: null }),
      tick({ tick: 2, settledToWrittenMs: 1_000 }),
    ]);
    expect(readTickWaits(dir, 'd-harbour', 'm-d-harbour-1')).toEqual([{ waitMs: 1_000 }]);
  });

  it('ignores the summary line the log appends when the meeting ends', () => {
    const dir = freshDir();
    writeTicks(dir, [
      tick({ settledToWrittenMs: 1_000 }),
      JSON.stringify({ summary: true, ticks: 1, medianMs: 1_000, worstMs: 1_000, failed: 0 }),
    ]);
    expect(readTickWaits(dir, 'd-harbour', 'm-d-harbour-1')).toEqual([{ waitMs: 1_000 }]);
  });

  it('loses one torn line rather than the whole file', () => {
    const dir = freshDir();
    writeTicks(dir, ['{"tick":1,"outcome":"written","settledToWrit', tick({ tick: 2 })]);
    expect(readTickWaits(dir, 'd-harbour', 'm-d-harbour-1')).toEqual([{ waitMs: 3_500 }]);
  });

  it('drops a backwards row instead of reporting it as an instant note', () => {
    const dir = freshDir();
    writeTicks(dir, [tick({ settledToWrittenMs: -400 })]);
    expect(readTickWaits(dir, 'd-harbour', 'm-d-harbour-1')).toEqual([]);
  });

  it('is an empty reading — not null — for a record whose ticks all failed', () => {
    const dir = freshDir();
    writeTicks(dir, [tick({ outcome: 'failed' })]);
    expect(readTickWaits(dir, 'd-harbour', 'm-d-harbour-1')).toEqual([]);
  });
});
