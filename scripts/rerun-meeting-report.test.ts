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
    sectionIdeasVoiced: 24,
    sectionIdeasCovered: 4,
    commit: 'abc1234',
    tidy: { ok: true, proposed: 3, applied: 2, refused: 1 },
    billedUsd: 0.0431,
    billedCalls: 12,
    unpricedModels: [],
    firstNoteMs: 9_400,
    notesPath: '/runs/rerun-1/notes.md',
    writtenNotesPath: '/runs/rerun-1/notes-meeting.md',
    logPath: '/runs/rerun-1/run.log',
    document: SECTION,
    section: SECTION,
    written: SECTION,
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
    const report = buildRerunReport(input({ document: section, section, written: section }));
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
    const written = '- Confirm the start date\n- Draft timetable due by the ninth\n';
    const report = buildRerunReport(input({ document, section, written }));
    expect(report.topicHeadings).toBe(2);
    expect(report.bullets).toBe(3);
    expect(report.bulletsInSection).toBe(1);
    // The measure that replaced it: what the meeting wrote, wherever it sits.
    expect(report.bulletsWritten).toBe(2);
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

describe('the unnamed-voice measure', () => {
  const document = [
    '## Meeting notes',
    '',
    '- [@Harbourmaster](speaker:room:A) wants the crane booked this week',
    '- [@Room Speaker B](speaker:room:B) asked who signs it off',
    '- [@Speaker C](speaker:C) said the quote expires Friday',
    '- Nobody in particular said the office is copied',
    '',
  ].join('\n');

  it('counts the bullets pointing at a voice nobody named, and names the labels', () => {
    const report = buildRerunReport(input({ document, section: document, written: document }));
    // Three tagged bullets, one of them named: the two placeholders are what
    // a reader cannot trace back to a person.
    expect(report.unnamedVoiceBullets).toBe(2);
    expect(report.unnamedVoiceLabels).toEqual(['C', 'room:B']);
  });

  it('reads a fully named set of notes as nothing to answer for', () => {
    const named = document
      .replaceAll('Room Speaker B', 'Dockmaster')
      .replaceAll('Speaker C', 'Crane Lead');
    const report = buildRerunReport(input({ document: named, section: named, written: named }));
    expect(report.unnamedVoiceBullets).toBe(0);
    expect(report.unnamedVoiceLabels).toEqual([]);
  });

  it('puts the count in the rendered table beside the labels', () => {
    const text = renderRerunReport(
      buildRerunReport(input({ document, section: document, written: document })),
    );
    expect(text).toContain('| Bullets on an unnamed voice | 2 of 4 bullet(s) — C, room:B |');
  });
});

describe('renderRerunReport', () => {
  it('fills all eight measures', () => {
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
    expect(text).toContain('| Bullets on an unnamed voice | 0 of 6 bullet(s) |');
    expect(text).toContain('| Bullets this meeting wrote | 6 of 6 in the document |');
    // The measures table (header + nine) and the coverage table (header + the
    // two readings).
    expect(rows).toHaveLength(13);
  });

  it('prints both coverage readings of the run, each saying what it counted', () => {
    // The definition of "ideas covered" changed on 2026-09-16, so a report
    // that printed one number would read as a note-taker that improved.
    const document = '## Prep\n\n- one\n- two\n\n## Meeting notes\n\n- three\n';
    const section = '## Meeting notes\n- three\n';
    const written = '- one\n- three\n';
    const text = renderRerunReport(
      buildRerunReport(input({ document, section, written, ideasCovered: 19 })),
    );
    expect(text).toContain('Whole doc — every bullet this meeting wrote, wherever it sits');
    expect(text).toContain('Section only — bullets under the heading this meeting opened');
    // The whole-doc row is read over the bullets of `notes-meeting.md`, and
    // says which file, so the count can be checked.
    expect(text).toContain('| 19 of 24 (79%) | 2 bullet(s), `/runs/rerun-1/notes-meeting.md` |');
    expect(text).toContain('| 4 of 24 (17%) | 1 bullet(s) of the 3 in the document |');
  });

  it('names the commit each run was measured on', () => {
    expect(renderRerunReport(buildRerunReport(input()))).toContain('abc1234');
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

  /**
   * THE LEAD'S LINE ON THE 15 SEPTEMBER MEETING: a rerun whose tidy-up
   * applies nothing has to print a reason per edit it did not apply. The
   * counts row already said that nothing landed; nothing said what to change.
   */
  it('prints why the tidy-up did not apply what it proposed, grouped by rule', () => {
    const text = renderRerunReport(
      buildRerunReport(
        input({
          tidy: {
            ok: true,
            proposed: 4,
            applied: 0,
            refused: 3,
            refusals: [
              'replace_block b1: the document does not record the block as the note-taker’s own',
              'replace_block b2: the document does not record the block as the note-taker’s own',
              'delete_block b3: somebody has commented on the block',
            ],
            failures: ['nest_blocks: nothing to nest'],
          },
        }),
      ),
    );
    expect(text).toContain('4 proposed, 0 applied, 3 refused');
    // One line per rule with a count, commonest first — and the applier's own
    // failure beside the gate's refusals, because both are edits that did not
    // reach the notes.
    expect(text).toContain(
      '- 2 edits — the document does not record the block as the note-taker’s own',
    );
    expect(text).toContain('- 1 edit — somebody has commented on the block');
    expect(text).toContain('- 1 edit — nothing to nest');
  });

  it('says a count with no reasons behind it is unreported, never "nothing was refused"', () => {
    // A run against a server that predates the two arrays. Printing nothing
    // here would read as a clean pass on the exact run where the most was
    // refused.
    const text = renderRerunReport(
      buildRerunReport(input({ tidy: { ok: true, proposed: 16, applied: 0, refused: 16 } })),
    );
    expect(text).toContain(
      'Why the tidy-up did not apply 16 edit(s): not reported by this server.',
    );
  });

  it('counts an applier failure among the unreported losses, not only a refusal', () => {
    // Against an older server a pass whose only losses were in the APPLIER
    // sends `failed` and no lines. Keying the sentence on `refused` alone
    // printed nothing there, which reads as a pass that applied everything.
    const text = renderRerunReport(
      buildRerunReport(
        input({ tidy: { ok: true, proposed: 3, applied: 1, refused: 0, failed: 2 } }),
      ),
    );
    expect(text).toContain('Why the tidy-up did not apply 2 edit(s): not reported by this server.');
  });

  it('says nothing about reasons for a tidy-up that applied what it proposed', () => {
    const text = renderRerunReport(
      buildRerunReport(
        input({
          tidy: { ok: true, proposed: 3, applied: 3, refused: 0, refusals: [], failures: [] },
        }),
      ),
    );
    expect(text).not.toContain('Why the tidy-up');
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
