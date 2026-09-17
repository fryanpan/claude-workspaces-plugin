/**
 * WHEN a bad meeting's review item reaches a person, and how many of them
 * there are.
 *
 * THE FAILURE. The quality pass runs inside `notes.end()`, and `end()` is the
 * end of a recording LEG, not of a meeting: a dropped socket ends one and the
 * browser's resume picks the same meeting back up under the same id. So an
 * item reached Bryan's queue while he was still in the room, and the leg
 * after that filed a second item about the same meeting.
 *
 * HOW THIS FILE PROVES IT. Every case drives the real pass through the real
 * lifecycle — a scripted meeting, its notes composed by the stub model, and
 * the same `onLegEnded` call `meeting-protocol.ts` makes once the record is
 * stopped. `THE CONTROL` cases run the identical script with the filing
 * policy the base commit had (file straight from the pass, at every leg's
 * stop) and show the queue the fix removed: an item mid-meeting, and two by
 * the end.
 *
 * The engine is the scripted harness, no model is called, and every name is
 * fictional. The repo is public.
 */

import { describe, expect, it } from 'bun:test';
import { type Ref, type TaskReviewItem, prose } from '@claude-workspaces/core';
import type { Task } from '@claude-workspaces/core/task-wire';
import * as Y from 'yjs';
import { createNotesHeadingMemory } from '../src/meeting-notes-doc.ts';
import type { TickScheduler } from '../src/meeting-notes.ts';
import { type NotesQualityFiler, createNotesQualityFiler } from '../src/notes-quality-filing.ts';
import {
  type NotesQualityBoard,
  type NotesQualityFileInput,
  type NotesQualityFiling,
  fileNotesQualityReview,
} from '../src/notes-quality-review.ts';
import { type NotesTickHarness, addNotes, createNotesTickHarness } from './notes-tick-harness.ts';

const DOC = 'd-harbour';
/** ONE meeting id for every leg — that is what a resume means. */
const MEETING = 'm-1760000000001';
const ACTOR = { id: 'meeting-notes', name: 'Meeting Assistant' };

const NOTE = '- The Saltmarsh ferry keeps its winter crew until April';
/** A second line for a later leg to repeat, so the COUNT of repeats rises. */
const OTHER_NOTE = '- The slipway paint arrives on Friday, weather allowing';

/**
 * Put the note into the doc four more times, as a person pasting it would.
 *
 * The note-taker cannot write a repeat itself any more — the write path drops
 * one — so notes that repeat themselves reach the quality pass from outside
 * it, exactly as `notes-quality-line.test.ts` makes them.
 */
function pasteRepeats(harness: NotesTickHarness, line: string): void {
  prose.applyBlockEdits(
    harness.ydoc,
    [{ op: 'insert_at_end', markdown: [line, line, line, line].join('\n') }],
    {
      author: 'person-a',
      suggestionAuthor: { id: 'person-a', name: 'Harbour clerk', color: '#777777' },
    },
  );
}

/**
 * Take the pasted repeats back out of the doc, as a person tidying the notes
 * between two recordings does.
 *
 * It is what makes a LATER leg of one meeting read clean after an earlier one
 * flagged — the sequence this file's withdrawal cases are about, and the one
 * a filer that only ever hears about flagged readings cannot see.
 */
function tidyRepeats(ydoc: Y.Doc, line: string): void {
  const text = line.replace(/^- /, '');
  let kept = false;
  const gone: string[] = [];
  for (const entry of prose.readOutline(ydoc)) {
    if (entry.text !== text) continue;
    if (kept) gone.push(entry.id);
    else kept = true;
  }
  prose.applyBlockEdits(
    ydoc,
    gone.map((blockId) => ({ op: 'delete_block', blockId })),
    {
      author: 'person-a',
      suggestionAuthor: { id: 'person-a', name: 'Harbour clerk', color: '#777777' },
    },
  );
}

/** A board that remembers every filing, revision and withdrawal it was asked for. */
interface Recorder extends NotesQualityBoard {
  readonly filed: string[];
  readonly revised: Array<{ itemId: string; headline: string }>;
  readonly withdrawn: string[];
}

function recordingBoard(): Recorder {
  const filed: string[] = [];
  const revised: Array<{ itemId: string; headline: string }> = [];
  const withdrawn: string[] = [];
  const row = { id: 't-season', status: 'todo' } as Task;
  let n = 0;
  return {
    filed,
    revised,
    withdrawn,
    backlinksFor: (_ref: Ref) => [row],
    addReviewItem: (taskId) => {
      n += 1;
      filed.push(taskId);
      return { ok: true as const, task: row, item: { id: `ri-${n}` } as TaskReviewItem };
    },
    reviseReviewItem: (_taskId, reviewItemId, patch) => {
      revised.push({ itemId: reviewItemId, headline: String(patch.headline ?? '') });
      return { ok: true as const };
    },
    withdrawReviewItem: (_taskId, reviewItemId) => {
      withdrawn.push(reviewItemId);
      return { ok: true as const };
    },
  };
}

/** A scheduler the test fires by hand, so the resume grace costs no wall clock. */
class HandScheduler implements TickScheduler {
  private fns = new Map<number, () => void>();
  private n = 0;
  set(fn: () => void, _ms: number): unknown {
    this.n += 1;
    this.fns.set(this.n, fn);
    return this.n;
  }
  clear(handle: unknown): void {
    this.fns.delete(handle as number);
  }
  get armed(): number {
    return this.fns.size;
  }
  fire(): void {
    for (const fn of [...this.fns.values()]) fn();
    this.fns.clear();
  }
}

/**
 * The base commit's policy, as a filer: every reading files the moment the
 * pass produces it, which is inside `end()`. Nothing holds and nothing
 * remembers — the two properties the fix adds.
 */
function baseFiler(board: NotesQualityBoard): NotesQualityFiler {
  return {
    file: (_ids, input: NotesQualityFileInput): NotesQualityFiling =>
      fileNotesQualityReview(board, ACTOR, input),
    legEnded: () => {},
    legBegan: () => {},
    heldCount: () => 0,
  };
}

/** One meeting across several legs: one doc, one heading memory, one filer. */
function meeting(filer: NotesQualityFiler, board: NotesQualityBoard) {
  const ydoc = new Y.Doc();
  const heading = createNotesHeadingMemory();
  const shared = {
    ydoc,
    heading,
    docId: DOC,
    meetingId: MEETING,
    workspaceId: 'w-harbour',
    qualityBoard: board,
    qualityFiler: filer,
  } as const;
  /**
   * One recording leg: it hears a sentence, the model writes the repeated
   * bullets, and then the leg ends the way `resumable` says.
   */
  return async function leg(opts: {
    say: string;
    notes?: string;
    /** Extra markdown a person left in the doc before the leg stopped. */
    paste?: string;
    /**
     * A leg whose notes come out past no bar: the repeats an earlier leg left
     * are tidied away before it starts, and it leaves none of its own. This
     * is the reading that used to reach nothing.
     */
    clean?: boolean;
    resumable: boolean;
  }): Promise<NotesTickHarness> {
    const harness = createNotesTickHarness({
      ...shared,
      compose: (input, tick) => (tick === 1 ? addNotes(input, opts.notes ?? NOTE) : []),
    });
    if (opts.clean) tidyRepeats(harness.ydoc, NOTE);
    await harness.speak(opts.say);
    if (!opts.clean) pasteRepeats(harness, NOTE);
    if (opts.paste !== undefined) {
      prose.applyBlockEdits(harness.ydoc, [{ op: 'insert_at_end', markdown: opts.paste }], {
        author: 'person-a',
        suggestionAuthor: { id: 'person-a', name: 'Harbour clerk', color: '#777777' },
      });
    }
    await harness.end();
    harness.legEnded(opts.resumable);
    return harness;
  };
}

describe('a quality item waits for the meeting to be over', () => {
  it('files nothing while a meeting keeps dropping and resuming', async () => {
    const board = recordingBoard();
    const schedule = new HandScheduler();
    const filer = createNotesQualityFiler({
      board: () => board,
      actor: ACTOR,
      schedule,
      say: () => {},
    });
    const leg = meeting(filer, board);

    const first = await leg({
      say: 'The Saltmarsh ferry keeps its winter crew until April.',
      resumable: true,
    });
    // The stop's own line still reports the notes exactly as it did: the
    // counts, the flags, and now where the item is — waiting, not missing.
    expect(first.summary()).not.toBeNull();
    expect(board.filed).toEqual([]);

    await leg({
      say: 'The slipway paint arrives on Friday, weather allowing.',
      resumable: true,
    });
    expect(board.filed).toEqual([]);

    // Each resume disarmed the grace the drop before it armed, so exactly one
    // is waiting — for the drop that just happened, and no earlier one.
    expect(schedule.armed).toBe(1);
    // And the reading being held is the one the SECOND leg took, not the
    // stale one from before the reconnect: one meeting, one reading.
    expect(filer.heldCount()).toBe(1);
  });

  it('files exactly one item, once the person stops the meeting', async () => {
    const board = recordingBoard();
    const schedule = new HandScheduler();
    const filer = createNotesQualityFiler({
      board: () => board,
      actor: ACTOR,
      schedule,
      say: () => {},
    });
    const leg = meeting(filer, board);

    await leg({ say: 'The winter crew stays on.', resumable: true });
    await leg({ say: 'The paint arrives on Friday.', resumable: true });
    expect(board.filed).toEqual([]);

    await leg({ say: 'That is everything for today.', resumable: false });
    expect(board.filed).toEqual(['t-season']);
    expect(board.revised).toEqual([]);
  });

  it('files the held reading when a dropped meeting is never picked back up', async () => {
    const board = recordingBoard();
    const schedule = new HandScheduler();
    const filer = createNotesQualityFiler({
      board: () => board,
      actor: ACTOR,
      schedule,
      say: () => {},
    });
    const leg = meeting(filer, board);

    await leg({ say: 'The winter crew stays on.', resumable: true });
    expect(board.filed).toEqual([]);
    // Nobody reconnected: the grace runs out and the item goes where it
    // always went. A held item must not be a lost one.
    schedule.fire();
    expect(board.filed).toEqual(['t-season']);
  });

  it('revises the one item when a later reading counts more of the same defect', async () => {
    const board = recordingBoard();
    const schedule = new HandScheduler();
    const filer = createNotesQualityFiler({
      board: () => board,
      actor: ACTOR,
      schedule,
      say: () => {},
    });
    const leg = meeting(filer, board);

    await leg({ say: 'The winter crew stays on.', resumable: false });
    expect(board.filed).toEqual(['t-season']);

    // The meeting is picked back up and goes further wrong: a SECOND line
    // repeated, so the count of repeated bullets rises rather than the
    // total they are counted out of.
    //
    // It used to paste a topic opened twice, which measured nothing. A
    // pasted heading ENDS the meeting's section, so that heading and
    // everything under it fell outside the reading and `duplicateHeadings`
    // stayed 0 — on this branch and on the base commit alike. What made the
    // case pass was the denominator moving, `4 repeated bullets of 5` to
    // `of 7`, which is the drift the revise band exists to ignore.
    await leg({
      say: 'One more thing about the slipway before we go.',
      paste: [OTHER_NOTE, OTHER_NOTE, OTHER_NOTE, OTHER_NOTE].join('\n'),
      resumable: false,
    });

    // ONE item still, with its words rewritten rather than a second ask.
    expect(board.filed).toEqual(['t-season']);
    expect(board.revised).toHaveLength(1);
    expect(board.revised[0]?.itemId).toBe('ri-1');
    expect(board.revised[0]?.headline).toContain('came out badly');
  });
});

describe('a quality item is taken back when the meeting ends clean', () => {
  /** A filer over a recording board, with the grace on a hand clock. */
  const filerOver = (
    board: NotesQualityBoard,
    schedule: HandScheduler,
  ): ReturnType<typeof createNotesQualityFiler> =>
    createNotesQualityFiler({ board: () => board, actor: ACTOR, schedule, say: () => {} });

  it('leaves no standing item when the first leg flags and the last reads clean', async () => {
    // The whole lifecycle, legs in order: a meeting that went wrong, the
    // notes tidied, and a second recording that reads them past no bar. The
    // item filed at the first leg must not still be on the queue claiming
    // otherwise.
    const board = recordingBoard();
    const filer = filerOver(board, new HandScheduler());
    const leg = meeting(filer, board);

    await leg({ say: 'The winter crew stays on.', resumable: false });
    expect(board.filed).toEqual(['t-season']);

    const last = await leg({
      say: 'We tidied those repeats out before we carried on.',
      clean: true,
      resumable: false,
    });
    // The premise of the case, read off the real pass rather than assumed:
    // this leg really did come out past no bar.
    expect(last.summary()).not.toBeNull();

    expect(board.withdrawn).toEqual(['ri-1']);
    expect(board.filed).toEqual(['t-season']);
    expect(board.revised).toEqual([]);
  });

  it('THE CONTROL: a meeting whose last leg still flags keeps its item', async () => {
    // The same two legs the other way round. This is what fails if a
    // withdrawal is taken on any clean reading rather than on the meeting's
    // last one.
    const board = recordingBoard();
    const filer = filerOver(board, new HandScheduler());
    const leg = meeting(filer, board);

    await leg({ say: 'We tidied those repeats out first.', clean: true, resumable: false });
    expect(board.filed).toEqual([]);
    expect(board.withdrawn).toEqual([]);

    await leg({ say: 'And then it went wrong again.', resumable: false });

    expect(board.filed).toEqual(['t-season']);
    expect(board.withdrawn).toEqual([]);
  });

  it('withdraws nothing while the grace is still running', async () => {
    // A clean leg that DROPPED is not the end of the meeting. Withdrawing
    // there would take the item off the queue and put it straight back when
    // the resumed leg goes wrong again — asserted on the board's calls,
    // because that sequence and never-withdrawing end in the same state.
    const board = recordingBoard();
    const schedule = new HandScheduler();
    const filer = filerOver(board, schedule);
    const leg = meeting(filer, board);

    await leg({ say: 'The winter crew stays on.', resumable: false });
    expect(board.filed).toEqual(['t-season']);

    await leg({ say: 'That reads better now.', clean: true, resumable: true });
    expect(board.withdrawn).toEqual([]);
    expect(schedule.armed).toBe(1);

    await leg({ say: 'One more thing, and it repeated itself.', resumable: false });

    expect(board.withdrawn).toEqual([]);
    expect(board.filed).toEqual(['t-season']);
  });
});

describe('THE CONTROL: the base commit’s policy, same scripts', () => {
  it('puts an item in front of the person mid-meeting', async () => {
    const board = recordingBoard();
    const leg = meeting(baseFiler(board), board);
    // A leg that a reconnect is about to resume — the meeting is not over.
    await leg({ say: 'The winter crew stays on.', resumable: true });
    // The assertion the fixed build makes is `toEqual([])`. It fails here,
    // which is the defect.
    expect(board.filed).toEqual(['t-season']);
  });

  it('files a second item for the same meeting at the next leg’s stop', async () => {
    const board = recordingBoard();
    const leg = meeting(baseFiler(board), board);
    await leg({ say: 'The winter crew stays on.', resumable: true });
    await leg({ say: 'The paint arrives on Friday.', resumable: false });
    expect(board.filed).toEqual(['t-season', 't-season']);
    expect(board.revised).toEqual([]);
  });
});
