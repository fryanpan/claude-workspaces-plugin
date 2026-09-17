/**
 * WHERE a meeting's quality item went, kept on disk so a restart does not
 * lose the only thing that can take it back.
 *
 * THE FAILURE THIS FILE EXISTS TO END. `notes-quality-filing.ts` files one
 * item per meeting and withdraws it again when a later leg reads clean, and
 * both of those need to know where the item went. That memory was a `Map` in
 * the process, and a restart is the one leg-ending this repo produces itself:
 * `legIsResumable('server-restart')` is false, so the item FILES AT ONCE
 * rather than being held in a timer the restarting process would exit before
 * it could fire. The browser then resumes across exactly that gap —
 * `meeting-reconnect.ts` treats a deploy's restart as invisible to the
 * recording — so the meeting carried on, ended clean in the new process,
 * found no filing to take back, and left a reader holding an item their own
 * meeting had disproved. That is the commonest way one of these items reaches
 * a person mid-meeting.
 *
 * NOT THE OTHER QUALITY STORE. `notes-quality-store.ts` is the series of
 * READINGS — what each leg measured, which the daily health check rolls up.
 * This is the single mutable pointer to the ASK those readings produced, and
 * the two have opposite shapes: that one only ever appends, this one is
 * overwritten and then deleted. Wedging a pointer into a capped append-only
 * series is how the pointer gets aged out from under the item it names.
 *
 * BESIDE THE MEETING, like the heading record and for the same reason: one
 * small file in the meeting's own folder, named after the meeting, so the
 * transcript, the readings, the section and this are found together and the
 * one `rm` that deletes a meeting deletes its memory with it.
 *
 * WHAT HAPPENS TO A RECORD FOR A MEETING THAT NEVER COMES BACK — the first
 * of two judgement calls this file owes an answer for. Three things bound it,
 * and none of them is a sweep on a clock:
 *
 *  - It is written only when an item is actually STANDING. A leg that files
 *    nothing writes nothing, and the commonest meeting by far — one that
 *    crossed no bar — leaves no file at all. So the records do not count
 *    meetings; they count meetings that went wrong.
 *  - It is deleted the moment the item stops standing, which is the
 *    withdrawal the filer already makes.
 *  - It cannot outlive its meeting: it is inside the meeting's directory,
 *    so whatever deletes a meeting's transcript takes this with it. A
 *    lifetime of its own would be a second, weaker answer to a question the
 *    folder already answers.
 *
 * And a record is IGNORED AND DELETED once it is older than
 * {@link FILED_MEMORY_MAX_AGE_MS}, which is a different job from bounding the
 * disk — it bounds what the memory may still DO. A restart is minutes; a
 * record a day old belongs to an item its reader has long since seen, and
 * reviving it would revise that item and re-judge it in front of them. Filing
 * a fresh item is the safe direction, and it is the direction the in-memory
 * bound in `notes-quality-filing.ts` already chose when it evicts.
 *
 * A STORE IT CANNOT READ IS AN EMPTY STORE, NEVER A FAILED FILING — the
 * second judgement call. A corrupt record, a data dir gone read-only, a
 * half-written file: every one of them answers `undefined` and logs a line.
 * The alternative is refusing to file, and the two failure directions are not
 * comparable. Treating it as empty at worst duplicates an item, which is the
 * behaviour this whole path had before it could remember anything; failing
 * the filing means a meeting that genuinely went badly tells nobody, which is
 * the failure the quality pass exists to prevent. Nothing here throws into
 * the stop path.
 *
 * IT HOLDS NO MEETING CONTENT: two ids, the ids of the ask, and the counts
 * and shares behind the bars it crossed. Not a bullet, not a name, not a
 * word anybody said.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { meetingDirPath } from './meetings.ts';
import type { NotesQualityVerdict } from './notes-quality-verdict.ts';

/** A meeting, as every file on this path names one. */
export interface NotesQualityFiledIds {
  docId: string;
  meetingId: string;
}

/**
 * Where one meeting's item went.
 *
 * It lives here rather than in the filer so that the filer can import the
 * store without the store importing the filer back: one direction, no cycle.
 */
export type NotesQualityFiledWhere =
  | { kind: 'row'; taskId: string; itemId: string }
  | { kind: 'doc'; docId: string; threadId: string; commentId: string };

/** What is remembered about a meeting whose item is standing — the whole
 *  of what survives the process. */
export interface NotesQualityFiledItem {
  /** The ask itself, which is what a revision or a withdrawal addresses. */
  filed: NotesQualityFiledWhere;
  /**
   * The verdict the item currently carries, so a reading that says what the
   * item already says does not re-judge it.
   *
   * Absent is a usable record and not a broken one: without it the next
   * flagged leg revises once instead of suppressing, which costs a reader one
   * re-judgement rather than an item that never updates.
   */
  verdict?: NotesQualityVerdict;
}

/**
 * How long a filing stays addressable.
 *
 * A day. The gap this memory exists to cross is a restart, which is minutes,
 * and no meeting runs for a day — a later recording of the same doc is a new
 * meeting with a new id and so reads a different record entirely.
 */
export const FILED_MEMORY_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * The durable half of the filer's memory.
 *
 * An interface rather than the file functions directly, so a test can drive
 * the filer with no store at all (the pre-restart behaviour) or with a fake
 * that fails in one direction only.
 */
export interface NotesQualityFiledStore {
  /** Where this meeting's item went, or `undefined` for a meeting with none
   *  — including one whose record is unreadable or too old, which is the
   *  same answer and not an error. */
  read(ids: NotesQualityFiledIds): NotesQualityFiledItem | undefined;
  /** This meeting's item is standing, here, saying this. */
  write(ids: NotesQualityFiledIds, item: NotesQualityFiledItem): void;
  /** It is not standing any more. */
  clear(ids: NotesQualityFiledIds): void;
}

/** What one record holds. `docId` and `meetingId` are for a human reading the
 *  data dir; `at` is read back, by the age bound. */
interface NotesQualityFiledRecord extends NotesQualityFiledItem {
  docId: string;
  meetingId: string;
  at: number;
}

/** Where one meeting's filing pointer lives — beside its transcript, its
 *  readings and its section record. */
export function notesQualityFiledPath(dataDir: string, docId: string, meetingId: string): string {
  const safe = meetingId.replace(/[^A-Za-z0-9._-]/g, '_');
  return join(meetingDirPath(dataDir, docId), `${safe}-filed.json`);
}

const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

/** The ask a record names, or nothing for a record that cannot address one.
 *  Every id is checked, because a half of one addresses nothing and the call
 *  it would be used in is a write against a person's queue. */
function filedIn(raw: unknown): NotesQualityFiledWhere | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const filed = (raw as { filed?: unknown }).filed;
  if (typeof filed !== 'object' || filed === null) return undefined;
  const f = filed as Record<string, unknown>;
  if (f.kind === 'row' && nonEmpty(f.taskId) && nonEmpty(f.itemId)) {
    return { kind: 'row', taskId: f.taskId, itemId: f.itemId };
  }
  if (f.kind === 'doc' && nonEmpty(f.docId) && nonEmpty(f.threadId) && nonEmpty(f.commentId)) {
    return { kind: 'doc', docId: f.docId, threadId: f.threadId, commentId: f.commentId };
  }
  return undefined;
}

/** A record of numbers, with anything that is not a finite number dropped. */
function numbersIn(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (typeof raw !== 'object' || raw === null) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
  }
  return out;
}

/**
 * The verdict a record carries, or nothing.
 *
 * A verdict that will not parse is dropped while the FILING is kept, because
 * the two answer different questions: without the filing the item cannot be
 * addressed at all, and without the verdict it is addressed once more than it
 * needs to be.
 */
function verdictIn(raw: unknown): NotesQualityVerdict | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const verdict = (raw as { verdict?: unknown }).verdict;
  if (typeof verdict !== 'object' || verdict === null) return undefined;
  const kinds = (verdict as { kinds?: unknown }).kinds;
  if (!Array.isArray(kinds) || !kinds.every((k) => typeof k === 'string')) return undefined;
  return {
    kinds: kinds as NotesQualityVerdict['kinds'],
    counts: numbersIn((verdict as { counts?: unknown }).counts),
    ratios: numbersIn((verdict as { ratios?: unknown }).ratios),
  };
}

/**
 * A filing store backed by one small JSON file per meeting.
 *
 * The write is atomic — a temp file beside the record, then a rename —
 * because a restart can land between the two halves of a plain write, and a
 * restart is precisely the event this file exists to survive.
 *
 * `now` is injected so the age bound can be driven in a test without the test
 * waiting a day or asserting on a wall clock.
 */
export function createNotesQualityFiledFileStore(
  dataDir: string,
  opts: { now?: () => number } = {},
): NotesQualityFiledStore {
  const now = opts.now ?? (() => Date.now());
  const pathFor = (ids: NotesQualityFiledIds): string =>
    notesQualityFiledPath(dataDir, ids.docId, ids.meetingId);
  const drop = (path: string): void => {
    try {
      rmSync(path, { force: true });
    } catch (err) {
      console.error(`[meeting-notes] quality filing record not cleared at ${path}:`, err);
    }
  };
  return {
    read(ids) {
      const path = pathFor(ids);
      try {
        if (!existsSync(path)) return undefined;
        const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
        const filed = filedIn(raw);
        if (filed === undefined) return undefined;
        const at = (raw as { at?: unknown }).at;
        // A record with no usable timestamp is one this bound cannot vouch
        // for, and an item it might revive could be any age at all.
        if (typeof at !== 'number' || !Number.isFinite(at)) {
          drop(path);
          return undefined;
        }
        if (now() - at > FILED_MEMORY_MAX_AGE_MS) {
          drop(path);
          return undefined;
        }
        const verdict = verdictIn(raw);
        return verdict === undefined ? { filed } : { filed, verdict };
      } catch (err) {
        // A record we cannot read is a meeting with no remembered filing,
        // which is the pre-restart behaviour and never a reason to stop.
        console.error(`[meeting-notes] quality filing record unreadable at ${path}:`, err);
        return undefined;
      }
    },
    write(ids, item) {
      const path = pathFor(ids);
      const tmp = `${path}.tmp`;
      const record: NotesQualityFiledRecord = {
        docId: ids.docId,
        meetingId: ids.meetingId,
        at: now(),
        filed: item.filed,
        ...(item.verdict !== undefined ? { verdict: item.verdict } : {}),
      };
      try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(tmp, `${JSON.stringify(record)}\n`);
        renameSync(tmp, path);
      } catch (err) {
        console.error(`[meeting-notes] quality filing record not written at ${path}:`, err);
      }
    },
    clear(ids) {
      drop(pathFor(ids));
    },
  };
}
