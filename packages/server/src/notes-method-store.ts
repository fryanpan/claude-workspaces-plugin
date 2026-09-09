/**
 * WHICH NOTE-TAKER THIS DOC USES, and who changed it to that.
 *
 * PER DOC AND NOT PER MEETING, which is the thing to get right about this
 * file. A person who decided last week that this doc's meetings want the
 * expensive note-taker has decided it for the doc: the next recording opens
 * with the method they chose, and a switch made mid-meeting is still a switch
 * made to the doc. So the record survives the meeting it was made in, and
 * "reload keeps it" is a property of the file rather than of a live session.
 *
 * BESIDE THE MEETING RECORD, under `meetings/<docId>/notes-method.json`, not
 * inside `meeting.json`. That file is rebuilt from the segments on disk when a
 * meeting stops, and a preference that a rebuild can drop is a preference that
 * silently resets. This one is written only when somebody changes it.
 *
 * THE CHANGES ARE KEPT, not just the current value: "who, when, which" is
 * what makes the trace line in the notes checkable against the record, and a
 * meeting whose notes get better halfway down is a meeting somebody will want
 * to explain later.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DEFAULT_NOTES_METHOD, type NotesMethod, parseNotesMethod } from '@claude-workspaces/core';
import { meetingDirPath } from './meetings.ts';

export const NOTES_METHOD_FILENAME = 'notes-method.json';

/** One change: which method, when, and who asked for it. */
export interface NotesMethodChange {
  method: NotesMethod;
  /** Epoch milliseconds. */
  at: number;
  /**
   * The signed-in person's name, as the client knows it. `undefined` where
   * nobody was named — a share visitor, a bot leg, a client too old to send
   * one — and rendered as "someone" rather than guessed.
   */
  by?: string;
  /** The meeting this change was made during, absent when it was made at
   *  rest. What separates "changed the doc's default" from "changed it while
   *  the room was talking". */
  meetingId?: string;
}

export interface NotesMethodRecord {
  method: NotesMethod;
  changes: NotesMethodChange[];
}

/**
 * How many changes are kept. A person flipping between methods to hear the
 * difference should not grow a file without limit; the newest are the ones
 * that explain the notes anybody is reading.
 */
export const MAX_KEPT_CHANGES = 50;

export function notesMethodPath(dataDir: string, docId: string): string {
  return join(meetingDirPath(dataDir, docId), NOTES_METHOD_FILENAME);
}

function parseRecord(raw: string): NotesMethodRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const method = parseNotesMethod((parsed as { method?: unknown }).method);
  if (!method) return null;
  const rawChanges = (parsed as { changes?: unknown }).changes;
  const changes: NotesMethodChange[] = [];
  if (Array.isArray(rawChanges)) {
    for (const entry of rawChanges) {
      if (typeof entry !== 'object' || entry === null) continue;
      const row = entry as { method?: unknown; at?: unknown; by?: unknown; meetingId?: unknown };
      const m = parseNotesMethod(row.method);
      if (!m || typeof row.at !== 'number' || !Number.isFinite(row.at)) continue;
      changes.push({
        method: m,
        at: row.at,
        ...(typeof row.by === 'string' && row.by.length > 0 ? { by: row.by } : {}),
        ...(typeof row.meetingId === 'string' && row.meetingId.length > 0
          ? { meetingId: row.meetingId }
          : {}),
      });
    }
  }
  return { method, changes };
}

/**
 * What this doc records, or `null` for a doc nobody has chosen for.
 *
 * NEVER THROWS. An unreadable or half-written file is a doc with no stored
 * preference — the caller composes on the default — because a preference file
 * must not be able to stop a meeting being recorded.
 */
export function readNotesMethodRecord(dataDir: string, docId: string): NotesMethodRecord | null {
  const path = notesMethodPath(dataDir, docId);
  if (!existsSync(path)) return null;
  try {
    return parseRecord(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/** The doc's method, or the default. The read the composer makes per tick. */
export function readNotesMethod(dataDir: string, docId: string): NotesMethod {
  return readNotesMethodRecord(dataDir, docId)?.method ?? DEFAULT_NOTES_METHOD;
}

/**
 * Record a change and answer what the doc now reads.
 *
 * WRITTEN THROUGH A TEMPORARY AND RENAMED, because the file is read by the
 * composer on a tick that can land at any moment: a reader that caught a
 * half-written file would fall back to the default, which is the method the
 * person is in the middle of changing away from.
 *
 * A change to the method the doc already has is still recorded when it names
 * a different meeting — the same choice re-affirmed inside a recording is
 * what the notes' trace line is written from. A no-op repeat at rest is
 * dropped, so opening the fold and picking the row that is already on does
 * not grow the record.
 */
export function writeNotesMethod(
  dataDir: string,
  docId: string,
  change: NotesMethodChange,
): NotesMethodRecord {
  const held = readNotesMethodRecord(dataDir, docId);
  const previous = held?.method ?? DEFAULT_NOTES_METHOD;
  const repeat = previous === change.method && change.meetingId === undefined;
  const record: NotesMethodRecord = {
    method: change.method,
    changes: repeat
      ? (held?.changes ?? [])
      : [...(held?.changes ?? []), change].slice(-MAX_KEPT_CHANGES),
  };
  const path = notesMethodPath(dataDir, docId);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  renameSync(tmp, path);
  return record;
}
