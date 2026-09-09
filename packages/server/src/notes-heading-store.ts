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

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { meetingSectionPath } from './meetings.ts';

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
}

/** What one record holds. `at` is for a human reading the data dir, never
 *  read back. */
interface NotesHeadingRecord {
  docId: string;
  meetingId: string;
  headingId: string;
  at: number;
}

/** The record as it reads back — one string field, checked before it is used
 *  to address a block. */
function headingIdOf(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const id = (raw as { headingId?: unknown }).headingId;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
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
  return {
    read(ids) {
      const path = pathFor(ids);
      try {
        if (!existsSync(path)) return undefined;
        return headingIdOf(JSON.parse(readFileSync(path, 'utf8')));
      } catch (err) {
        // A record we cannot read is a meeting with no remembered section,
        // which is the pre-restart behaviour and never a reason to stop.
        console.error(`[meeting-notes] heading record unreadable at ${path}:`, err);
        return undefined;
      }
    },
    write(ids, headingId) {
      const path = pathFor(ids);
      const tmp = `${path}.tmp`;
      const record: NotesHeadingRecord = {
        docId: ids.docId,
        meetingId: ids.meetingId,
        headingId,
        at: Date.now(),
      };
      try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(tmp, `${JSON.stringify(record)}\n`);
        renameSync(tmp, path);
      } catch (err) {
        console.error(`[meeting-notes] heading record not written at ${path}:`, err);
      }
    },
    clear(ids) {
      const path = pathFor(ids);
      try {
        rmSync(path, { force: true });
      } catch (err) {
        console.error(`[meeting-notes] heading record not cleared at ${path}:`, err);
      }
    },
  };
}
