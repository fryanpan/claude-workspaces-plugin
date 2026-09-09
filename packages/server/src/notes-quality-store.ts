/**
 * The quality reading a meeting left behind, and the rollup the daily health
 * check reads.
 *
 * WHY IT IS WRITTEN DOWN AT ALL. The end-of-meeting line already carries the
 * counts, and a line in a log answers "what happened to that meeting" for
 * exactly as long as somebody is looking at the log. The question the health
 * check asks is the other one — "is the note-taker getting worse" — and no
 * single meeting can answer it. So each stop leaves one small record beside
 * its own transcript, and the rollup is a walk over those.
 *
 * COUNTS ONLY, NEVER THE MEETING'S WORDS. What is stored is how many bullets
 * repeated, not which ones; how many voices were invented, not their names.
 * The record is a health signal that a rollup may print anywhere, and a
 * repeated bullet is somebody's speech. The words stay in the doc, where the
 * person who spoke them already is; the review item filed at the stop names
 * them because it lands on that meeting's own row.
 *
 * ONE FILE PER MEETING, beside the transcript it is about, for the same
 * reason the transcript is one file per meeting: a meeting is the unit
 * everything else here is keyed by, an append-only index would have to be
 * rewritten to correct a reading, and a corrupt record costs one meeting's
 * number rather than the day's.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { meetingDirPath } from './meetings.ts';
import type { NotesQualityFlag, NotesQualityReport } from './notes-quality-report.ts';

/** What one meeting's stop wrote down. */
export interface NotesQualityRecord {
  docId: string;
  meetingId: string;
  /** When the reading was taken — the stop. */
  at: number;
  bullets: number;
  duplicateBulletLines: number;
  duplicateHeadings: number;
  longRuns: number;
  unknownVoices: number;
  ideas: number;
  uncoveredIdeas: number;
  /** `null` when the meeting held too few ideas for a share to mean
   *  anything, exactly as the report says it. */
  uncoveredShare: number | null;
  /** `null` when no per-tick timing record was found. */
  lateShare: number | null;
  lateMedianMs: number | null;
  /** The bars this meeting went past, by kind. Empty is the healthy state. */
  flags: NotesQualityFlag['kind'][];
}

/** Where a meeting's reading lives. */
export function notesQualityPath(dataDir: string, docId: string, meetingId: string): string {
  const safe = meetingId.replace(/[^A-Za-z0-9._-]/g, '_');
  return join(meetingDirPath(dataDir, docId), `${safe}.quality.json`);
}

/** The record a report becomes on disk. */
export function notesQualityRecord(
  docId: string,
  meetingId: string,
  report: NotesQualityReport,
  at: number,
): NotesQualityRecord {
  return {
    docId,
    meetingId,
    at,
    bullets: report.bullets,
    duplicateBulletLines: report.duplicateBulletLines,
    duplicateHeadings: report.duplicateHeadings.length,
    longRuns: report.longRuns.length,
    unknownVoices: report.unknownVoices.length,
    ideas: report.ideas,
    uncoveredIdeas: report.uncoveredIdeas,
    uncoveredShare: report.uncoveredShare,
    lateShare: report.lateness.lateShare,
    lateMedianMs: report.lateness.medianMs,
    flags: report.flags.map((f) => f.kind),
  };
}

/**
 * Write one meeting's reading. Answers whether it landed rather than
 * throwing: this runs inside a meeting's stop, and a full disk must not be
 * what costs the doc its last notes flush.
 */
export function writeNotesQuality(dataDir: string, record: NotesQualityRecord): boolean {
  const path = notesQualityPath(dataDir, record.docId, record.meetingId);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(record)}\n`);
    return true;
  } catch {
    return false;
  }
}

/** One meeting's reading, or `undefined` for a meeting that has none. */
export function readNotesQuality(
  dataDir: string,
  docId: string,
  meetingId: string,
): NotesQualityRecord | undefined {
  const path = notesQualityPath(dataDir, docId, meetingId);
  if (!existsSync(path)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const record = parsed as NotesQualityRecord;
    if (typeof record.meetingId !== 'string' || typeof record.at !== 'number') return undefined;
    return record;
  } catch {
    return undefined;
  }
}

/** What the health check is shown. */
export interface NotesQualityRollup {
  /** The window it covers, in milliseconds back from `now`. */
  windowMs: number;
  /** Meetings that left a reading in the window. */
  meetings: number;
  /** Of those, how many went past at least one bar. */
  flagged: number;
  /** How many meetings each bar caught. A bar with no meetings is absent, so
   *  a reader sees the shape of what is going wrong rather than a row of
   *  zeros. */
  byFlag: Partial<Record<NotesQualityFlag['kind'], number>>;
  /** Totals over the window, so a trend is readable without the rows. */
  totals: {
    duplicateBulletLines: number;
    duplicateHeadings: number;
    unknownVoices: number;
    ideas: number;
    uncoveredIdeas: number;
  };
  /** How many of the window's meetings had no per-tick timing record, and so
   *  contributed nothing to the lateness picture. Reported rather than
   *  silently excluded — a lateness number computed from two meetings out of
   *  twenty is not the same claim as one computed from twenty. */
  latenessUnknown: number;
  /** The flagged meetings, newest first, capped. Ids and counts only. */
  worst: NotesQualityRecord[];
}

/** How many flagged meetings a rollup names before it stops listing. Enough
 *  to see a pattern, few enough that a bad week does not become a wall. */
export const ROLLUP_WORST_LIMIT = 10;

/** The rollup with the meetings it names removed — numbers and nothing else.
 *
 *  `/api/metrics` promises a body that carries no doc id, path or title, and
 *  that promise is what makes it safe to sample from outside. `worst` names
 *  meetings, so the week that rides the metrics reply is this view; the
 *  meetings themselves reach a person on the row the doc belongs to and in
 *  the process log, which are both places that already hold their names. */
export type NotesQualityCounts = Omit<NotesQualityRollup, 'worst'>;

export function notesQualityCounts(rollup: NotesQualityRollup): NotesQualityCounts {
  const { worst: _worst, ...counts } = rollup;
  return counts;
}

/**
 * Every reading in the window, rolled up.
 *
 * A walk of the meetings tree rather than an index: the tree is a directory
 * per doc that has ever held a meeting, which is tens of entries, and an
 * index would be a second thing to keep true. A directory that cannot be read
 * contributes nothing and does not stop the walk.
 */
export function rollupNotesQuality(
  dataDir: string,
  opts: { now: number; windowMs: number },
): NotesQualityRollup {
  const since = opts.now - opts.windowMs;
  const records: NotesQualityRecord[] = [];
  const root = join(dataDir, 'meetings');
  let docDirs: string[] = [];
  try {
    docDirs = readdirSync(root);
  } catch {
    docDirs = [];
  }
  for (const docId of docDirs) {
    let files: string[] = [];
    try {
      files = readdirSync(join(root, docId));
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith('.quality.json')) continue;
      const meetingId = file.slice(0, -'.quality.json'.length);
      const record = readNotesQuality(dataDir, docId, meetingId);
      if (record && record.at >= since) records.push(record);
    }
  }
  records.sort((a, b) => b.at - a.at);
  const byFlag: NotesQualityRollup['byFlag'] = {};
  const totals = {
    duplicateBulletLines: 0,
    duplicateHeadings: 0,
    unknownVoices: 0,
    ideas: 0,
    uncoveredIdeas: 0,
  };
  let flagged = 0;
  let latenessUnknown = 0;
  for (const record of records) {
    if (record.flags.length > 0) flagged++;
    if (record.lateShare === null) latenessUnknown++;
    for (const flag of record.flags) byFlag[flag] = (byFlag[flag] ?? 0) + 1;
    totals.duplicateBulletLines += record.duplicateBulletLines;
    totals.duplicateHeadings += record.duplicateHeadings;
    totals.unknownVoices += record.unknownVoices;
    totals.ideas += record.ideas;
    totals.uncoveredIdeas += record.uncoveredIdeas;
  }
  return {
    windowMs: opts.windowMs,
    meetings: records.length,
    flagged,
    byFlag,
    totals,
    latenessUnknown,
    worst: records.filter((r) => r.flags.length > 0).slice(0, ROLLUP_WORST_LIMIT),
  };
}
