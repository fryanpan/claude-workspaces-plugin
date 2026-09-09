/**
 * How long a settled turn waited for the note that carried it — read off the
 * per-tick timing record the notes pipeline writes beside the transcript.
 *
 * WHY IT IS A READER AND NOT A WRITER. Nothing in this file records anything.
 * The record is written by the work that owns the notes clocks
 * (`notes-timing.ts`), which measures the chain a tick goes through and puts
 * one line per tick in `<meetingId>-timing.jsonl`. This module reads one
 * field out of those lines, because the quality report answers a narrower
 * question than that file exists for: not where a note's minute went, but
 * how many notes took too long.
 *
 * THE FIELD IS `settledToWrittenMs`, and taking it rather than subtracting
 * two timestamps is the point. The writer already knows the answer — from the
 * moment the words stopped changing to the moment the note was in the doc —
 * and it knows the cases where there is no answer: a tick that carried
 * nothing settled reports `null`, and a tick whose write failed reports an
 * outcome that is not `written`. Recomputing it here from `settledAt` and a
 * finish time would quietly disagree with the summary line in the same file.
 *
 * A row is read only when its outcome is `written` AND its
 * `settledToWrittenMs` is a number. That skips the failed and empty ticks,
 * and it skips the summary object the log appends at the end of a meeting,
 * which carries neither field.
 *
 * WHAT IT WILL NOT DO. It will not infer a wait from the meeting record. The
 * record carries when the meeting started, when it stopped and how many turns
 * it settled, and none of those says when any one note was written — so a
 * meeting with no timing record has an UNKNOWN lateness, and the report
 * prints that word. Guessing here would put a number in front of a person
 * that nothing measured.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { meetingDirPath } from './meetings.ts';
import type { NoteWait } from './notes-quality-report.ts';

/**
 * Where a meeting's per-tick timing record lives.
 *
 * The same path `meetingTimingPath` builds in `meetings.ts` on the branch
 * that writes the file, spelled here so this reader does not have to land in
 * the same commit as the writer. The filename is asserted exactly by this
 * module's test; collapse the two into the one exported helper once both are
 * on main.
 */
export function tickTimingPath(dataDir: string, docId: string, meetingId: string): string {
  const safe = meetingId.replace(/[^A-Za-z0-9._-]/g, '_');
  return join(meetingDirPath(dataDir, docId), `${safe}-timing.jsonl`);
}

/**
 * The waits a meeting's timing record reports, or `null` when it has none.
 *
 * `null` and `[]` mean different things and the caller depends on it: `null`
 * is "no record was written", an empty array is "a record was written and
 * held no tick that reached the doc". Both come out of the report as an
 * unknown lateness, but only the second one is worth looking at.
 *
 * Total: an unreadable file, a torn line, a row whose latency is negative —
 * each is skipped, and none takes the meeting's stop down with it. A stop
 * that threw here would cost the doc its notes flush.
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
    if (row.outcome !== 'written') continue;
    const waitMs = row.settledToWrittenMs;
    if (typeof waitMs !== 'number' || !Number.isFinite(waitMs)) continue;
    // A negative latency is a clock that moved. Reporting it as a fast note
    // would drag the median down, which is the direction that hides a
    // problem.
    if (waitMs < 0) continue;
    waits.push({ waitMs });
  }
  return waits;
}
