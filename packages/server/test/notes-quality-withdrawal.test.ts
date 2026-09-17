/**
 * A quality item whose claim stopped being true is taken back.
 *
 * THE FAILURE THIS FILE EXISTS TO END. The pass runs once per recording LEG,
 * and only FLAGGED readings used to reach the filer — so a meeting whose
 * first leg came out badly filed an item saying so, and the later legs that
 * read fine reached nothing at all. The item stood on a reader's queue
 * claiming something the meeting had since disproved. Measured over 200
 * seeded runs of a six-leg meeting, the uncovered share straddles its own 50%
 * bar between legs (one run: 45, 50, 48, 50, 49, 47), so a flag appearing and
 * disappearing mid-meeting is the ordinary case rather than a corner.
 *
 * AND THE WITHDRAWAL IS HELD EXACTLY AS THE FILING IS. It is decided at
 * commit, on the meeting's LAST reading — never at the moment a flag clears,
 * because a clean leg can be followed by another bad one and a withdrawal
 * mid-grace would take the item away and put it back. The mid-grace case
 * below asserts on the BOARD'S CALLS rather than on the final state, because
 * withdraw-then-refile and never-withdrawing end in the same place.
 *
 * `notes-quality-timing.test.ts` proves the same three things through a
 * scripted meeting and the real pass; what is here is the filer's own edges —
 * a refusal, a board that cannot withdraw, and the doc path.
 *
 * Every name and every note is invented. The repo is public.
 */

import { describe, expect, it } from 'bun:test';
import { createNotesQualityFiler } from '../src/notes-quality-filing.ts';
import {
  ACTOR,
  HandScheduler,
  type Recorder,
  badReading,
  cleanReading,
  recordingBoard,
  recordingDocBoard,
} from './notes-quality-board-harness.ts';

describe('an item whose meeting went on to read clean is withdrawn', () => {
  /** A filer, its board's clock, and one meeting's ids. */
  const scene = (
    board: Recorder,
  ): {
    filer: ReturnType<typeof createNotesQualityFiler>;
    schedule: HandScheduler;
    ids: { docId: string; meetingId: string };
  } => {
    const schedule = new HandScheduler();
    return {
      schedule,
      filer: createNotesQualityFiler({ board: () => board, actor: ACTOR, schedule, say: () => {} }),
      ids: { docId: 'd-harbour', meetingId: 'm-1' },
    };
  };

  it('ends with no standing item when the first leg flags and the last reads clean', () => {
    const board = recordingBoard();
    const { filer, ids } = scene(board);

    filer.file(ids, badReading(ids.docId));
    filer.legEnded(ids, { resumable: false });
    expect(board.filed).toEqual(['t-season']);

    filer.file(ids, cleanReading(ids.docId));
    filer.legEnded(ids, { resumable: false });

    expect(board.withdrawn).toEqual(['ri-1']);
    expect(board.filed).toEqual(['t-season']);
    expect(board.revised).toEqual([]);
  });

  it('a clean leg before a flagged one still leaves the flagged one filed', () => {
    // NOT a control on the withdrawal rule, and it was labelled as one. With
    // the legs reversed there is no item when the clean reading arrives, so
    // no policy could withdraw anything here and every mutation of `withdraw`
    // passes. What it does catch is the OTHER half: a clean reading held and
    // then committed must not leave the entry in a state where the next leg's
    // flagged reading files nothing — which is what happens if the clean
    // commit clears more than the item, or if it marks the meeting done.
    //
    // The cases that discriminate the withdrawal rule are the two below: make
    // `withdraw` unconditional and 'withdraws nothing mid-grace when a clean
    // leg is followed by a bad one' and 'withdraws when a clean drop is never
    // picked back up' are the ones that go red.
    const board = recordingBoard();
    const { filer, ids } = scene(board);

    filer.file(ids, cleanReading(ids.docId));
    filer.legEnded(ids, { resumable: false });
    expect(board.filed).toEqual([]);
    expect(board.withdrawn).toEqual([]);

    filer.file(ids, badReading(ids.docId));
    filer.legEnded(ids, { resumable: false });

    expect(board.filed).toEqual(['t-season']);
    expect(board.withdrawn).toEqual([]);
  });

  it('withdraws nothing mid-grace when a clean leg is followed by a bad one', () => {
    // THE MUTATION THIS CATCHES: withdrawing the moment a clean reading
    // arrives instead of at the grace's expiry — 'withdraw when the flag
    // clears'. Under it `board.withdrawn` reads ['ri-1'] at the first check
    // below, and the item Bryan needed is gone for a meeting that went on to
    // go wrong.
    const board = recordingBoard();
    const { filer, schedule, ids } = scene(board);

    filer.file(ids, badReading(ids.docId));
    filer.legEnded(ids, { resumable: false });
    expect(board.filed).toEqual(['t-season']);

    // The leg that read clean — and dropped rather than stopped.
    filer.file(ids, cleanReading(ids.docId));
    filer.legEnded(ids, { resumable: true });
    expect(board.withdrawn).toEqual([]);
    expect(schedule.armed).toBe(1);

    // The browser reconnects inside the grace, and the meeting goes wrong
    // again before the person stops it.
    filer.legBegan(ids);
    expect(schedule.armed).toBe(0);
    filer.file(ids, badReading(ids.docId));
    filer.legEnded(ids, { resumable: false });

    expect(board.withdrawn).toEqual([]);
    expect(board.filed).toEqual(['t-season']);
  });

  it('withdraws when a clean drop is never picked back up', () => {
    // The other side of the grace: nobody reconnected, so the clean reading
    // IS the meeting's last word and the item goes when the grace expires.
    //
    // THE MUTATION THIS CATCHES: holding the withdrawal forever — treating a
    // resumable end as never final, so a meeting whose last word was clean
    // keeps its item indefinitely. It pairs with the case above: that one
    // fails if the withdrawal fires too early, this one if it never fires.
    const board = recordingBoard();
    const { filer, schedule, ids } = scene(board);

    filer.file(ids, badReading(ids.docId));
    filer.legEnded(ids, { resumable: false });
    filer.file(ids, cleanReading(ids.docId));
    filer.legEnded(ids, { resumable: true });
    expect(board.withdrawn).toEqual([]);

    schedule.fire();
    expect(board.withdrawn).toEqual(['ri-1']);
  });

  it('does nothing at all for a clean meeting that never had an item', () => {
    // Every reading reaches the filer now, and the commonest reading by far
    // is a meeting that went fine. It must not file, withdraw or hold.
    const board = recordingBoard();
    const { filer, ids } = scene(board);

    filer.file(ids, cleanReading(ids.docId));
    filer.legEnded(ids, { resumable: false });

    expect(board.filed).toEqual([]);
    expect(board.withdrawn).toEqual([]);
    expect(board.revised).toEqual([]);
    expect(filer.heldCount()).toBe(0);
  });

  it('files a fresh item, not a revision, when a withdrawn meeting goes wrong again', () => {
    // The memory of where the item went is dropped with the item. Revising a
    // withdrawn ask would rewrite something nobody is being asked any more.
    const board = recordingBoard();
    const { filer, ids } = scene(board);

    filer.file(ids, badReading(ids.docId));
    filer.legEnded(ids, { resumable: false });
    filer.file(ids, cleanReading(ids.docId));
    filer.legEnded(ids, { resumable: false });
    expect(board.withdrawn).toEqual(['ri-1']);

    filer.file(ids, badReading(ids.docId));
    filer.legEnded(ids, { resumable: false });

    expect(board.filed).toEqual(['t-season', 't-season']);
    expect(board.revised).toEqual([]);
  });

  it('leaves the item standing when the board refuses the withdrawal', () => {
    // An item somebody already answered refuses, and should: withdrawing it
    // would retract their answer. The item stays addressable, so a later bad
    // leg revises it rather than raising a second ask beside it.
    const board = recordingBoard();
    const refusing: Recorder = {
      ...board,
      withdrawReviewItem: () => ({ ok: false as const, error: 'answered' }),
    };
    const { filer, ids } = scene(refusing);

    filer.file(ids, badReading(ids.docId));
    filer.legEnded(ids, { resumable: false });
    filer.file(ids, cleanReading(ids.docId));
    filer.legEnded(ids, { resumable: false });
    expect(board.withdrawn).toEqual([]);

    filer.file(ids, badReading(ids.docId, 9));
    filer.legEnded(ids, { resumable: false });
    expect(board.filed).toEqual(['t-season']);
    expect(board.revised).toEqual(['ri-1']);
  });

  it('leaves the item standing on a board with no way to withdraw at all', () => {
    // The board shape this change found. It must not throw, and it must not
    // file a second item to compensate.
    const board = recordingBoard();
    const { withdrawReviewItem, ...noWithdraw } = board;
    expect(withdrawReviewItem).toBeDefined();
    const { filer, ids } = scene(noWithdraw as Recorder);

    filer.file(ids, badReading(ids.docId));
    filer.legEnded(ids, { resumable: false });
    filer.file(ids, cleanReading(ids.docId));
    filer.legEnded(ids, { resumable: false });

    expect(board.filed).toEqual(['t-season']);
    expect(board.withdrawn).toEqual([]);
  });

  it('takes the item back on the doc path too, where it is a comment', () => {
    // A different pair of board calls, and a withdrawal that only held for
    // rows would leave every doc-filed meeting's item standing.
    const board = recordingDocBoard();
    const { filer, ids } = scene(board);

    filer.file(ids, badReading(ids.docId));
    filer.legEnded(ids, { resumable: false });
    expect(board.filed).toEqual(['d-harbour']);

    filer.file(ids, cleanReading(ids.docId));
    filer.legEnded(ids, { resumable: false });

    expect(board.withdrawn).toEqual(['c-1']);
    expect(board.revised).toEqual([]);
  });
});
