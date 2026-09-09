/**
 * The per-tick timing reader, and the one answer it must never give.
 *
 * The record it reads is written elsewhere — by the work that owns the notes
 * clocks — so the properties asserted here are the ones that hold whether or
 * not that record exists yet: an absent file is `null` and not an empty
 * average, a torn line costs one row rather than the file, and a row is read
 * under any of the spellings the writer might have used.
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

describe('the tick timing record', () => {
  it('is null — not empty — for a meeting that wrote none', () => {
    expect(readTickWaits(freshDir(), 'd-harbour', 'm-d-harbour-1')).toBeNull();
  });

  it('turns a null reading into an unknown lateness rather than a fast one', () => {
    const waits = readTickWaits(freshDir(), 'd-harbour', 'm-d-harbour-1');
    const lateness = latenessFrom(waits ?? []);
    expect(lateness.source).toBe('unavailable');
    expect(lateness.medianMs).toBeNull();
  });

  it('reads a wait as the gap between the settle and the write', () => {
    const dir = freshDir();
    writeTicks(dir, [JSON.stringify({ tick: 1, settledAt: 1_000, wroteAt: 4_500 })]);
    expect(readTickWaits(dir, 'd-harbour', 'm-d-harbour-1')).toEqual([{ waitMs: 3_500 }]);
  });

  it('reads the same row under the other spellings a writer might use', () => {
    const dir = freshDir();
    writeTicks(dir, [JSON.stringify({ tick: 1, turnSettledAt: 1_000, writtenAt: 2_000 })]);
    expect(readTickWaits(dir, 'd-harbour', 'm-d-harbour-1')).toEqual([{ waitMs: 1_000 }]);
  });

  it('skips a row that says only when the turn settled', () => {
    const dir = freshDir();
    writeTicks(dir, [
      JSON.stringify({ tick: 1, settledAt: 1_000 }),
      JSON.stringify({ tick: 2, settledAt: 2_000, wroteAt: 3_000 }),
    ]);
    expect(readTickWaits(dir, 'd-harbour', 'm-d-harbour-1')).toEqual([{ waitMs: 1_000 }]);
  });

  it('loses one torn line rather than the whole file', () => {
    const dir = freshDir();
    writeTicks(dir, [
      '{"tick":1,"settledAt":1000,"wrote',
      JSON.stringify({ tick: 2, settledAt: 2_000, wroteAt: 3_000 }),
    ]);
    expect(readTickWaits(dir, 'd-harbour', 'm-d-harbour-1')).toEqual([{ waitMs: 1_000 }]);
  });

  it('drops a backwards row instead of reporting it as an instant note', () => {
    const dir = freshDir();
    writeTicks(dir, [JSON.stringify({ tick: 1, settledAt: 5_000, wroteAt: 1_000 })]);
    expect(readTickWaits(dir, 'd-harbour', 'm-d-harbour-1')).toEqual([]);
  });

  it('is an empty reading — not null — for a record that held no readable row', () => {
    const dir = freshDir();
    writeTicks(dir, [JSON.stringify({ tick: 1 })]);
    expect(readTickWaits(dir, 'd-harbour', 'm-d-harbour-1')).toEqual([]);
  });
});
