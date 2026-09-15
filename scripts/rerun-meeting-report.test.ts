/**
 * The report a rerun leaves behind.
 *
 * WHAT IS BEING PINNED is that all seven measures come out filled and that the
 * two structure counts are READ OFF the document the meeting left behind
 * rather than passed in. The failure this harness was built for — a meeting
 * that produced a long flat list under no heading at all — is invisible unless
 * those two are derived from the notes themselves, and reading them off the
 * SECTION alone made a meeting that wrote into somebody's outline look like a
 * meeting that wrote three bullets.
 */
import { describe, expect, it } from 'vitest';
import {
  type RerunReportInput,
  buildRerunReport,
  renderRerunReport,
} from './rerun-meeting-report.ts';

/** Two headings, and a flat run of four under the second. */
const SECTION = `## Survey dates

- Start on the first Monday of March
- Two boats short

## Slipway

- Quote came in under budget
- Crane needed in the second week
- Booking goes out today
- Harbour office copied
`;

function input(over: Partial<RerunReportInput> = {}): RerunReportInput {
  return {
    method: 'ledger-haiku',
    engine: 'mock',
    docShape: 'outline+edits',
    docEdits: 2,
    audioMs: 132_000,
    elapsedMs: 134_000,
    ticks: 6,
    turnsSettled: 17,
    ideasVoiced: 24,
    ideasCovered: 19,
    tidy: { ok: true, proposed: 3, applied: 2, refused: 1 },
    billedUsd: 0.0431,
    billedCalls: 12,
    unpricedModels: [],
    firstNoteMs: 9_400,
    notesPath: '/runs/rerun-1/notes.md',
    logPath: '/runs/rerun-1/run.log',
    document: SECTION,
    section: SECTION,
    ...over,
  };
}

describe('buildRerunReport', () => {
  it('counts the headings and the longest flat run off the document itself', () => {
    const report = buildRerunReport(input());
    expect(report.topicHeadings).toBe(2);
    expect(report.longestFlatRun).toBe(4);
    expect(report.bullets).toBe(6);
  });

  it('reads a headingless wall of bullets as one flat run and no heading', () => {
    // The shape the harness exists to catch.
    const section = ['- one', '- two', '- three', '- four', '- five'].join('\n');
    const report = buildRerunReport(input({ document: section, section }));
    expect(report.topicHeadings).toBe(0);
    expect(report.longestFlatRun).toBe(5);
  });

  it('counts the whole document, not the slice the meeting appended', () => {
    // The starting-outline shape: the note-taker wrote into the operator's own
    // headings, and only the tail is "the section this meeting opened".
    const document = `## Before the season

- Confirm the start date
- Two boats short, hiring from Saltmarsh

## Meeting notes

- Draft timetable due by the ninth
`;
    const section = '## Meeting notes\n- Draft timetable due by the ninth\n';
    const report = buildRerunReport(input({ document, section }));
    expect(report.topicHeadings).toBe(2);
    expect(report.bullets).toBe(3);
    expect(report.bulletsInSection).toBe(1);
  });

  it('carries every other measure through untouched', () => {
    const report = buildRerunReport(input());
    expect(report.ideasVoiced).toBe(24);
    expect(report.ideasCovered).toBe(19);
    expect(report.tidy).toEqual({ ok: true, proposed: 3, applied: 2, refused: 1 });
    expect(report.billedUsd).toBeCloseTo(0.0431);
    expect(report.firstNoteMs).toBe(9_400);
  });
});

describe('renderRerunReport', () => {
  it('fills all seven measures', () => {
    const text = renderRerunReport(buildRerunReport(input()));
    expect(text).toContain('| Ideas voiced | 24 |');
    expect(text).toContain('| Ideas covered | 19 of 24 (79%) |');
    expect(text).toContain('| Topic headings opened | 2 |');
    expect(text).toContain('| Longest flat run of bullets | 4 of 6 bullet(s) |');
    expect(text).toContain('3 proposed, 2 applied, 1 refused');
    expect(text).toContain('$0.0431 over 12 model call(s)');
    expect(text).toContain('| Latency to first note | 9.4s |');
    // No row is left blank: every cell between the pipes has something in it.
    const rows = text.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| ---'));
    for (const row of rows) {
      const cells = row.split('|').slice(1, -1);
      for (const cell of cells) expect(cell.trim().length).toBeGreaterThan(0);
    }
    expect(rows).toHaveLength(8); // the header plus the seven
  });

  it('says when the coverage figure read only the section, not the whole doc', () => {
    const document = '## Prep\n\n- one\n- two\n\n## Meeting notes\n\n- three\n';
    const section = '## Meeting notes\n- three\n';
    const text = renderRerunReport(buildRerunReport(input({ document, section })));
    expect(text).toContain('read over the 1 bullet(s) in the section this meeting opened');
    expect(text).toContain("2 it wrote into the starting document's own headings");
  });

  it('leaves that caveat out when the section IS the document', () => {
    expect(renderRerunReport(buildRerunReport(input()))).not.toContain('read over the');
  });

  it('says a missing latency in words rather than leaving a blank cell', () => {
    const text = renderRerunReport(buildRerunReport(input({ firstNoteMs: null })));
    expect(text).toContain('never — no note reached the doc');
  });

  it('names a refused tidy-up and a model it has no price for', () => {
    const text = renderRerunReport(
      buildRerunReport(
        input({
          tidy: { ok: false, reason: 'no-composer', proposed: 0, applied: 0, refused: 0 },
          unpricedModels: ['claude-experimental-9'],
        }),
      ),
    );
    expect(text).toContain('(refused: no-composer)');
    expect(text).toContain('no price for claude-experimental-9');
  });

  it('says so rather than dividing by zero when nothing read as an idea', () => {
    const text = renderRerunReport(buildRerunReport(input({ ideasVoiced: 0, ideasCovered: 0 })));
    expect(text).toContain('nothing in this meeting read as an idea');
    expect(text).not.toContain('NaN');
  });

  it('names what the run varied, so two reports can be told apart', () => {
    const text = renderRerunReport(buildRerunReport(input()));
    expect(text).toContain('ledger-haiku');
    expect(text).toContain('outline+edits');
    expect(text).toContain('2 edit(s) mid-run');
    expect(text).toContain('/runs/rerun-1/notes.md');
    expect(text).toContain('/runs/rerun-1/run.log');
  });
});
