/**
 * The durable half of the note-taker's memory: which heading a meeting is
 * writing its notes under, written beside the meeting's own transcript.
 *
 * WHY IT IS ON DISK AT ALL. The heading id is what makes a rename a non-event
 * and what stops a tick opening a second `Meeting notes` section — but it
 * lived in a `Map` in one process, so it died with the process. This repo
 * deploys mid-day. A meeting that had already written half its notes came back
 * to a note-taker that remembered no section, opened a second one below the
 * first, and left one conversation split across two headings.
 *
 * BESIDE THE MEETING, NOT IN A REGISTRY OF ITS OWN. The file sits in the
 * meeting's directory with its transcript and its timing log, named after the
 * meeting, so the three are found together and deleted together — deleting a
 * meeting's folder must not leave a note-taker remembering a section in a
 * doc it can no longer explain.
 *
 * NOTHING HERE THROWS. A note-taker whose disk is full or whose data dir has
 * gone read-only must still take notes; it simply takes them the way it did
 * before this file existed, remembering the heading for as long as the process
 * lives. Every failure is one log line and a fallback, never an exception into
 * the compose chain.
 *
 * IT HOLDS NO MEETING CONTENT — a doc id, a meeting id and a block id. The
 * words are in the transcript beside it.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { meetingDirPath, meetingSectionPath } from './meetings.ts';

/** What a heading record is keyed by — the same pair the in-memory map uses. */
export interface NotesHeadingIds {
  docId: string;
  meetingId: string;
}

/**
 * Where the heading a meeting opened is kept between ticks.
 *
 * An interface rather than the file functions directly, so the memory can be
 * built with no store at all (the tests that model two meetings in one
 * process) or with a fake.
 */
export interface NotesHeadingStore {
  /** The heading this meeting opened, or `undefined` for a meeting that has
   *  opened none — including one whose record is unreadable, which is the
   *  same answer and not an error. */
  read(ids: NotesHeadingIds): string | undefined;
  /** Remember this heading for this meeting. */
  write(ids: NotesHeadingIds, headingId: string): void;
  /** Forget it: the heading is gone from the doc, so a later tick addressing
   *  it would fail with `unknown-block` for the rest of the meeting. */
  clear(ids: NotesHeadingIds): void;
  /**
   * This meeting has STOPPED, at `at`.
   *
   * The record is what tells the next recording whether the section it is
   * looking at belongs to a meeting that is still going or to one that is
   * over, and those two answers are opposite: a live meeting's section is
   * that meeting's, and a finished one's is the doc's own notes to continue.
   * Nothing else on disk can say it — a meeting killed with the process
   * leaves the same files behind as one somebody stopped.
   */
  finish(ids: NotesHeadingIds, at: number): void;
  /**
   * Every section ANY meeting on this doc has recorded, with the moment its
   * meeting stopped where there is one.
   *
   * The durable answer to "whose is this heading", and the only one that
   * survives `releaseNotesAuthorship` — which drops every claim when a
   * recording starts, so a stopped meeting's minutes are indistinguishable
   * from a person's notes by authorship alone.
   *
   * Optional so a fake store in a test need not grow a method to keep
   * compiling; absent, the caller sees only what the process remembers.
   */
  claimsIn?(docId: string): readonly NotesSectionClaim[];
}

/** One meeting's record of the section it wrote under, as a later recording
 *  reads it back. `endedAt` is absent for a meeting that never stopped —
 *  one recording now, or one the process died under. */
export interface NotesSectionClaim {
  headingId: string;
  endedAt?: number;
}

/** What one record holds. `at` is for a human reading the data dir, never
 *  read back; `endedAt` is read back, and is what `claimsIn` answers with. */
interface NotesHeadingRecord {
  docId: string;
  meetingId: string;
  headingId: string;
  at: number;
  /** When the meeting stopped. Absent while it is still recording. */
  endedAt?: number;
}

/** The record as it reads back — one string field, checked before it is used
 *  to address a block. */
function headingIdOf(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const id = (raw as { headingId?: unknown }).headingId;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

/** The claim one record makes, or nothing for a record that names no heading.
 *  A record written before `endedAt` existed reads as a meeting that never
 *  stopped, which is the answer this rule already had for one. */
function claimOf(raw: unknown): NotesSectionClaim | undefined {
  const headingId = headingIdOf(raw);
  if (headingId === undefined) return undefined;
  const ended = (raw as { endedAt?: unknown }).endedAt;
  return typeof ended === 'number' && Number.isFinite(ended)
    ? { headingId, endedAt: ended }
    : { headingId };
}

/**
 * A heading store backed by one small JSON file per meeting.
 *
 * The write is atomic — a temp file beside the record, then a rename — because
 * a deploy restart can land between the two halves of a plain write, and a
 * half-written record is exactly the state this file exists to survive.
 */
export function createNotesHeadingFileStore(dataDir: string): NotesHeadingStore {
  const pathFor = (ids: NotesHeadingIds): string =>
    meetingSectionPath(dataDir, ids.docId, ids.meetingId);
  /** One record onto disk, atomically: a temp file beside it, then a rename.
   *  A deploy restart can land between the two halves of a plain write, and a
   *  half-written record is exactly the state this file exists to survive. */
  const save = (ids: NotesHeadingIds, record: NotesHeadingRecord): void => {
    const path = pathFor(ids);
    const tmp = `${path}.tmp`;
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(tmp, `${JSON.stringify(record)}\n`);
      renameSync(tmp, path);
    } catch (err) {
      console.error(`[meeting-notes] heading record not written at ${path}:`, err);
    }
  };
  const readRecord = (ids: NotesHeadingIds): NotesHeadingRecord | undefined => {
    const path = pathFor(ids);
    try {
      if (!existsSync(path)) return undefined;
      const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
      const headingId = headingIdOf(raw);
      if (headingId === undefined) return undefined;
      return { ...(raw as NotesHeadingRecord), headingId };
    } catch (err) {
      console.error(`[meeting-notes] heading record unreadable at ${path}:`, err);
      return undefined;
    }
  };
  return {
    read(ids) {
      // A record we cannot read is a meeting with no remembered section,
      // which is the pre-restart behaviour and never a reason to stop.
      return readRecord(ids)?.headingId;
    },
    write(ids, headingId) {
      save(ids, {
        docId: ids.docId,
        meetingId: ids.meetingId,
        headingId,
        at: Date.now(),
      });
    },
    finish(ids, at) {
      // Nothing to mark for a meeting that opened no section: there is no
      // claim for a later recording to read, so there is nothing to say has
      // finished. Read-modify-write rather than a second file, so one meeting
      // is still one record that deleting the folder takes with it.
      const record = readRecord(ids);
      if (record === undefined) return;
      save(ids, { ...record, endedAt: at });
    },
    clear(ids) {
      const path = pathFor(ids);
      try {
        rmSync(path, { force: true });
      } catch (err) {
        console.error(`[meeting-notes] heading record not cleared at ${path}:`, err);
      }
    },
    claimsIn(docId) {
      // One directory listing per first tick of a meeting, over a folder
      // holding one small file per meeting this doc has had. Read here rather
      // than kept in a registry for the reason the records themselves are
      // here: deleting a meeting's folder must delete its memory with it.
      const dir = meetingDirPath(dataDir, docId);
      try {
        if (!existsSync(dir)) return [];
        const out: NotesSectionClaim[] = [];
        for (const name of readdirSync(dir)) {
          if (!name.endsWith('-section.json')) continue;
          try {
            const claim = claimOf(JSON.parse(readFileSync(join(dir, name), 'utf8')));
            if (claim !== undefined) out.push(claim);
          } catch {
            // One unreadable record is one meeting this scan cannot vouch
            // for, not a reason to answer nothing for the whole doc.
          }
        }
        return out;
      } catch (err) {
        console.error(`[meeting-notes] heading records unreadable in ${dir}:`, err);
        return [];
      }
    },
  };
}
