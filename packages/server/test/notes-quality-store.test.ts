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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildNotesQualityReport } from '../src/notes-quality-report.ts';
import {
  type NotesQualityRecord,
  QUALITY_SERIES_LIMIT,
  notesQualityPath,
  notesQualityRecord,
  readNotesQuality,
  readNotesQualitySeries,
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

/** A file written by hand at the meeting's own path. */
const putFile = (path: string, text: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

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

  it('keeps every reading, not only the last one', () => {
    // A meeting is read once per recording LEG. On 2026-09-15 one meeting was
    // read seven times and the file held the seventh, so the six readings
    // that would have shown the verdict never changing had to be recalled
    // from somebody's memory of the log.
    const dir = freshDir();
    for (const at of [1_000, 2_000, 3_000]) writeNotesQuality(dir, record({ at, ideas: at / 100 }));
    const series = readNotesQualitySeries(dir, 'd-harbour', 'm-d-harbour-1');
    expect(series.map((r) => r.at)).toEqual([1_000, 2_000, 3_000]);
    expect(series.map((r) => r.ideas)).toEqual([10, 20, 30]);
  });

  it('answers the NEWEST reading, so every existing reader is unchanged', () => {
    const dir = freshDir();
    writeNotesQuality(dir, record({ at: 1_000, ideas: 10 }));
    writeNotesQuality(dir, record({ at: 2_000, ideas: 20 }));
    expect(readNotesQuality(dir, 'd-harbour', 'm-d-harbour-1')?.ideas).toBe(20);
  });

  it('drops the oldest readings rather than growing without bound', () => {
    const dir = freshDir();
    for (let i = 0; i < QUALITY_SERIES_LIMIT + 5; i++) writeNotesQuality(dir, record({ at: i }));
    const series = readNotesQualitySeries(dir, 'd-harbour', 'm-d-harbour-1');
    expect(series).toHaveLength(QUALITY_SERIES_LIMIT);
    expect(series[0]?.at).toBe(5);
    expect(series.at(-1)?.at).toBe(QUALITY_SERIES_LIMIT + 4);
  });

  it('reads a file written before the series existed', () => {
    // One JSON object and a newline is what the old writer left, and it is
    // one valid line of what the new one writes.
    const dir = freshDir();
    const old = record({ at: 7_000 });
    putFile(notesQualityPath(dir, old.docId, old.meetingId), `${JSON.stringify(old)}\n`);
    expect(readNotesQualitySeries(dir, old.docId, old.meetingId)).toEqual([old]);
    expect(readNotesQuality(dir, old.docId, old.meetingId)).toEqual(old);
  });

  it('still lands the new reading when every existing line is unreadable', () => {
    // A record file that has been truncated, half-written or hand-edited must
    // not cost a meeting its reading. The write is read-modify-write, so the
    // read is the step that could throw, and the new line is the one thing
    // this call exists to keep.
    const dir = freshDir();
    const r = record({ meetingId: 'm-after-corruption', at: 5_000 });
    putFile(notesQualityPath(dir, r.docId, r.meetingId), '{ truncated\nnot json either\n');
    writeNotesQuality(dir, r);
    expect(readNotesQuality(dir, r.docId, r.meetingId)).toEqual(r);
    expect(readNotesQualitySeries(dir, r.docId, r.meetingId)).toEqual([r]);
  });

  it('keeps the readings it can parse when one line is corrupt', () => {
    const dir = freshDir();
    const good = record({ at: 8_000 });
    putFile(
      notesQualityPath(dir, good.docId, good.meetingId),
      `not json at all\n${JSON.stringify(good)}\n`,
    );
    expect(readNotesQualitySeries(dir, good.docId, good.meetingId)).toEqual([good]);
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

  it('says how many meetings could say nothing about coverage', () => {
    const dir = freshDir();
    writeNotesQuality(dir, record({ meetingId: 'm-judged', at: 9_000 }));
    writeNotesQuality(
      dir,
      record({
        meetingId: 'm-unread',
        at: 9_100,
        coverageSource: 'unreadable',
        uncoveredIdeas: null,
        uncoveredShare: null,
      }),
    );
    const rollup = rollupNotesQuality(dir, { now: 10_000, windowMs: 5_000 });
    expect(rollup.coverageUnknown).toBe(1);
  });

  it('leaves a meeting whose notes were unreadable out of the coverage totals', () => {
    // BOTH halves, not just the uncovered one: counting its ideas while its
    // uncovered count is unknown moves the window's ratio by a meeting
    // nothing is known about.
    const dir = freshDir();
    writeNotesQuality(dir, record({ meetingId: 'm-judged', at: 9_000 }));
    writeNotesQuality(
      dir,
      record({
        meetingId: 'm-unread',
        at: 9_100,
        ideas: 262,
        coverageSource: 'unreadable',
        uncoveredIdeas: null,
        uncoveredShare: null,
      }),
    );
    const rollup = rollupNotesQuality(dir, { now: 10_000, windowMs: 5_000 });
    expect(rollup.totals.ideas).toBe(12);
    expect(rollup.totals.uncoveredIdeas).toBe(2);
  });

  it('leaves it out of every notes-derived total, not only the coverage pair', () => {
    // The three counts below are read off the NOTES text, which for an
    // unreadable meeting is the empty string — so each of its zeros means
    // "not measured" and summing them as "measured, and none" makes a week
    // holding one unreadable meeting read as a week whose duplicate rate
    // improved. The judged meeting's own numbers are what the totals must
    // come to.
    const dir = freshDir();
    writeNotesQuality(
      dir,
      record({
        meetingId: 'm-judged',
        at: 9_000,
        duplicateBulletLines: 3,
        duplicateHeadings: 2,
        unknownVoices: 1,
      }),
    );
    writeNotesQuality(
      dir,
      record({
        meetingId: 'm-unread',
        at: 9_100,
        bullets: 0,
        duplicateBulletLines: 0,
        duplicateHeadings: 0,
        unknownVoices: 0,
        ideas: 262,
        coverageSource: 'unreadable',
        uncoveredIdeas: null,
        uncoveredShare: null,
      }),
    );
    const rollup = rollupNotesQuality(dir, { now: 10_000, windowMs: 5_000 });
    expect(rollup.totals.duplicateBulletLines).toBe(3);
    expect(rollup.totals.duplicateHeadings).toBe(2);
    expect(rollup.totals.unknownVoices).toBe(1);
    // Still counted as a meeting, and still counted as unknown coverage —
    // which is how a reader sees the denominator those totals are over.
    expect(rollup.meetings).toBe(2);
    expect(rollup.coverageUnknown).toBe(1);
  });

  it('THE CONTROL: a readable meeting with the same zeros IS counted', () => {
    // The same two records, with the second one readable. Without this the
    // case above would pass on a rollup that had stopped adding the second
    // record for any reason at all.
    const dir = freshDir();
    writeNotesQuality(
      dir,
      record({
        meetingId: 'm-judged',
        at: 9_000,
        duplicateBulletLines: 3,
        duplicateHeadings: 2,
        unknownVoices: 1,
      }),
    );
    writeNotesQuality(
      dir,
      record({ meetingId: 'm-clean', at: 9_100, duplicateBulletLines: 4, unknownVoices: 5 }),
    );
    const rollup = rollupNotesQuality(dir, { now: 10_000, windowMs: 5_000 });
    expect(rollup.totals.duplicateBulletLines).toBe(7);
    expect(rollup.totals.unknownVoices).toBe(6);
    expect(rollup.coverageUnknown).toBe(0);
  });

  it('is an empty week rather than an error when nothing has met', () => {
    const dir = freshDir();
    expect(existsSync(join(dir, 'meetings'))).toBe(false);
    const rollup = rollupNotesQuality(dir, { now: 10_000, windowMs: 5_000 });
    expect(rollup.meetings).toBe(0);
    expect(rollup.flagged).toBe(0);
  });
});
