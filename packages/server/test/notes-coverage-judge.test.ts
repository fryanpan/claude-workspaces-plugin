/**
 * The model's reading of what a finished meeting's notes left out
 * (`notes-coverage-judge.ts`), and the filer acting on it once the meeting is
 * over (`notes-quality-filing.ts` `amend`).
 *
 * No network: the judge is driven by a fetch that answers the tool call, and
 * the filer by a judge that answers what the test says. Every name and every
 * note is invented. The repo is public.
 */
import { describe, expect, it } from 'bun:test';
import {
  type CoverageJudgement,
  coverageWindows,
  createCoverageJudge,
  parseCoverageAnswer,
  withJudgedCoverage,
} from '../src/notes-coverage-judge.ts';
import { createNotesQualityFiler } from '../src/notes-quality-filing.ts';
import { buildNotesQualityReport } from '../src/notes-quality-report.ts';
import type { NotesQualityFileInput } from '../src/notes-quality-review.ts';
import {
  ACTOR,
  HandScheduler,
  cleanReading,
  recordingBoard,
} from './notes-quality-board-harness.ts';

const SPEECH = [
  { speaker: 'remote:A', text: 'The Harborlight export goes out on Friday.' },
  { speaker: 'remote:B', text: 'Riverbend still has not signed the contract.' },
];

/** A fetch whose every reply records `points`, and which counts its calls. */
function answering(points: Array<{ point: string; carried: boolean }> | 'broken') {
  const seen: unknown[] = [];
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    seen.push(JSON.parse(String(init?.body)));
    if (points === 'broken') return new Response('nope', { status: 500 });
    return Response.json({
      content: [{ type: 'tool_use', name: 'record_points', input: { points } }],
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

describe('coverageWindows', () => {
  it('keeps each stretch under the bound and every turn in exactly one', () => {
    const turns = Array.from({ length: 30 }, (_, i) => ({
      speaker: 'remote:A',
      text: `Point ${i} about the Saltmarsh ferry timetable for the winter.`,
    }));
    const windows = coverageWindows(turns, 300);
    expect(windows.length).toBeGreaterThan(1);
    for (const w of windows) expect(w.length <= 300 + 80).toBe(true);
    expect(windows.join('\n').split('\n')).toHaveLength(30);
  });
});

describe('parseCoverageAnswer', () => {
  it('counts the points and the ones no note carries', () => {
    expect(
      parseCoverageAnswer({
        points: [
          { point: 'a', carried: true },
          { point: 'b', carried: false },
        ],
      }),
    ).toEqual({ ideas: 2, lost: 1 });
  });

  it('reads a missing verdict as no answer, never as lost', () => {
    expect(parseCoverageAnswer({ points: [{ point: 'a' }] })).toBeNull();
    expect(parseCoverageAnswer({})).toBeNull();
  });
});

describe('createCoverageJudge', () => {
  it('sums every stretch, and sends the notes in every call', async () => {
    const { fetchImpl, seen } = answering([
      { point: 'export on Friday', carried: true },
      { point: 'contract unsigned', carried: false },
    ]);
    const judge = createCoverageJudge({ apiKey: 'test-key', fetchImpl });
    const got = await judge({ transcript: SPEECH, notes: '- Export goes out Friday' });
    expect(got).toEqual({ ideas: 2, lost: 1, windows: 1, judgedWindows: 1 });
    expect(JSON.stringify(seen[0])).toContain('Export goes out Friday');
  });

  it('answers nothing when the calls fail, rather than a reading of nothing', async () => {
    const { fetchImpl } = answering('broken');
    const judge = createCoverageJudge({ apiKey: 'test-key', fetchImpl, onError: () => {} });
    expect(await judge({ transcript: SPEECH, notes: '- x' })).toBeNull();
  });
});

describe('withJudgedCoverage', () => {
  const report = buildNotesQualityReport({
    notes: '## Notes\n- The export goes out',
    transcript: [],
  });
  const judged = (ideas: number, lost: number): CoverageJudgement => ({
    ideas,
    lost,
    windows: 1,
    judgedWindows: 1,
  });

  it('raises the coverage flag at the goal bar of one idea in twenty', () => {
    const out = withJudgedCoverage(report, judged(40, 2));
    expect(out.flags.map((f) => f.kind)).toContain('coverage');
    expect(out.coverage.uncoveredShare).toBe(0.05);
  });

  it('raises nothing under the bar', () => {
    const out = withJudgedCoverage(report, judged(40, 1));
    expect(out.flags.map((f) => f.kind)).not.toContain('coverage');
  });

  it('leaves a reading whose notes could not be read alone', () => {
    const unread = buildNotesQualityReport({ notes: '', transcript: [], notesRead: false });
    expect(withJudgedCoverage(unread, judged(40, 30))).toBe(unread);
  });
});

describe('the filer acts on the judged reading', () => {
  const lossy = async (_ids: unknown, input: NotesQualityFileInput) => ({
    ...input,
    report: withJudgedCoverage(input.report, {
      ideas: 40,
      lost: 8,
      windows: 2,
      judgedWindows: 2,
    }),
  });

  it('files a meeting the pass read clean when the judge found ideas missing', async () => {
    const board = recordingBoard();
    const filer = createNotesQualityFiler({
      board: () => board,
      actor: ACTOR,
      schedule: new HandScheduler(),
      say: () => {},
      amend: lossy,
    });
    const ids = { docId: 'd-harbour', meetingId: 'm-1' };
    filer.file(ids, cleanReading(ids.docId));
    filer.legEnded(ids, { resumable: false });
    await filer.settled();
    expect(board.filed).toEqual(['t-season']);
  });

  it('without a judge the same clean reading files nothing', async () => {
    const board = recordingBoard();
    const filer = createNotesQualityFiler({
      board: () => board,
      actor: ACTOR,
      schedule: new HandScheduler(),
      say: () => {},
    });
    const ids = { docId: 'd-harbour', meetingId: 'm-1' };
    filer.file(ids, cleanReading(ids.docId));
    filer.legEnded(ids, { resumable: false });
    await filer.settled();
    expect(board.filed).toEqual([]);
  });

  it('drops the answer of a judge that a resume overtook', async () => {
    const board = recordingBoard();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const filer = createNotesQualityFiler({
      board: () => board,
      actor: ACTOR,
      schedule: new HandScheduler(),
      say: () => {},
      amend: async (ids, input) => {
        await gate;
        return lossy(ids, input);
      },
    });
    const ids = { docId: 'd-harbour', meetingId: 'm-1' };
    filer.file(ids, cleanReading(ids.docId));
    filer.legEnded(ids, { resumable: false });
    filer.legBegan(ids);
    release();
    await filer.settled();
    expect(board.filed).toEqual([]);
  });
});
