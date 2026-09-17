/**
 * A meeting that outlives the process its item was filed from.
 *
 * THE FAILURE THIS FILE EXISTS TO END. A server restart ends a recording leg,
 * and it is the one leg-ending that is never held for a resume — a hold is a
 * timer the restarting process exits before it can fire, so the item files at
 * once rather than risking being lost. The browser then resumes across that
 * same gap, because `meeting-reconnect.ts` treats a deploy's restart as
 * invisible to the recording. So the meeting carried on, ended clean in the
 * NEW process, found no filing to take back, and left a reader holding an ask
 * their own meeting had disproved. That is the commonest way one of these
 * reaches a person mid-meeting.
 *
 * HOW THIS FILE MODELS A RESTART: two filers over ONE data dir. Nothing else
 * is shared — no map, no board memory, no clock — which is exactly what a new
 * process has, and the file on disk is the only thing that can carry the
 * meeting across.
 *
 * THE CONTROLS ARE AT THE BOTTOM, and there are two of them because the two
 * ways this can be wrong fail in opposite directions: a store that is written
 * and never read, and one that is read and never written. Both pass every
 * single-process case in `notes-quality-withdrawal.test.ts`, and both lose the
 * withdrawal here.
 *
 * Every name is invented. The repo is public.
 */

import { afterAll, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type NotesQualityFiledStore,
  createNotesQualityFiledFileStore,
  notesQualityFiledPath,
} from '../src/notes-quality-filed-store.ts';
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

const dirs: string[] = [];
const freshDataDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'cw-quality-restart-'));
  dirs.push(dir);
  return dir;
};

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const ids = { docId: 'd-harbour', meetingId: 'm-1760000000001' };

/**
 * One server process: a filer over the given board, remembering where it
 * filed in `dataDir`.
 *
 * A fresh `HandScheduler` per process on purpose — a timer does not survive a
 * restart, and a test that shared one would be modelling something no server
 * has.
 */
const processOver = (
  board: Recorder,
  store?: NotesQualityFiledStore,
): ReturnType<typeof createNotesQualityFiler> =>
  createNotesQualityFiler({
    board: () => board,
    actor: ACTOR,
    schedule: new HandScheduler(),
    say: () => {},
    ...(store ? { filedStore: store } : {}),
  });

describe('an item filed by a restart is taken back by the meeting that outlived it', () => {
  it('withdraws the item the previous process filed, and files no second one', () => {
    // The whole failure, end to end. The restart's own leg end is not
    // resumable, so the first process files at once; the browser resumes into
    // the second process and the person stops the meeting there.
    const dataDir = freshDataDir();
    const board = recordingBoard();

    const before = processOver(board, createNotesQualityFiledFileStore(dataDir));
    before.file(ids, badReading(ids.docId));
    before.legEnded(ids, { resumable: false });
    expect(board.filed).toEqual(['t-season']);
    // The durable half exists before the restart — the half a store that
    // never writes would be missing, which no single-process case can see.
    expect(createNotesQualityFiledFileStore(dataDir).read(ids)?.filed).toEqual({
      kind: 'row',
      taskId: 't-season',
      itemId: 'ri-1',
    });

    const after = processOver(board, createNotesQualityFiledFileStore(dataDir));
    after.file(ids, cleanReading(ids.docId));
    after.legEnded(ids, { resumable: false });

    expect(board.withdrawn).toEqual(['ri-1']);
    expect(board.filed).toEqual(['t-season']);
    expect(board.revised).toEqual([]);
  });

  it('takes the comment back on the doc path too', () => {
    // A meeting whose doc has no row files on the doc itself, and that is a
    // different pair of board calls with a different pair of ids to carry.
    const dataDir = freshDataDir();
    const board = recordingDocBoard();

    const before = processOver(board, createNotesQualityFiledFileStore(dataDir));
    before.file(ids, badReading(ids.docId));
    before.legEnded(ids, { resumable: false });
    expect(board.filed).toEqual(['d-harbour']);

    const after = processOver(board, createNotesQualityFiledFileStore(dataDir));
    after.file(ids, cleanReading(ids.docId));
    after.legEnded(ids, { resumable: false });

    expect(board.withdrawn).toEqual(['c-1']);
    expect(board.filed).toEqual(['d-harbour']);
  });

  it('revises the standing item when the meeting goes wrong again after the restart', () => {
    // Never a second ask about one meeting — the rule the memory exists for,
    // now across the restart as well as across a dropped socket.
    const dataDir = freshDataDir();
    const board = recordingBoard();

    const before = processOver(board, createNotesQualityFiledFileStore(dataDir));
    before.file(ids, badReading(ids.docId));
    before.legEnded(ids, { resumable: false });

    const after = processOver(board, createNotesQualityFiledFileStore(dataDir));
    after.file(ids, badReading(ids.docId, 9));
    after.legEnded(ids, { resumable: false });

    expect(board.filed).toEqual(['t-season']);
    expect(board.revised).toEqual(['ri-1']);
  });

  it('does not re-judge an item the new process reads the same way', () => {
    // THE MUTATION THIS CATCHES: persisting the ask without the verdict it
    // carries. Every restart would then revise the item with words it already
    // has, and revising re-judges it — which walks the reader back to a
    // question they have already seen.
    const dataDir = freshDataDir();
    const board = recordingBoard();

    const before = processOver(board, createNotesQualityFiledFileStore(dataDir));
    before.file(ids, badReading(ids.docId));
    before.legEnded(ids, { resumable: false });

    const after = processOver(board, createNotesQualityFiledFileStore(dataDir));
    after.file(ids, badReading(ids.docId));
    after.legEnded(ids, { resumable: false });

    expect(board.revised).toEqual([]);
    expect(board.filed).toEqual(['t-season']);
  });

  it('files a fresh item, not a revision, after a withdrawal and another restart', () => {
    // The record goes with the item it names. A third process finding one
    // would revise an ask nobody is being asked any more.
    const dataDir = freshDataDir();
    const board = recordingBoard();

    const before = processOver(board, createNotesQualityFiledFileStore(dataDir));
    before.file(ids, badReading(ids.docId));
    before.legEnded(ids, { resumable: false });

    const during = processOver(board, createNotesQualityFiledFileStore(dataDir));
    during.file(ids, cleanReading(ids.docId));
    during.legEnded(ids, { resumable: false });
    expect(board.withdrawn).toEqual(['ri-1']);
    expect(existsSync(notesQualityFiledPath(dataDir, ids.docId, ids.meetingId))).toBe(false);

    const after = processOver(board, createNotesQualityFiledFileStore(dataDir));
    after.file(ids, badReading(ids.docId));
    after.legEnded(ids, { resumable: false });

    expect(board.filed).toEqual(['t-season', 't-season']);
    expect(board.revised).toEqual([]);
  });

  it('leaves no memory behind when the restart filed nothing', () => {
    // The case that catches a store which writes a record on every leg. A
    // meeting that crossed no bar is the commonest meeting there is, and the
    // next process must find nothing at all to act on.
    const dataDir = freshDataDir();
    const board = recordingBoard();

    const before = processOver(board, createNotesQualityFiledFileStore(dataDir));
    before.file(ids, cleanReading(ids.docId));
    before.legEnded(ids, { resumable: false });

    expect(board.filed).toEqual([]);
    expect(existsSync(notesQualityFiledPath(dataDir, ids.docId, ids.meetingId))).toBe(false);
    expect(createNotesQualityFiledFileStore(dataDir).read(ids)).toBeUndefined();

    const after = processOver(board, createNotesQualityFiledFileStore(dataDir));
    after.file(ids, cleanReading(ids.docId));
    after.legEnded(ids, { resumable: false });

    expect(board.filed).toEqual([]);
    expect(board.withdrawn).toEqual([]);
    expect(board.revised).toEqual([]);
  });

  it('leaves no memory behind for a reading the restart never committed', () => {
    // A flagged reading held for a resume, and the process gone before the
    // grace fired. Nothing was filed, so there is nothing to remember — and a
    // record written at `file()` rather than at the filing would name an ask
    // that does not exist.
    const dataDir = freshDataDir();
    const board = recordingBoard();

    const before = processOver(board, createNotesQualityFiledFileStore(dataDir));
    before.file(ids, badReading(ids.docId));
    before.legEnded(ids, { resumable: true });

    expect(board.filed).toEqual([]);
    expect(existsSync(notesQualityFiledPath(dataDir, ids.docId, ids.meetingId))).toBe(false);
  });

  it('files rather than withdraws when the record is too old to trust', () => {
    // The age bound, from the filer's side: a record past it is not a reason
    // to revise an item a reader dealt with a long time ago. A fresh ask is
    // the safe direction.
    const dataDir = freshDataDir();
    const board = recordingBoard();
    let clock = 1_800_000_000_000;
    const store = (): NotesQualityFiledStore =>
      createNotesQualityFiledFileStore(dataDir, { now: () => clock });

    const before = processOver(board, store());
    before.file(ids, badReading(ids.docId));
    before.legEnded(ids, { resumable: false });

    clock += 2 * 24 * 60 * 60 * 1000;
    const after = processOver(board, store());
    after.file(ids, badReading(ids.docId));
    after.legEnded(ids, { resumable: false });

    expect(board.filed).toEqual(['t-season', 't-season']);
    expect(board.revised).toEqual([]);
  });
});

describe('THE CONTROLS: a store broken in each direction', () => {
  /** Wrap a real store so one half of it stops working. */
  const halfStore = (
    dataDir: string,
    half: 'never-reads' | 'never-writes',
  ): NotesQualityFiledStore => {
    const real = createNotesQualityFiledFileStore(dataDir);
    return {
      read: (i) => (half === 'never-reads' ? undefined : real.read(i)),
      write: (i, item) => {
        if (half !== 'never-writes') real.write(i, item);
      },
      clear: (i) => real.clear(i),
    };
  };

  for (const half of ['never-reads', 'never-writes'] as const) {
    it(`loses the withdrawal when the store ${half}`, () => {
      // Both halves pass every case that lives in one process, and both leave
      // the reader holding the ask their meeting disproved.
      const dataDir = freshDataDir();
      const board = recordingBoard();

      const before = processOver(board, halfStore(dataDir, half));
      before.file(ids, badReading(ids.docId));
      before.legEnded(ids, { resumable: false });
      expect(board.filed).toEqual(['t-season']);

      const after = processOver(board, halfStore(dataDir, half));
      after.file(ids, cleanReading(ids.docId));
      after.legEnded(ids, { resumable: false });

      // The assertion the working build makes is `['ri-1']`.
      expect(board.withdrawn).toEqual([]);
    });
  }

  it('loses it just as completely with no store at all', () => {
    // The base commit's behaviour, on the same script: the memory was a map
    // in the process, so the new process knew nothing.
    const board = recordingBoard();

    const before = processOver(board);
    before.file(ids, badReading(ids.docId));
    before.legEnded(ids, { resumable: false });

    const after = processOver(board);
    after.file(ids, cleanReading(ids.docId));
    after.legEnded(ids, { resumable: false });

    expect(board.withdrawn).toEqual([]);
    expect(board.filed).toEqual(['t-season']);
  });
});
