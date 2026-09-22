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
 *
 * ONE FILE, EVERY READING. A meeting is read at the end of every recording
 * LEG, so a meeting whose socket dropped six times is read seven times — and
 * the file used to hold the last of those and nothing else. When one
 * meeting's item was filed seven times with a climbing denominator
 * (2026-09-15), six of the seven readings had to be reconstructed from
 * somebody's memory of the log, because the only durable copy had been
 * overwritten. The file is now JSON LINES, oldest first, capped at
 * {@link QUALITY_SERIES_LIMIT}. A file written before this is one line, so it
 * reads back unchanged; {@link readNotesQuality} still answers the newest
 * record, which is what every existing reader wants.
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
  /** Notes that invert their source. Absent on a row written before the
   *  check existed, which is not a reading of zero. */
  invertedNotes?: number;
  ideas: number;
  /** `null` when the notes could not be read: the count is unknown, and both
   *  0 and `ideas` are lies about it. */
  uncoveredIdeas: number | null;
  /** `null` when the meeting held too few ideas for a share to mean
   *  anything, and `null` when the notes could not be read at all.
   *  `coverageSource` says which — see {@link NotesQualityRecord.coverageSource}. */
  uncoveredShare: number | null;
  /**
   * Whether the coverage numbers on this row are about the notes.
   *
   * `unreadable` means the reading failed, and then `uncoveredIdeas` and
   * `uncoveredShare` are both `null` rather than `ideas` and `1`. A row
   * written before this field existed is a reading from the era when a failed
   * reading was indistinguishable from a covered-nothing one, so it reads
   * back as `notes` and the ambiguity stays visible in the date, not hidden
   * in a default that claims more than the row knows.
   */
  coverageSource?: 'notes' | 'unreadable';
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
    invertedNotes: report.inversions.length,
    ideas: report.coverage.ideas,
    uncoveredIdeas: report.coverage.uncoveredIdeas,
    uncoveredShare: report.coverage.uncoveredShare,
    coverageSource: report.coverage.source,
    lateShare: report.lateness.lateShare,
    lateMedianMs: report.lateness.medianMs,
    flags: report.flags.map((f) => f.kind),
  };
}

/**
 * How many readings one meeting keeps. A meeting is read once per recording
 * leg, and a socket that flaps can end a lot of them; past this the oldest go,
 * because the question the series answers — did this verdict change, or did
 * one broken number repeat — is answerable from the recent ones.
 */
export const QUALITY_SERIES_LIMIT = 50;

/** The records in one meeting's file, oldest first. Lines that will not parse
 *  are skipped rather than costing the meeting its whole series. */
function parseSeries(text: string): NotesQualityRecord[] {
  const out: NotesQualityRecord[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== 'object' || parsed === null) continue;
      const record = parsed as NotesQualityRecord;
      if (typeof record.meetingId !== 'string' || typeof record.at !== 'number') continue;
      out.push(record);
    } catch {
      // One unreadable line is one reading lost, not the meeting's history.
    }
  }
  return out;
}

/**
 * Add one meeting's reading to its series. Answers whether it landed rather
 * than throwing: this runs inside a meeting's stop, and a full disk must not
 * be what costs the doc its last notes flush.
 *
 * Read-modify-write rather than an append, because the cap has to be applied
 * somewhere and these files are one small line per recording leg. A file that
 * cannot be read is treated as no history — this reading is still written,
 * which loses the past rather than the present.
 */
export function writeNotesQuality(dataDir: string, record: NotesQualityRecord): boolean {
  const path = notesQualityPath(dataDir, record.docId, record.meetingId);
  try {
    mkdirSync(dirname(path), { recursive: true });
    let series: NotesQualityRecord[] = [];
    try {
      if (existsSync(path)) series = parseSeries(readFileSync(path, 'utf8'));
    } catch {
      series = [];
    }
    series.push(record);
    const kept = series.slice(-QUALITY_SERIES_LIMIT);
    writeFileSync(path, `${kept.map((r) => JSON.stringify(r)).join('\n')}\n`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Every reading this meeting has left, oldest first. Empty for a meeting with
 * none.
 *
 * This is the read that answers "was the verdict the same every time" — the
 * question nobody could answer on 2026-09-15 because the file held only the
 * last of seven readings.
 */
export function readNotesQualitySeries(
  dataDir: string,
  docId: string,
  meetingId: string,
): NotesQualityRecord[] {
  const path = notesQualityPath(dataDir, docId, meetingId);
  if (!existsSync(path)) return [];
  try {
    return parseSeries(readFileSync(path, 'utf8'));
  } catch {
    return [];
  }
}

/** This meeting's NEWEST reading, or `undefined` for a meeting that has none.
 *  The newest rather than the whole series, because every existing reader —
 *  the rollup, the rerun report — is asking how the meeting came out. */
export function readNotesQuality(
  dataDir: string,
  docId: string,
  meetingId: string,
): NotesQualityRecord | undefined {
  return readNotesQualitySeries(dataDir, docId, meetingId).at(-1);
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
  /** How many of the window's meetings the notes reading failed on, and so
   *  contributed nothing to the coverage totals. Reported for the same reason
   *  `latenessUnknown` is, and it is the number that would have made
   *  2026-09-15 visible on the day: a coverage figure computed over meetings
   *  whose notes could not be read is not a claim about note quality. */
  coverageUnknown: number;
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
  let coverageUnknown = 0;
  for (const record of records) {
    if (record.flags.length > 0) flagged++;
    if (record.lateShare === null) latenessUnknown++;
    if (record.coverageSource === 'unreadable') coverageUnknown++;
    for (const flag of record.flags) byFlag[flag] = (byFlag[flag] ?? 0) + 1;
    // A READING THAT FAILED CONTRIBUTES NO NOTES-DERIVED TOTAL AT ALL, and
    // the first version of this loop excluded only the coverage pair. The
    // other three are counted off the notes text, which for an unreadable
    // meeting is the empty string — so each of them is a zero that means
    // "not measured" and was being summed as "measured, and none". A window
    // holding one unreadable meeting then read as a window whose duplicate
    // rate had improved. `coverageUnknown` and `meetings` still count it,
    // which is how a reader sees the denominator these totals are over.
    if (record.coverageSource === 'unreadable') continue;
    totals.duplicateBulletLines += record.duplicateBulletLines;
    totals.duplicateHeadings += record.duplicateHeadings;
    totals.unknownVoices += record.unknownVoices;
    // Adding a meeting's ideas while its uncovered count is unknown would
    // move the window's ratio by a meeting nothing is known about.
    if (record.uncoveredIdeas !== null) {
      totals.ideas += record.ideas;
      totals.uncoveredIdeas += record.uncoveredIdeas;
    }
  }
  return {
    windowMs: opts.windowMs,
    meetings: records.length,
    flagged,
    byFlag,
    totals,
    coverageUnknown,
    latenessUnknown,
    worst: records.filter((r) => r.flags.length > 0).slice(0, ROLLUP_WORST_LIMIT),
  };
}
