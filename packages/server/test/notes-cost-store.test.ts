/**
 * The rolling per-hour figure — the thing the chooser row now reads instead
 * of a string typed out of an old eval.
 *
 * The properties worth pinning are the ones that decide whether the number a
 * person sees is honest: it is weighted by meeting LENGTH rather than by
 * meeting, it forgets old meetings so a prompt change shows up, and a method
 * nobody has run is absent rather than zero.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAX_KEPT_MEETINGS,
  perHourByMethod,
  readNotesCostRecord,
  readPerHourByMethod,
  recordMeetingCost,
} from '../src/notes-cost-store.ts';

const dirs: string[] = [];
const dataDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'cw-notes-cost-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const HOUR = 3_600_000;
const meeting = (
  ms: number,
  usd: number,
  at = 1,
): { at: number; ms: number; usd: number; calls: number } => ({
  at,
  ms,
  usd,
  calls: 4,
});

describe('recording a finished meeting', () => {
  it('an hour that cost two dollars reads back as two dollars an hour', () => {
    const dir = dataDir();
    const figures = recordMeetingCost(dir, 'original', meeting(HOUR, 2));
    expect(figures.original).toBeCloseTo(2, 6);
    expect(readPerHourByMethod(dir).original).toBeCloseTo(2, 6);
  });

  it('a half-hour meeting is reported per HOUR, not per meeting', () => {
    const dir = dataDir();
    expect(recordMeetingCost(dir, 'original', meeting(HOUR / 2, 1)).original).toBeCloseTo(2, 6);
  });

  it('survives a restart: the figure is read off disk, not held in memory', () => {
    const dir = dataDir();
    recordMeetingCost(dir, 'original', meeting(HOUR, 3));
    // No shared state between these calls but the file.
    expect(readPerHourByMethod(dir).original).toBeCloseTo(3, 6);
  });

  it('weights by length, so a long expensive meeting outweighs a short cheap one', () => {
    const dir = dataDir();
    recordMeetingCost(dir, 'original', meeting(HOUR * 3, 9)); // $3/hr over 3h
    recordMeetingCost(dir, 'original', meeting(HOUR, 1)); // $1/hr over 1h
    // Weighted: $10 over 4h = $2.50/hr. A plain average of the two RATES
    // would be $2.00/hr, which is the wrong answer to "what will an hour
    // cost me".
    expect(readPerHourByMethod(dir).original).toBeCloseTo(2.5, 6);
  });

  it('a thirty-second test recording barely moves an hour-long meeting figure', () => {
    const dir = dataDir();
    recordMeetingCost(dir, 'original', meeting(HOUR, 2));
    const before = readPerHourByMethod(dir).original ?? 0;
    recordMeetingCost(dir, 'original', meeting(30_000, 0.2)); // $24/hr, 30s long
    const after = readPerHourByMethod(dir).original ?? 0;
    expect(Math.abs(after - before)).toBeLessThan(0.25);
  });

  it('keeps methods apart', () => {
    const dir = dataDir();
    recordMeetingCost(dir, 'original', meeting(HOUR, 1));
    recordMeetingCost(dir, 'ledger-opus', meeting(HOUR, 6));
    const figures = readPerHourByMethod(dir);
    expect(figures.original).toBeCloseTo(1, 6);
    expect(figures['ledger-opus']).toBeCloseTo(6, 6);
    expect(figures['ledger-haiku']).toBeUndefined();
  });

  it('forgets past the cap, so a changed prompt works through the average', () => {
    const dir = dataDir();
    for (let i = 0; i < MAX_KEPT_MEETINGS; i++)
      recordMeetingCost(dir, 'original', meeting(HOUR, 5));
    expect(readPerHourByMethod(dir).original).toBeCloseTo(5, 6);
    // Everything since costs a fifth as much. After a full cap's worth of new
    // meetings, none of the expensive ones is left.
    for (let i = 0; i < MAX_KEPT_MEETINGS; i++)
      recordMeetingCost(dir, 'original', meeting(HOUR, 1));
    expect(readNotesCostRecord(dir).meetings.original).toHaveLength(MAX_KEPT_MEETINGS);
    expect(readPerHourByMethod(dir).original).toBeCloseTo(1, 6);
  });
});

describe('what is not recorded', () => {
  it('a meeting that made no model call leaves no row — a zero would drag the figure down', () => {
    const dir = dataDir();
    recordMeetingCost(dir, 'original', meeting(HOUR, 2));
    recordMeetingCost(dir, 'original', { at: 2, ms: HOUR, usd: 0, calls: 0 });
    expect(readNotesCostRecord(dir).meetings.original).toHaveLength(1);
    expect(readPerHourByMethod(dir).original).toBeCloseTo(2, 6);
  });

  it('a meeting of no measurable length leaves no row', () => {
    const dir = dataDir();
    recordMeetingCost(dir, 'original', { at: 2, ms: 0, usd: 1, calls: 3 });
    expect(readNotesCostRecord(dir).meetings.original).toBeUndefined();
    expect(readPerHourByMethod(dir).original).toBeUndefined();
  });

  it('a method nobody has run has no figure at all, rather than a figure of zero', () => {
    expect(readPerHourByMethod(dataDir())).toEqual({});
  });
});

describe('a file that cannot be trusted', () => {
  const write = (dir: string, body: string): void => {
    mkdirSync(join(dir, 'meetings'), { recursive: true });
    writeFileSync(join(dir, 'meetings', 'notes-cost.json'), body);
  };

  it('unparseable JSON reads as no figures rather than throwing at a chooser', () => {
    const dir = dataDir();
    write(dir, '{not json');
    expect(readPerHourByMethod(dir)).toEqual({});
  });

  it('drops rows whose numbers are not numbers, so no row can print $NaN/hr', () => {
    const dir = dataDir();
    write(
      dir,
      JSON.stringify({
        meetings: {
          original: [
            { at: 1, ms: null, usd: 2, calls: 1 },
            { at: 2, ms: 'an hour', usd: 2, calls: 1 },
            { at: 3, ms: HOUR, usd: 2, calls: 1 },
          ],
        },
      }),
    );
    expect(readNotesCostRecord(dir).meetings.original).toHaveLength(1);
    expect(readPerHourByMethod(dir).original).toBeCloseTo(2, 6);
  });

  it('drops a method id this build has never heard of', () => {
    const dir = dataDir();
    write(
      dir,
      JSON.stringify({ meetings: { 'ledger-telepathy': [{ at: 1, ms: HOUR, usd: 9, calls: 1 }] } }),
    );
    expect(readPerHourByMethod(dir)).toEqual({});
  });

  it('a later write still lands, and the file is valid JSON afterwards', () => {
    const dir = dataDir();
    write(dir, 'rubbish');
    recordMeetingCost(dir, 'original', meeting(HOUR, 4));
    const raw = readFileSync(join(dir, 'meetings', 'notes-cost.json'), 'utf8');
    expect(JSON.parse(raw).meetings.original).toHaveLength(1);
    expect(readPerHourByMethod(dir).original).toBeCloseTo(4, 6);
  });
});

describe('the arithmetic on its own', () => {
  it('sums dollars over summed hours', () => {
    expect(
      perHourByMethod({
        meetings: {
          original: [
            { at: 1, ms: HOUR, usd: 1, calls: 1 },
            { at: 2, ms: HOUR, usd: 3, calls: 1 },
          ],
        },
      }).original,
    ).toBeCloseTo(2, 6);
  });
});
