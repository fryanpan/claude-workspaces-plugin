/**
 * The timing log is the instrument this whole change is measured with, so it
 * gets its own tests: an instrument nobody has checked cannot settle an
 * argument about latency.
 *
 * Two things it must never do — repeat a word anybody said, and cost a
 * meeting a note when the disk refuses it — are asserted here rather than
 * being left to the reader of the module.
 */
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type NotesTickTiming,
  createNotesTimingLog,
  hypothesisFor,
  median,
} from '../src/notes-timing.ts';

const row = (over: Partial<NotesTickTiming> = {}): NotesTickTiming => ({
  tick: 1,
  reason: 'pause',
  settledAt: 1000,
  startedAt: 1200,
  waitedMs: 0,
  promptChars: null,
  replyChars: null,
  firstTokenMs: null,
  composeMs: 800,
  model: null,
  applyMs: 5,
  edits: 1,
  blocks: 1,
  merged: 1,
  outcome: 'written',
  settledToWrittenMs: 2000,
  ...over,
});

describe('the per-tick timing log', () => {
  it('reports the median and the worst of the latencies it saw', () => {
    const log = createNotesTimingLog();
    for (const ms of [4000, 1000, 9000, 2000, 3000]) {
      log.record(row({ settledToWrittenMs: ms }));
    }
    expect(log.summary()).toBe(
      '[notes-timing] 5 tick(s): settled-to-written median 3000ms, worst 9000ms',
    );
  });

  it('says nothing about a meeting where no note ever landed', () => {
    // The dangerous shape: a summary that prints 0ms for a meeting that
    // produced nothing reads as the best meeting ever recorded.
    const log = createNotesTimingLog();
    log.record(row({ outcome: 'failed', settledToWrittenMs: null }));
    expect(log.summary()).toBeNull();
  });

  it('counts the writes that were skipped in the summary line', () => {
    const log = createNotesTimingLog();
    log.record(row({ settledToWrittenMs: 1000 }));
    log.record(row({ outcome: 'failed', settledToWrittenMs: null }));
    expect(log.summary()).toContain('1 write(s) skipped');
  });

  it('names the hypothesis each line settles', () => {
    // A refused write outranks every other shape: it is the one that loses
    // words, whatever clock produced the tick.
    expect(hypothesisFor(row({ outcome: 'failed', reason: 'cadence' }))).toContain('H4');
    expect(hypothesisFor(row({ merged: 3 }))).toContain('H3');
    expect(hypothesisFor(row({ reason: 'cadence' }))).toContain('H1');
    expect(hypothesisFor(row({ reason: 'pause' }))).toContain('H2');
    expect(hypothesisFor(row({ reason: 'end', waitedMs: 700 }))).toContain('H5');
  });

  it('writes one JSON line per tick, holding numbers and no words', () => {
    const dir = mkdtempSync(join(tmpdir(), 'notes-timing-'));
    try {
      const path = join(dir, 'nested', 'm-1-timing.jsonl');
      const log = createNotesTimingLog({ path });
      log.record(row({ tick: 1, settledToWrittenMs: 1500, model: 'haiku', promptChars: 4000 }));
      log.record(row({ tick: 2, settledToWrittenMs: 2500 }));
      expect(log.summary()).toContain('worst 2500ms');

      const lines = readFileSync(path, 'utf8').trim().split('\n');
      expect(lines).toHaveLength(3); // two ticks and the summary
      const first = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
      expect(first.tick).toBe(1);
      expect(first.promptChars).toBe(4000);
      expect(first.hypothesis).toBe('H2 endpoint became a pause');
      // Every value is a number, a boolean, or one of the small vocabulary
      // of labels this module defines. Nothing anybody said can be in here.
      const vocabulary = ['pause', 'cadence', 'end', 'written', 'failed', 'empty', 'haiku'];
      for (const [key, value] of Object.entries(first)) {
        if (typeof value !== 'string') continue;
        expect([key, value, vocabulary.includes(value) || key === 'hypothesis']).toEqual([
          key,
          value,
          true,
        ]);
      }
      const summary = JSON.parse(lines[2] ?? '{}') as Record<string, unknown>;
      expect(summary).toMatchObject({ summary: true, ticks: 2, medianMs: 2500, worstMs: 2500 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps recording when the file cannot be written', () => {
    // A meeting must not lose a note because its instrumentation could not
    // write. The path is a directory that will not be created under a file.
    const dir = mkdtempSync(join(tmpdir(), 'notes-timing-bad-'));
    try {
      const errors: string[] = [];
      const log = createNotesTimingLog({ path: join(dir), onError: (m) => errors.push(m) });
      log.record(row({ settledToWrittenMs: 1200 }));
      expect(errors.length).toBeGreaterThan(0);
      // The in-memory rows are unaffected, so the summary still answers.
      expect(log.rows()).toHaveLength(1);
      expect(log.summary()).toContain('median 1200ms');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('takes the upper middle of an even count, and nothing from none', () => {
    expect(median([])).toBeNull();
    expect(median([1, 2, 3, 4])).toBe(3);
    expect(median([5])).toBe(5);
  });
});
