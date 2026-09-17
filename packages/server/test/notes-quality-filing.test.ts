/**
 * The filer's own edges: the two ways a held reading could be lost, and the
 * ending that must not be held through.
 *
 * `notes-quality-timing.test.ts` drives this module through a whole scripted
 * meeting, which is where the behaviour a person sees is proved. What is left
 * here is what a meeting cannot reach in one run — a filer holding more
 * meetings than it remembers, and a socket closing with the code a restarting
 * server sends.
 *
 * Every name and every note is invented. The repo is public.
 */

import { describe, expect, it } from 'bun:test';
import { legIsResumable } from '../src/meeting-protocol.ts';
import { createNotesQualityFiler } from '../src/notes-quality-filing.ts';
import { buildNotesQualityReport } from '../src/notes-quality-report.ts';
import type { NotesQualityFileInput } from '../src/notes-quality-review.ts';
import {
  ACTOR,
  HandScheduler,
  badReading,
  recordingBoard,
  recordingDocBoard,
} from './notes-quality-board-harness.ts';

describe('a held reading is never lost', () => {
  it('keeps every meeting that is still waiting, past the remembered bound', () => {
    const board = recordingBoard();
    const schedule = new HandScheduler();
    const filer = createNotesQualityFiler({
      board: () => board,
      actor: ACTOR,
      schedule,
      say: () => {},
    });

    // Far more dropped meetings than the filer remembers, every one of them
    // holding the only copy of an item nothing else can rebuild.
    const meetings = 300;
    for (let i = 0; i < meetings; i++) {
      const ids = { docId: `d-${i}`, meetingId: `m-${i}` };
      filer.file(ids, badReading(ids.docId));
      filer.legEnded(ids, { resumable: true });
    }
    expect(filer.heldCount()).toBe(meetings);

    // Nobody reconnected to any of them: every grace fires and every item goes.
    schedule.fire();
    expect(board.filed).toHaveLength(meetings);
    expect(filer.heldCount()).toBe(0);
  });
});

describe('which endings are held through', () => {
  it('holds a network drop and files a restart, because a hold cannot survive one', () => {
    // The hold is a timer in this process. A restarting server exits before it
    // can fire, so holding through a restart risks losing the item outright,
    // while filing early costs at most a revision.
    expect(legIsResumable('network-drop')).toBe(true);
    expect(legIsResumable('server-restart')).toBe(false);
    expect(legIsResumable('client-stop')).toBe(false);
    expect(legIsResumable('silence')).toBe(false);
    expect(legIsResumable('tab-closed')).toBe(false);
  });

  it('files at once for the ending a restart reports', () => {
    const board = recordingBoard();
    const schedule = new HandScheduler();
    const filer = createNotesQualityFiler({
      board: () => board,
      actor: ACTOR,
      schedule,
      say: () => {},
    });
    const ids = { docId: 'd-harbour', meetingId: 'm-1' };
    filer.file(ids, badReading(ids.docId));
    filer.legEnded(ids, { resumable: legIsResumable('server-restart') });
    // No timer had to fire: the item is already on the row.
    expect(board.filed).toEqual(['t-season']);
  });
});

/* ===== A re-check is not a change of verdict ===== */

describe('a flag that cannot clear stops re-firing the item', () => {
  /** A filer with a standing item on one meeting, and the board it filed on. */
  const filedOnce = (): {
    board: ReturnType<typeof recordingBoard>;
    filer: ReturnType<typeof createNotesQualityFiler>;
    ids: { docId: string; meetingId: string };
  } => {
    const board = recordingBoard();
    const filer = createNotesQualityFiler({
      board: () => board,
      actor: ACTOR,
      schedule: new HandScheduler(),
      say: () => {},
    });
    const ids = { docId: 'd-harbour', meetingId: 'm-1' };
    filer.file(ids, badReading(ids.docId));
    filer.legEnded(ids, { resumable: false });
    expect(board.filed).toEqual(['t-season']);
    return { board, filer, ids };
  };

  it('leaves the item alone when a later reading says exactly the same thing', () => {
    // The 2026-09-15 shape: the same verdict at every leg stop, because the
    // number behind it could not come out any other way. Revising re-judges an
    // item, so a revision that changes nothing walks its reader back to a
    // question they have already answered.
    const { board, filer, ids } = filedOnce();
    for (let leg = 0; leg < 6; leg++) {
      filer.file(ids, badReading(ids.docId));
      filer.legEnded(ids, { resumable: false });
    }
    expect(board.filed).toEqual(['t-season']);
    expect(board.revised).toEqual([]);
  });

  it('THE CONTROL: a reading whose verdict changed does revise the item', () => {
    // Same meeting, same filer, one more repeated bullet — so the headline
    // and the detail both change. Without this the case above would pass on a
    // filer that had simply stopped revising at all.
    const { board, filer, ids } = filedOnce();
    filer.file(ids, badReading(ids.docId, 9));
    filer.legEnded(ids, { resumable: false });
    expect(board.filed).toEqual(['t-season']);
    expect(board.revised).toEqual(['ri-1']);
  });

  it('revises once for a change and not again for the repeat of it', () => {
    const { board, filer, ids } = filedOnce();
    for (let leg = 0; leg < 3; leg++) {
      filer.file(ids, badReading(ids.docId, 9));
      filer.legEnded(ids, { resumable: false });
    }
    expect(board.revised).toEqual(['ri-1']);
  });
});

/* ===== A reading that keeps failing, on a meeting that keeps growing ===== */

describe('an unreadable meeting is filed once however much more it hears', () => {
  /** One settled sentence with five content words, so every copy of it is one
   *  idea. Repeating it is how a transcript reaches an exact idea count. */
  const SPOKEN = 'The Riverbend ferry timetable changed again in March.';
  /** A sentence the notes below do NOT mention, for the mixed transcripts. */
  const UNNOTED = 'Harborlight slipway repairs slipped past the autumn window.';

  /** A reading of a meeting whose notes could not be found, over a transcript
   *  of exactly `ideas` settled sentences. */
  const unreadable = (docId: string, ideas: number): NotesQualityFileInput => {
    const report = buildNotesQualityReport({
      notes: '',
      transcript: Array.from({ length: ideas }, () => ({ text: SPOKEN })),
      notesRead: false,
      notesMissing: 'this meeting opened no section of its own',
    });
    // The premise of the case, asserted rather than assumed: the transcript
    // really did grow, and the verdict really is the unreadable one.
    expect(report.coverage.ideas).toBe(ideas);
    expect(report.coverage.source).toBe('unreadable');
    expect(report.flags.map((f) => f.kind)).toEqual(['notes-unread']);
    return { workspaceId: 'w-harbour', docId, report };
  };

  /** A reading that COULD read the notes, over a transcript of `noted` ideas
   *  the notes carry and `missed` ideas they do not. */
  const uncovered = (docId: string, noted: number, missed: number): NotesQualityFileInput => {
    const report = buildNotesQualityReport({
      notes: `## Meeting notes\n- ${SPOKEN}`,
      transcript: [
        ...Array.from({ length: noted }, () => ({ text: SPOKEN })),
        ...Array.from({ length: missed }, () => ({ text: UNNOTED })),
      ],
    });
    expect(report.coverage.source).toBe('notes');
    expect(report.flags.map((f) => f.kind)).toEqual(['coverage']);
    return { workspaceId: 'w-harbour', docId, report };
  };

  const filedWith = (
    first: NotesQualityFileInput,
  ): {
    board: ReturnType<typeof recordingBoard>;
    filer: ReturnType<typeof createNotesQualityFiler>;
    ids: { docId: string; meetingId: string };
  } => {
    const board = recordingBoard();
    const filer = createNotesQualityFiler({
      board: () => board,
      actor: ACTOR,
      schedule: new HandScheduler(),
      say: () => {},
    });
    const ids = { docId: 'd-harbour', meetingId: 'm-1' };
    filer.file(ids, first);
    filer.legEnded(ids, { resumable: false });
    expect(board.filed).toEqual(['t-season']);
    return { board, filer, ids };
  };

  it('never re-judges the item, across the denominators of 2026-09-15', () => {
    // THE INCIDENT, replayed. Seven legs of one meeting, each hearing more
    // than the last, each unable to read the notes. The reading is not the
    // same object at any two legs and its idea count differs at every one —
    // which is exactly why comparing the item's rendered WORDS could not
    // suppress this, and why the comparison is on the verdict instead.
    const { board, filer, ids } = filedWith(unreadable('d-harbour', 15));
    for (const ideas of [33, 75, 160, 199, 262]) {
      filer.file(ids, unreadable(ids.docId, ideas));
      filer.legEnded(ids, { resumable: false });
    }
    expect(board.filed).toEqual(['t-season']);
    expect(board.revised).toEqual([]);
  });

  it('THE CONTROL: a growing transcript DOES revise when the verdict moves', () => {
    // The same filer and the same growing transcript, with the notes readable
    // so the uncovered share is a real number. It goes 67% to 80%, the flag's
    // own words change, and the item is revised. Without this the case above
    // would pass on a filer that had stopped revising, or on one that ignored
    // every reading after the first.
    const { board, filer, ids } = filedWith(uncovered('d-harbour', 10, 20));
    filer.file(ids, uncovered(ids.docId, 10, 40));
    filer.legEnded(ids, { resumable: false });
    expect(board.revised).toEqual(['ri-1']);
  });

  it('holds the same line on the doc path, where the item is a comment', () => {
    // The doc path is a different pair of board calls, and a suppression that
    // only held for rows would have left every doc-filed meeting re-judging
    // once a leg. Same six denominators, same one filing.
    const board = recordingDocBoard();
    const filer = createNotesQualityFiler({
      board: () => board,
      actor: ACTOR,
      schedule: new HandScheduler(),
      say: () => {},
    });
    const ids = { docId: 'd-harbour', meetingId: 'm-1' };
    filer.file(ids, unreadable(ids.docId, 15));
    filer.legEnded(ids, { resumable: false });
    expect(board.filed).toEqual(['d-harbour']);
    for (const ideas of [33, 75, 160, 199, 262]) {
      filer.file(ids, unreadable(ids.docId, ideas));
      filer.legEnded(ids, { resumable: false });
    }
    expect(board.filed).toEqual(['d-harbour']);
    expect(board.revised).toEqual([]);
  });

  it('THE CONTROL: the doc path revises when the verdict does move', () => {
    const board = recordingDocBoard();
    const filer = createNotesQualityFiler({
      board: () => board,
      actor: ACTOR,
      schedule: new HandScheduler(),
      say: () => {},
    });
    const ids = { docId: 'd-harbour', meetingId: 'm-1' };
    filer.file(ids, uncovered(ids.docId, 10, 20));
    filer.legEnded(ids, { resumable: false });
    filer.file(ids, uncovered(ids.docId, 10, 40));
    filer.legEnded(ids, { resumable: false });
    expect(board.revised).toEqual(['c-1']);
  });

  /**
   * A readable reading whose uncovered share is as close to `pct` as the
   * transcript allows. `missed` ideas of `total` are absent from the notes,
   * so the share is `missed / total` exactly — no rounding to reason about.
   */
  const atShare = (docId: string, total: number, missed: number): NotesQualityFileInput => {
    const report = buildNotesQualityReport({
      notes: `## Meeting notes\n- ${SPOKEN}`,
      transcript: [
        ...Array.from({ length: total - missed }, () => ({ text: SPOKEN })),
        ...Array.from({ length: missed }, () => ({ text: UNNOTED })),
      ],
    });
    expect(report.coverage.uncoveredShare).toBeCloseTo(missed / total, 10);
    expect(report.flags.map((f) => f.kind)).toEqual(['coverage']);
    return { workspaceId: 'w-harbour', docId, report };
  };

  it('rides out the drift a growing meeting produces on its own', () => {
    // THE MEASURED SHAPE, lifted above the bar the flag fires at. Six legs
    // of one meeting whose note-taking quality never changed, drifting
    // 55%, 60%, 58%, 60%, 59%, 57% uncovered — the same 5-point spread a
    // synthetic run measured with the hit rate pinned. Every one of those
    // steps moves the rendered percentage and so the flag's words, and not
    // one of them is news. Across 200 seeded runs of that shape, 82% of
    // leg-to-leg transitions moved the rounded figure at all, so without the
    // band this is the COMMON case rather than an edge.
    const board = recordingDocBoard();
    const filer = createNotesQualityFiler({
      board: () => board,
      actor: ACTOR,
      schedule: new HandScheduler(),
      say: () => {},
    });
    const ids = { docId: 'd-harbour', meetingId: 'm-1' };
    const series: [number, number][] = [
      [100, 55],
      [100, 60],
      [100, 58],
      [100, 60],
      [100, 59],
      [100, 57],
    ];
    for (const [total, missed] of series) {
      filer.file(ids, atShare(ids.docId, total, missed));
      filer.legEnded(ids, { resumable: false });
    }
    expect(board.filed).toEqual(['d-harbour']);
    expect(board.revised).toEqual([]);
  });

  it('THE CONTROL: a step past the band revises, on the same series', () => {
    // The same first leg and the same filer, then one reading 30 points
    // further out. If the case above passed because the filer had stopped
    // revising at all, this one fails.
    const board = recordingDocBoard();
    const filer = createNotesQualityFiler({
      board: () => board,
      actor: ACTOR,
      schedule: new HandScheduler(),
      say: () => {},
    });
    const ids = { docId: 'd-harbour', meetingId: 'm-1' };
    filer.file(ids, atShare(ids.docId, 100, 55));
    filer.legEnded(ids, { resumable: false });
    filer.file(ids, atShare(ids.docId, 100, 85));
    filer.legEnded(ids, { resumable: false });
    expect(board.revised).toEqual(['c-1']);
  });

  it('THE SLOW RAMP: four steps each inside the band, crossing it in total', () => {
    // 55, 59, 63, 67. No step is more than 4 points, so a filer comparing
    // each reading against the PREVIOUS one suppresses all three and leaves
    // the item saying 55 while the meeting is at 67. Compared against what
    // the ITEM says, the fourth leg is 12 points out and revises — once.
    //
    // This is the case a later "simplification" to previous-reading
    // comparison would get wrong, which is why it is worth its runtime.
    const board = recordingDocBoard();
    const filer = createNotesQualityFiler({
      board: () => board,
      actor: ACTOR,
      schedule: new HandScheduler(),
      say: () => {},
    });
    const ids = { docId: 'd-harbour', meetingId: 'm-1' };
    for (const missed of [55, 59, 63, 67]) {
      filer.file(ids, atShare(ids.docId, 100, missed));
      filer.legEnded(ids, { resumable: false });
    }
    expect(board.filed).toEqual(['d-harbour']);
    expect(board.revised).toEqual(['c-1']);
  });

  it('THE SECOND CONTROL: a verdict that turns unreadable revises the item', () => {
    // A meeting whose first reading was a real coverage verdict and whose
    // second could not read the notes at all is telling its reader something
    // different, and must not be suppressed. This is what distinguishes the
    // fix from "never revise a notes-unread item".
    const { board, filer, ids } = filedWith(uncovered('d-harbour', 10, 20));
    filer.file(ids, unreadable(ids.docId, 30));
    filer.legEnded(ids, { resumable: false });
    expect(board.revised).toEqual(['ri-1']);
  });
});
