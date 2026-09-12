/**
 * A rule's declared output, driven directly (`schedule-output.ts`): what a
 * caller may declare, which of a project's files are one run's output, and
 * what the next item links. Every instant is a literal; fixtures are
 * synthetic.
 */
import { describe, expect, it } from 'vitest';
import {
  OUTPUT_ITEM_MAX_LINKS,
  OUTPUT_SLACK_MS,
  outputItemPaths,
  parseScheduleOutput,
  runOutputPaths,
  scheduleOutputField,
} from './schedule-output.ts';
import { parseSchedule } from './schedule-parse.ts';

describe('declaring an output folder', () => {
  it('reads a relative folder, trimming a trailing slash', () => {
    expect(parseScheduleOutput({ folder: 'roundups/' })).toEqual({
      ok: true,
      output: { folder: 'roundups' },
    });
    expect(parseScheduleOutput({ folder: 'notes/ferry roundups' })).toEqual({
      ok: true,
      output: { folder: 'notes/ferry roundups' },
    });
  });

  it('tells "said nothing" from "clear"', () => {
    expect(parseScheduleOutput(undefined)).toEqual({ ok: true, output: undefined });
    expect(parseScheduleOutput(null)).toEqual({ ok: true, output: null });
  });

  it('refuses anything that could leave the project or name its root', () => {
    for (const folder of ['', '/', '/etc', '../up', 'a/../b', './a', 'a//b', 'a\\b', 'a\u0007b']) {
      expect(parseScheduleOutput({ folder }).ok).toBe(false);
    }
    expect(parseScheduleOutput('roundups').ok).toBe(false);
    expect(parseScheduleOutput({ folder: 'x'.repeat(513) }).ok).toBe(false);
  });

  it('rides the one schedule door, and a bad folder refuses the whole write', () => {
    const rule = { kind: 'every', everyMs: 3_600_000 };
    const ok = parseSchedule({ rule, output: { folder: 'roundups' } });
    expect(ok.ok && ok.output).toEqual({ folder: 'roundups' });
    const bare = parseSchedule({ rule });
    expect(bare.ok && 'output' in bare).toBe(false);
    expect(parseSchedule({ rule, output: { folder: '../x' } }).ok).toBe(false);
  });

  it('keeps the stored folder when a write says nothing, and drops it on null', () => {
    const stored = { folder: 'roundups' };
    expect(scheduleOutputField(undefined, stored)).toEqual({ output: stored });
    expect(scheduleOutputField(null, stored)).toEqual({});
    expect(scheduleOutputField({ folder: 'tides' }, stored)).toEqual({
      output: { folder: 'tides' },
    });
    expect(scheduleOutputField(undefined, undefined)).toEqual({});
  });
});

describe("one run's output", () => {
  const output = { folder: 'roundups' };
  const run = { from: 1_000_000, closedAt: 1_300_000 };

  it('is the files in the folder written while the instance was open, newest first', () => {
    const files = [
      { relPath: 'roundups/2026-03-02.md', at: 1_290_000 },
      { relPath: 'roundups/weekly/2026-03-02.md', at: 1_295_000 },
      // Sources the run wrote elsewhere are not its output.
      { relPath: 'clippings/heron-post.md', at: 1_010_000 },
      // Yesterday's, and one written before the instance existed.
      { relPath: 'roundups/2026-03-01.md', at: 900_000 },
      // A folder whose name merely starts the same way.
      { relPath: 'roundups-old/2026-03-02.md', at: 1_290_000 },
      { relPath: 'roundups/no-clock.md' },
    ];
    expect(runOutputPaths(files, output, run)).toEqual([
      'roundups/weekly/2026-03-02.md',
      'roundups/2026-03-02.md',
    ]);
  });

  it('counts a file flushed within the slack after the close, and nothing later', () => {
    const files = [
      { relPath: 'roundups/late.md', at: run.closedAt + OUTPUT_SLACK_MS },
      { relPath: 'roundups/too-late.md', at: run.closedAt + OUTPUT_SLACK_MS + 1 },
    ];
    expect(runOutputPaths(files, output, run)).toEqual(['roundups/late.md']);
  });

  it("links this run's files first, then earlier unopened ones, never twice and never past the cap", () => {
    expect(outputItemPaths(['r/c.md'], ['r/b.md', 'r/c.md', 'r/a.md'])).toEqual([
      'r/c.md',
      'r/b.md',
      'r/a.md',
    ]);
    const many = Array.from({ length: 10 }, (_, i) => `r/${i}.md`);
    expect(outputItemPaths(['r/new.md'], many)).toHaveLength(OUTPUT_ITEM_MAX_LINKS);
  });
});
