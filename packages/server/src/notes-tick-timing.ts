/**
 * How long a settled turn waited for the note that carried it — read off a
 * per-tick timing record written beside the transcript, when there is one.
 *
 * WHY IT IS A READER AND NOT A WRITER. Nothing in this file records anything.
 * The per-tick record is being written on its own branch, by the work that
 * owns the notes clocks, and this module exists so the quality report can use
 * it the day it lands without either half waiting for the other. Until then
 * every meeting reads as `null` and the report says so in words rather than
 * reporting a lateness of zero — which is what an absent file would average
 * to, and is the single wrong answer this module must never give.
 *
 * WHAT IT LOOKS FOR. `<meetingId>.ticks.jsonl` in the meeting's own directory,
 * one JSON object per line. A row is read when it carries a settle time and a
 * write time under any of the spellings in {@link SETTLED_KEYS} /
 * {@link WROTE_KEYS}; a row that carries neither is skipped rather than
 * treated as a zero wait. The spelling tolerance is deliberate and is not
 * generosity: the writer and this reader are being built at the same time by
 * two different hands, and a reader that accepts the obvious synonyms cannot
 * silently report a clean meeting because a field was named `writtenAt`
 * instead of `wroteAt`.
 *
 * WHAT IT WILL NOT DO. It will not infer a wait from the meeting record. The
 * record carries when the meeting started, when it stopped and how many turns
 * it settled, and none of those says when any one note was written — so a
 * meeting with no tick record has an UNKNOWN lateness, and the report prints
 * that word. Guessing here would put a number in front of a person that
 * nothing measured.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { meetingDirPath } from './meetings.ts';
import type { NoteWait } from './notes-quality-report.ts';

/** Field names a row's settle time may be written under. */
export const SETTLED_KEYS = ['settledAt', 'turnSettledAt', 'settled', 'ts'] as const;

/** Field names a row's note-written time may be written under. */
export const WROTE_KEYS = ['wroteAt', 'writtenAt', 'noteAt', 'composedAt', 'completedAt'] as const;

/** Where a meeting's per-tick timing record lives, if it has one. */
export function tickTimingPath(dataDir: string, docId: string, meetingId: string): string {
  const safe = meetingId.replace(/[^A-Za-z0-9._-]/g, '_');
  return join(meetingDirPath(dataDir, docId), `${safe}.ticks.jsonl`);
}

function millis(row: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

/**
 * The waits a meeting's timing record reports, or `null` when it has none.
 *
 * `null` and `[]` mean different things and the caller depends on it: `null`
 * is "no record was written", an empty array is "a record was written and
 * held no readable row". Both come out of the report as an unknown lateness,
 * but only the second one is a bug in the writer.
 *
 * Total: an unreadable file, a torn line, a row with a write time before its
 * settle time — each is skipped, and none takes the meeting's stop down with
 * it. A stop that threw here would cost the doc its notes flush.
 */
export function readTickWaits(
  dataDir: string,
  docId: string,
  meetingId: string,
): NoteWait[] | null {
  const path = tickTimingPath(dataDir, docId, meetingId);
  if (!existsSync(path)) return null;
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  const waits: NoteWait[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let row: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== 'object' || parsed === null) continue;
      row = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    const settled = millis(row, SETTLED_KEYS);
    const wrote = millis(row, WROTE_KEYS);
    if (settled === null || wrote === null) continue;
    const waitMs = wrote - settled;
    // A negative wait is a clock that moved or a row written the other way
    // round. Reporting it as a fast note would drag the median down, which is
    // the direction that hides a problem.
    if (waitMs < 0) continue;
    waits.push({ waitMs });
  }
  return waits;
}
