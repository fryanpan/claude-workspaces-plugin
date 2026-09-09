/**
 * The reader, driven over a file the real writer really wrote.
 *
 * WHY A SECOND FILE. Every other case in `notes-tick-timing.test.ts` is a row
 * this repo composed to make a point, which means the whole suite could agree
 * with itself and disagree with the pipeline. `fixtures/notes-timing-replay.jsonl`
 * is not invented: it came out of `notes-timing.ts` driving the real notes
 * pipeline over a real 169-turn meeting through the replay tool, 71 tick rows
 * and the summary line it appends at the end. If the writer's shape ever moves
 * away from what this reader parses, this is the test that notices.
 *
 * It carries no meeting words. The replay redacts every word before the
 * pipeline sees it, and the file holds four distinct string values in total —
 * `cadence`, `end`, `written`, and one hypothesis label — every one of them
 * written by this repo rather than said by a person. That is asserted below,
 * so a future fixture that carried speech would fail rather than land quietly
 * in a public repo.
 *
 * The replay composes with a stub, so `composeMs`, `applyMs`, `promptChars`,
 * `replyChars`, `model` and `firstTokenMs` are zero or null throughout. That
 * is a feature here: it drives the reader over the null-heavy rows a real
 * artifact contains and a hand-written fixture tends not to.
 */

import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { latenessFrom } from '../src/notes-quality-report.ts';
import { LATE_NOTE_MS } from '../src/notes-quality-thresholds.ts';
import { readTickWaits, tickTimingPath } from '../src/notes-tick-timing.ts';

const FIXTURE = join(import.meta.dir, 'fixtures', 'notes-timing-replay.jsonl');

/** The fixture, placed where a meeting's own timing record would sit. */
function meetingWithRealTiming(): { dataDir: string; docId: string; meetingId: string } {
  const dataDir = mkdtempSync(join(tmpdir(), 'cw-real-timing-'));
  const docId = 'd-replay';
  const meetingId = 'm-replay-1';
  const path = tickTimingPath(dataDir, docId, meetingId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, readFileSync(FIXTURE));
  return { dataDir, docId, meetingId };
}

describe('the reader over the writer’s own output', () => {
  it('reads every tick and none of the summary line', () => {
    const { dataDir, docId, meetingId } = meetingWithRealTiming();
    const waits = readTickWaits(dataDir, docId, meetingId);
    // 72 lines, 71 of them ticks. Reading 72 would mean the summary object
    // had been counted as a tick with a latency of its own.
    expect(waits).toHaveLength(71);
  });

  it('reports the same middle wait the writer’s own summary line reports', () => {
    // The writer computes a median over the same field and writes it into the
    // file. Agreeing with it is the check that this reader is reading the
    // number the pipeline believes it recorded, rather than one of the other
    // durations on the same row.
    const { dataDir, docId, meetingId } = meetingWithRealTiming();
    const summary = readFileSync(FIXTURE, 'utf8').trim().split('\n').at(-1) ?? '';
    const stated = JSON.parse(summary) as { summary: boolean; medianMs: number; ticks: number };
    expect(stated.summary).toBe(true);

    const lateness = latenessFrom(readTickWaits(dataDir, docId, meetingId) ?? []);
    expect(lateness.source).toBe('ticks');
    expect(lateness.measured).toBe(stated.ticks);
    expect(lateness.medianMs).toBe(stated.medianMs);
  });

  it('counts the ticks that crossed the late bar, and does not flag this meeting', () => {
    const { dataDir, docId, meetingId } = meetingWithRealTiming();
    const lateness = latenessFrom(readTickWaits(dataDir, docId, meetingId) ?? []);
    // Nine of seventy-one waits are over a minute. Recorded rather than
    // asserted loosely, because this is the only real measurement of this
    // bar that exists: a meeting whose worst note landed four minutes late
    // still comes out UNDER the one-in-five share, so the share bar catches a
    // meeting that is late throughout and not one that is late in a tail.
    expect(lateness.late).toBe(9);
    expect(lateness.lateShare ?? 0).toBeLessThan(0.2);
    expect(lateness.maxMs ?? 0).toBeGreaterThan(4 * LATE_NOTE_MS);
  });

  it('carries no words from the meeting it measured', () => {
    // The guard that keeps a real artifact publishable. Every string in the
    // file is a value this repo writes; a fixture regenerated from a meeting
    // whose words leaked through would add a fifth and fail here.
    const values = new Set<string>();
    const walk = (v: unknown): void => {
      if (typeof v === 'string') values.add(v);
      else if (Array.isArray(v)) for (const x of v) walk(x);
      else if (v !== null && typeof v === 'object') for (const x of Object.values(v)) walk(x);
    };
    for (const line of readFileSync(FIXTURE, 'utf8').split('\n')) {
      if (line.trim()) walk(JSON.parse(line));
    }
    expect([...values].sort()).toEqual(['H1 ceiling armed on a word', 'cadence', 'end', 'written']);
  });
});
