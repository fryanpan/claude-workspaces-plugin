/**
 * `--compare`: two runs of the same audio in one table.
 *
 * What is pinned here is the part a reader relies on and cannot check — that
 * the table names what each measure counts, that it prints BOTH coverage
 * readings so a definition change cannot pass as an improvement, and that a
 * comparison of two runs that are not comparable says so rather than
 * rendering silently.
 *
 * All names and notes are invented. The repo is public.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { allBullets } from '../packages/server/src/notes-quality.ts';
import {
  CompareTargetError,
  REPORT_JSON,
  loadRerunReport,
  renderComparison,
  resolveComparePath,
} from './rerun-meeting-compare.ts';
import {
  type RerunReport,
  type RerunReportInput,
  buildRerunReport,
} from './rerun-meeting-report.ts';

const dirs: string[] = [];
const freshDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'cw-rerun-compare-'));
  dirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A document a meeting wrote into, and the bullets of it that were the
 *  meeting's own — the shape whole-doc note-taking leaves behind. */
const DOCUMENT = [
  '## Survey dates',
  '',
  '- Prep note from the harbour office',
  '- Start on the first Monday of March',
  '',
  '## Meeting notes',
  '',
  '- Crane needed in the second week',
].join('\n');
const WRITTEN = ['- Start on the first Monday of March', '- Crane needed in the second week'].join(
  '\n',
);
const SECTION = ['## Meeting notes', '- Crane needed in the second week'].join('\n');

function report(over: Partial<RerunReportInput> = {}): RerunReport {
  return buildRerunReport({
    method: 'ledger-haiku',
    engine: 'mock',
    docShape: 'outline',
    docEdits: 0,
    audioMs: 132_000,
    elapsedMs: 134_000,
    ticks: 6,
    turnsSettled: 17,
    ideasVoiced: 24,
    ideasCovered: 19,
    sectionIdeasVoiced: 24,
    sectionIdeasCovered: 4,
    commit: 'abc1234',
    tidy: { ok: true, proposed: 3, applied: 2, refused: 1 },
    billedUsd: 0.0431,
    billedCalls: 12,
    unpricedModels: [],
    firstNoteMs: 9_400,
    notesPath: '/runs/rerun-2/notes.md',
    writtenNotesPath: '/runs/rerun-2/notes-meeting.md',
    logPath: '/runs/rerun-2/run.log',
    document: DOCUMENT,
    section: SECTION,
    written: WRITTEN,
    ...over,
  });
}

describe('the count the coverage line reports', () => {
  it('is the bullet count of the notes file the run writes beside the report', () => {
    // `notes-meeting.md` holds exactly the markdown the report was built
    // from, so a reader can count the file and get the number back.
    expect(report().bulletsWritten).toBe(allBullets(WRITTEN).length);
    expect(report().bulletsWritten).toBe(2);
  });

  it('THE CONTROL: the section count is the smaller, older reading', () => {
    expect(report().bulletsInSection).toBe(1);
  });
});

describe('finding the run to compare against', () => {
  it('takes a run folder, its report.json, or the report.md beside it', () => {
    const dir = freshDir();
    const json = join(dir, REPORT_JSON);
    writeFileSync(json, JSON.stringify(report()));
    expect(resolveComparePath(dir)).toBe(json);
    expect(resolveComparePath(json)).toBe(json);
    expect(resolveComparePath(join(dir, 'report.md'))).toBe(json);
  });

  it('refuses a path with no report beside it, and says what it looked for', () => {
    const dir = freshDir();
    expect(() => loadRerunReport(join(dir, 'report.md'))).toThrow(CompareTargetError);
    expect(() => loadRerunReport(join(dir, 'report.md'))).toThrow(/report\.json/);
  });

  it('refuses a file that parses but is not a rerun report', () => {
    const dir = freshDir();
    writeFileSync(join(dir, REPORT_JSON), JSON.stringify({ hello: 'world' }));
    expect(() => loadRerunReport(dir)).toThrow(/not a rerun report/);
  });

  it('refuses a report missing a measure the table reads, and names it', () => {
    // A half-report renders a row of `undefined` and then throws partway
    // down the table on `billedUsd.toFixed`, which is a worse way to learn
    // the file was wrong.
    const dir = freshDir();
    const { billedUsd: _dropped, ...half } = report();
    writeFileSync(join(dir, REPORT_JSON), JSON.stringify(half));
    expect(() => loadRerunReport(dir)).toThrow(/billedUsd/);
  });

  it('refuses one whose tidy counts are missing', () => {
    const dir = freshDir();
    writeFileSync(join(dir, REPORT_JSON), JSON.stringify({ ...report(), tidy: { ok: true } }));
    expect(() => loadRerunReport(dir)).toThrow(/tidy/);
  });

  it('reads a report whose latency is the null the harness writes for “never”', () => {
    const dir = freshDir();
    writeFileSync(join(dir, REPORT_JSON), JSON.stringify(report({ firstNoteMs: null })));
    expect(loadRerunReport(dir).firstNoteMs).toBeNull();
  });

  it('reads back every measure the table prints', () => {
    const dir = freshDir();
    writeFileSync(join(dir, REPORT_JSON), JSON.stringify(report()));
    expect(loadRerunReport(dir)).toEqual(report());
  });
});

describe('the before/after table', () => {
  const before = report({
    commit: 'old9999',
    ideasCovered: 4,
    sectionIdeasCovered: 4,
    written: SECTION,
  });
  const after = report();

  it('puts both runs in one row per measure, and names what the measure counts', () => {
    const text = renderComparison(before, after).join('\n');
    expect(text).toContain('| Ideas covered — whole doc |');
    expect(text).toContain('ideas whose words appear in a bullet this meeting wrote, anywhere');
    expect(text).toContain('| 4 of 24 (17%) | 19 of 24 (79%) |');
  });

  it('prints the old reading too, so a definition change cannot pass as a gain', () => {
    const text = renderComparison(before, after).join('\n');
    expect(text).toContain('| Ideas covered — section only |');
    expect(text).toContain('the old reading');
  });

  it('names which commit each column was measured on', () => {
    const text = renderComparison(before, after).join('\n');
    expect(text).toContain('old9999');
    expect(text).toContain('abc1234');
  });

  it('says so when the two runs are not comparable', () => {
    const text = renderComparison(report({ audioMs: 60_000, engine: 'soniox' }), after).join('\n');
    expect(text).toContain('Not a clean comparison');
    expect(text).toContain('the audio is not the same length');
    expect(text).toContain('different engines');
  });

  it('adds no caveat to two runs of the same audio on the same setup', () => {
    expect(renderComparison(before, after).join('\n')).not.toContain('Not a clean comparison');
  });
});
