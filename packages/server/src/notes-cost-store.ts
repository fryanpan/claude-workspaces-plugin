/**
 * WHAT A MEETING-HOUR HAS ACTUALLY COST, per note-taker, kept across
 * meetings so the chooser can state a measured figure instead of a guess.
 *
 * The chooser used to print three prices typed out of one eval run. This is
 * the other kind of number: a rolling average over meetings that really
 * happened on this server, summed from the token counts every model call
 * reported. A method with no finished meeting here has no figure and the row
 * says so — a marked estimate is a worse answer than a measurement and a much
 * better one than an unmarked guess.
 *
 * WEIGHTED BY MEETING LENGTH, NOT BY MEETING. Ten meetings do not each
 * contribute a tenth: the figure is total dollars over total hours, so a
 * two-hour meeting counts for twelve times what a ten-minute one does. That
 * is what makes the average answer the question a person is asking — "if I
 * record for an hour, what will it cost" — rather than the average of ten
 * unrelated rates. It is also what stops a thirty-second test recording, all
 * fixed cost and no denominator, from dragging the figure anywhere.
 *
 * TWENTY MEETINGS, and the reason is how fast a change should show up. Short
 * of that and one unusual meeting moves the row by a visible amount; long of
 * it and a prompt edit or a model swap would take months of meetings to work
 * through the average, which is exactly when the number is most wrong. Twenty
 * is roughly a fortnight of a working board's meetings: one outlier moves the
 * figure by a few percent, a real change is visible within days.
 *
 * IT HOLDS NO MEETING CONTENT — a timestamp, a duration, a dollar amount and
 * a call count per meeting, and not even which doc it was. Nothing here says
 * what anybody said or where.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { NOTES_METHODS, type NotesMethod, parseNotesMethod } from '@claude-workspaces/core';

/** How many meetings per method the rolling figure is taken over. */
export const MAX_KEPT_MEETINGS = 20;

const COST_FILENAME = 'notes-cost.json';

/** One finished meeting's contribution to its method's figure. */
export interface NotesCostEntry {
  /** Epoch ms at which the meeting stopped. */
  at: number;
  /** How long the meeting ran, in milliseconds. The weight. */
  ms: number;
  /** What it cost, in dollars, over every priced call it made. */
  usd: number;
  /** Model calls the meeting made. A meeting that made none is not recorded
   *  at all, so this is never zero here — it is kept because a row with an
   *  implausible call count is the first thing a reader checks. */
  calls: number;
}

/** The file, as it sits on disk. */
export interface NotesCostRecord {
  meetings: Partial<Record<NotesMethod, NotesCostEntry[]>>;
}

/** Measured dollars per hour, by method. A method with no meetings is absent
 *  rather than zero: "not measured" and "free" are different claims. */
export type NotesPerHourByMethod = Partial<Record<NotesMethod, number>>;

function costPath(dataDir: string): string {
  return join(dataDir, 'meetings', COST_FILENAME);
}

/**
 * Read the file, or an empty record.
 *
 * Never throws. A missing file is the ordinary state of a fresh install; a
 * corrupt one is a figure nobody gets rather than a server that will not
 * serve a chooser, and the next finished meeting rewrites it.
 */
export function readNotesCostRecord(dataDir: string): NotesCostRecord {
  const empty: NotesCostRecord = { meetings: {} };
  let raw: string;
  try {
    raw = readFileSync(costPath(dataDir), 'utf8');
  } catch {
    return empty;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return empty;
  }
  if (typeof parsed !== 'object' || parsed === null) return empty;
  const meetingsRaw = (parsed as { meetings?: unknown }).meetings;
  if (typeof meetingsRaw !== 'object' || meetingsRaw === null) return empty;
  const meetings: NotesCostRecord['meetings'] = {};
  for (const [key, value] of Object.entries(meetingsRaw as Record<string, unknown>)) {
    const method = parseNotesMethod(key);
    if (!method || !Array.isArray(value)) continue;
    const rows = value.filter(isEntry).slice(-MAX_KEPT_MEETINGS);
    if (rows.length > 0) meetings[method] = rows;
  }
  return { meetings };
}

/**
 * A row is kept only if every number on it is one. A `null` duration or a
 * string amount reaching the division would print `$NaN/hr` on a chooser row,
 * which is worse than the estimate it replaced.
 */
function isEntry(value: unknown): value is NotesCostEntry {
  if (typeof value !== 'object' || value === null) return false;
  const e = value as Record<string, unknown>;
  return (
    isFinitePositive(e.ms) &&
    typeof e.usd === 'number' &&
    Number.isFinite(e.usd) &&
    e.usd >= 0 &&
    typeof e.at === 'number' &&
    Number.isFinite(e.at) &&
    typeof e.calls === 'number' &&
    Number.isFinite(e.calls)
  );
}

function isFinitePositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * Record one finished meeting and answer the figures as they now stand.
 *
 * BEST-EFFORT, like every other measurement this pipeline writes: a meeting
 * must not fail its stop because a bookkeeping file could not be written. A
 * failed write returns the figures it computed anyway, so the caller's log
 * line still states the meeting's own cost.
 *
 * A meeting with no measurable length or no priced call is not recorded:
 * there is nothing in it that a rate can be taken over, and admitting a zero
 * would pull every method's figure toward zero one silent meeting at a time.
 */
export function recordMeetingCost(
  dataDir: string,
  method: NotesMethod,
  entry: NotesCostEntry,
  onError?: (message: string) => void,
): NotesPerHourByMethod {
  const record = readNotesCostRecord(dataDir);
  if (isEntry(entry) && entry.calls > 0) {
    const rows = [...(record.meetings[method] ?? []), entry].slice(-MAX_KEPT_MEETINGS);
    record.meetings[method] = rows;
    const path = costPath(dataDir);
    try {
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`);
      renameSync(tmp, path);
    } catch (err) {
      onError?.(`[notes-cost] could not write ${path}: ${String(err)}`);
    }
  }
  return perHourByMethod(record);
}

/**
 * The rolling figure for every method that has one: total dollars over total
 * hours, per method.
 *
 * A method whose kept meetings sum to no time at all is left out rather than
 * divided by zero.
 */
export function perHourByMethod(record: NotesCostRecord): NotesPerHourByMethod {
  const out: NotesPerHourByMethod = {};
  for (const method of NOTES_METHODS) {
    const rows = record.meetings[method];
    if (!rows || rows.length === 0) continue;
    let ms = 0;
    let usd = 0;
    for (const row of rows) {
      ms += row.ms;
      usd += row.usd;
    }
    if (ms <= 0) continue;
    out[method] = (usd * 3_600_000) / ms;
  }
  return out;
}

/** The figures a chooser should be handed, read fresh off disk. */
export function readPerHourByMethod(dataDir: string): NotesPerHourByMethod {
  return perHourByMethod(readNotesCostRecord(dataDir));
}
