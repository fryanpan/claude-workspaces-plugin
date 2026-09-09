/**
 * The record a meeting's stop leaves behind, and the week the daily health
 * check reads off those records.
 *
 * The two properties that matter are the ones a rollup gets wrong quietly: a
 * meeting outside the window must not be counted, and a meeting with no
 * timing record must be reported as UNKNOWN lateness rather than folded into
 * an average as a zero. Both are asserted here on records this file wrote.
 *
 * All fixtures are invented. The repo is public.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildNotesQualityReport } from '../src/notes-quality-report.ts';
import {
  type NotesQualityRecord,
  notesQualityPath,
  notesQualityRecord,
  readNotesQuality,
  rollupNotesQuality,
  writeNotesQuality,
} from '../src/notes-quality-store.ts';

const dirs: string[] = [];
const freshDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'cw-notes-quality-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const record = (over: Partial<NotesQualityRecord> = {}): NotesQualityRecord => ({
  docId: 'd-harbour',
  meetingId: 'm-d-harbour-1',
  at: 1_000,
  bullets: 6,
  duplicateBulletLines: 0,
  duplicateHeadings: 0,
  longRuns: 0,
  unknownVoices: 0,
  ideas: 12,
  uncoveredIdeas: 2,
  uncoveredShare: 2 / 12,
  lateShare: null,
  lateMedianMs: null,
  flags: [],
  ...over,
});

describe('one meeting’s record', () => {
  it('comes back exactly as it went in', () => {
    const dir = freshDir();
    const written = record();
    expect(writeNotesQuality(dir, written)).toBe(true);
    expect(readNotesQuality(dir, written.docId, written.meetingId)).toEqual(written);
  });

  it('is not there for a meeting that never wrote one', () => {
    expect(readNotesQuality(freshDir(), 'd-harbour', 'm-nothing')).toBeUndefined();
  });

  it('reads as absent rather than throwing when the file is not JSON', () => {
    const dir = freshDir();
    writeNotesQuality(dir, record());
    Bun.write(notesQualityPath(dir, 'd-harbour', 'm-d-harbour-1'), 'not json at all');
    expect(readNotesQuality(dir, 'd-harbour', 'm-d-harbour-1')).toBeUndefined();
  });

  it('carries no words from the notes it is about', () => {
    const notes = ['## Meeting notes', '- Kestrel Lane keeps the winter crew'].join('\n');
    const dir = freshDir();
    const built = notesQualityRecord(
      'd-harbour',
      'm-d-harbour-1',
      buildNotesQualityReport({ notes, transcript: [] }),
      1_000,
    );
    writeNotesQuality(dir, built);
    const raw = readFileSync(notesQualityPath(dir, 'd-harbour', 'm-d-harbour-1'), 'utf8');
    expect(raw).not.toContain('Kestrel');
  });
});

describe('the week the health check reads', () => {
  it('counts the meetings in the window and leaves the older ones out', () => {
    const dir = freshDir();
    writeNotesQuality(dir, record({ meetingId: 'm-recent', at: 9_000 }));
    writeNotesQuality(dir, record({ meetingId: 'm-old', at: 1_000 }));
    const rollup = rollupNotesQuality(dir, { now: 10_000, windowMs: 5_000 });
    expect(rollup.meetings).toBe(1);
    expect(rollup.worst).toEqual([]);
  });

  it('names the flagged meetings and counts each bar that caught one', () => {
    const dir = freshDir();
    writeNotesQuality(
      dir,
      record({ meetingId: 'm-bad', at: 9_000, flags: ['duplicate-bullets', 'coverage'] }),
    );
    writeNotesQuality(dir, record({ meetingId: 'm-fine', at: 9_500 }));
    const rollup = rollupNotesQuality(dir, { now: 10_000, windowMs: 5_000 });
    expect(rollup.meetings).toBe(2);
    expect(rollup.flagged).toBe(1);
    expect(rollup.byFlag['duplicate-bullets']).toBe(1);
    expect(rollup.byFlag.coverage).toBe(1);
    expect(rollup.byFlag['flat-runs']).toBeUndefined();
    expect(rollup.worst.map((r) => r.meetingId)).toEqual(['m-bad']);
  });

  it('says how many meetings could say nothing about lateness', () => {
    const dir = freshDir();
    writeNotesQuality(dir, record({ meetingId: 'm-timed', at: 9_000, lateShare: 0.1 }));
    writeNotesQuality(dir, record({ meetingId: 'm-untimed', at: 9_100 }));
    const rollup = rollupNotesQuality(dir, { now: 10_000, windowMs: 5_000 });
    expect(rollup.latenessUnknown).toBe(1);
  });

  it('adds the counts up over the window', () => {
    const dir = freshDir();
    writeNotesQuality(dir, record({ meetingId: 'm-1', at: 9_000, duplicateBulletLines: 4 }));
    writeNotesQuality(dir, record({ meetingId: 'm-2', at: 9_100, duplicateBulletLines: 5 }));
    const rollup = rollupNotesQuality(dir, { now: 10_000, windowMs: 5_000 });
    expect(rollup.totals.duplicateBulletLines).toBe(9);
    expect(rollup.totals.ideas).toBe(24);
  });

  it('is an empty week rather than an error when nothing has met', () => {
    const dir = freshDir();
    expect(existsSync(join(dir, 'meetings'))).toBe(false);
    const rollup = rollupNotesQuality(dir, { now: 10_000, windowMs: 5_000 });
    expect(rollup.meetings).toBe(0);
    expect(rollup.flagged).toBe(0);
  });
});
