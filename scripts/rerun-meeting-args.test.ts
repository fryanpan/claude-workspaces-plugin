/**
 * The refusals, and the starting document.
 *
 * NO MODEL IS REACHED HERE, and that is the point of testing this file rather
 * than the run: every one of these guards exists so that a run which would
 * have billed never starts, so a test that had to start one to find out would
 * be testing the wrong side of the guard.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { notesMethodInfo } from '../packages/core/src/notes-method.ts';
import {
  CAPTURE_OVERHEAD,
  UsageError,
  budgetCheck,
  checkDocEdits,
  loadDocSpec,
  parseRerunArgs,
  pcmDurationMs,
} from './rerun-meeting-args.ts';
import { MEMBERS } from './verify.ts';

const MIN = 60_000;

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'cw-rerun-args-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('the spend flag', () => {
  it('refuses to start without one, and says what the money is for', () => {
    let thrown: unknown;
    try {
      parseRerunArgs(['/meetings/m1']);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(UsageError);
    expect((thrown as UsageError).message).toContain('refusing to start');
    expect((thrown as UsageError).message).toContain('--spend-usd');
  });

  it('refuses last, so the money is the reason a bad command line is rejected', () => {
    // Several things wrong at once: the one the operator is told about is the
    // one that would have cost something.
    expect(() => parseRerunArgs(['/m', '--chunk-ms', '0'])).toThrow(/--chunk-ms/);
    expect(() => parseRerunArgs(['/m', '--doc', 'x.md'])).toThrow(/refusing to start/);
  });

  it('accepts a run once a ceiling is named, and defaults the rest', () => {
    expect(parseRerunArgs(['/meetings/m1', '--spend-usd', '5'])).toEqual({
      target: '/meetings/m1',
      method: 'original',
      engine: 'mock',
      doc: 'empty',
      out: 'meeting-reruns',
      spendUsd: 5,
      chunkMs: 20,
      port: 0,
      keep: false,
      engineSpendOk: false,
    });
  });

  it('takes a method, an engine and a document, and rejects names it has no builder for', () => {
    const args = parseRerunArgs([
      '/m',
      '--spend-usd',
      '2',
      '--method',
      'ledger-opus',
      '--engine',
      'soniox',
      '--engine-spend-ok',
      '--doc',
      'outline.json',
      '--chunk-ms',
      '400',
    ]);
    expect(args.method).toBe('ledger-opus');
    expect(args.engine).toBe('soniox');
    expect(args.doc).toBe('outline.json');
    expect(args.chunkMs).toBe(400);
    expect(() => parseRerunArgs(['/m', '--spend-usd', '2', '--method', 'ledger-sonnet'])).toThrow(
      UsageError,
    );
    expect(() => parseRerunArgs(['/m', '--spend-usd', '2', '--engine', 'whisper'])).toThrow(
      /unknown engine/,
    );
    expect(() => parseRerunArgs(['/m', '--spend-usd'])).toThrow(/needs a value/);
  });
});

describe('a paid engine', () => {
  it('refuses to start until the operator says its bill is theirs', () => {
    // `--spend-usd` meters the model calls this harness makes. A vendor
    // engine bills for the audio's whole length through no seam it can see,
    // so a ceiling that silently covered it would be a promise nothing keeps.
    expect(() => parseRerunArgs(['/m', '--spend-usd', '2', '--engine', 'assemblyai'])).toThrow(
      /refusing to start: --engine assemblyai bills the vendor/,
    );
    expect(
      parseRerunArgs(['/m', '--spend-usd', '2', '--engine', 'assemblyai', '--engine-spend-ok'])
        .engineSpendOk,
    ).toBe(true);
  });

  it('asks nothing extra of the free one', () => {
    expect(parseRerunArgs(['/m', '--spend-usd', '2', '--engine', 'mock']).engine).toBe('mock');
  });
});

describe('the pre-flight budget', () => {
  it('refuses a recording whose length alone would pass the ceiling', () => {
    const verdict = budgetCheck(90 * MIN, 'ledger-opus', 0.01);
    expect(verdict.ok).toBe(false);
    expect(verdict.line).toContain('refusing to start');
    expect(verdict.line).toContain('90.0 min');
  });

  it('lets a recording the ceiling covers through, and still says the estimate', () => {
    const verdict = budgetCheck(3 * MIN, 'original', 1000);
    expect(verdict.ok).toBe(true);
    expect(verdict.line).not.toContain('refusing');
    expect(verdict.line).toContain('ceiling $1000.00');
  });

  it('estimates the capture pass as well as the compose', () => {
    // The compose-only figure is what `notesMethodInfo` publishes; a guard
    // that used it alone would let a run through that bills twice it.
    const hour = budgetCheck(60 * MIN, 'ledger-haiku', 1e6).estimateUsd;
    expect(hour).toBeCloseTo(
      notesMethodInfo('ledger-haiku').estimatedPerHourUsd * CAPTURE_OVERHEAD,
    );
    expect(CAPTURE_OVERHEAD).toBeGreaterThan(1);
  });

  it('reads a length off the bytes at the meeting sample rate', () => {
    expect(pcmDurationMs(32_000, 16_000)).toBe(1000);
  });
});

describe('an edit that lands after the audio ends', () => {
  it('is refused before the meeting opens, naming when it would have arrived', () => {
    // The replay stops its timers when the last chunk is sent, so an edit
    // scheduled past the end never happens — and a report written from that
    // document would describe a starting outline nobody edited.
    expect(() => checkDocEdits([{ atMs: 62_000, find: 'a', replace: 'b' }], 40_000)).toThrow(
      /refusing to start: --doc schedules 1 edit\(s\) at 62.0s, but the recording is 40.0s/,
    );
  });

  it('lets an edit inside the recording through', () => {
    expect(() =>
      checkDocEdits(
        [
          { atMs: 0, find: 'a', replace: 'b' },
          { atMs: 39_999, find: 'c', replace: 'd' },
        ],
        40_000,
      ),
    ).not.toThrow();
    expect(() => checkDocEdits([], 0)).not.toThrow();
  });
});

describe('the starting document', () => {
  it('is empty when nothing is named', () => {
    expect(loadDocSpec('empty')).toEqual({ shape: 'empty', markdown: '', edits: [] });
  });

  it('is an outline when a markdown file is named', () => {
    const path = join(dir, 'prep.md');
    writeFileSync(path, '# Harbour survey\n\n- Confirm the start date\n');
    const spec = loadDocSpec(path);
    expect(spec.shape).toBe('outline');
    expect(spec.markdown).toContain('Confirm the start date');
    expect(spec.edits).toEqual([]);
  });

  it('is an outline with edits when the json carries them, in time order', () => {
    const path = join(dir, 'prep.json');
    writeFileSync(
      path,
      JSON.stringify({
        markdown: '# Harbour survey\n\n- Boats: how many\n- Chase the quote\n',
        edits: [
          { atMs: 90_000, find: 'Chase the quote', replace: 'Quote is in' },
          { atMs: 45_000, find: 'Boats: how many', replace: 'Boats: two short' },
        ],
      }),
    );
    const spec = loadDocSpec(path);
    expect(spec.shape).toBe('outline+edits');
    expect(spec.edits.map((e) => e.atMs)).toEqual([45_000, 90_000]);
    expect(spec.edits[0]?.replace).toBe('Boats: two short');
  });

  it('refuses a file it cannot use rather than starting a meeting against nothing', () => {
    expect(() => loadDocSpec(join(dir, 'missing.md'))).toThrow(/neither "empty" nor a file/);
    const txt = join(dir, 'prep.txt');
    writeFileSync(txt, 'hello');
    expect(() => loadDocSpec(txt)).toThrow(/\.md or \.json/);
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{');
    expect(() => loadDocSpec(bad)).toThrow(/not valid JSON/);
    const noMarkdown = join(dir, 'no-markdown.json');
    writeFileSync(noMarkdown, JSON.stringify({ edits: [] }));
    expect(() => loadDocSpec(noMarkdown)).toThrow(/string markdown field/);
    const notAList = join(dir, 'edits-not-a-list.json');
    writeFileSync(notAList, JSON.stringify({ markdown: '#', edits: { atMs: 1 } }));
    expect(() => loadDocSpec(notAList)).toThrow(/edits must be an array/);
    const badEdit = join(dir, 'bad-edit.json');
    writeFileSync(badEdit, JSON.stringify({ markdown: '#', edits: [{ find: 'a', replace: 'b' }] }));
    expect(() => loadDocSpec(badEdit)).toThrow(/non-negative atMs/);
    const emptyFind = join(dir, 'empty-find.json');
    writeFileSync(
      emptyFind,
      JSON.stringify({ markdown: '#', edits: [{ atMs: 1, find: '', replace: 'b' }] }),
    );
    expect(() => loadDocSpec(emptyFind)).toThrow(/non-empty find/);
  });
});

describe('no gate runs it', () => {
  it('is named by no member of `bun run verify`', () => {
    const named = MEMBERS.filter(
      (m) => m.argv.includes('meeting:rerun') || m.ci === 'meeting:rerun',
    );
    expect(named).toEqual([]);
    // And the control: the gate list is non-empty and the search does find a
    // member that IS there, so an empty result means absence, not a broken
    // predicate.
    expect(MEMBERS.filter((m) => m.argv.includes('typecheck')).length).toBeGreaterThan(0);
  });
});
