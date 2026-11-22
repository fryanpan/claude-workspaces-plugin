/**
 * The coverage stamp: one line in a finished meeting's notes saying how much
 * of it was heard, and the same figures in `meeting.json`.
 *
 * The notes of a meeting that lost two thirds of its audio used to read like
 * complete notes. The line makes the loss part of the record a reader sees:
 * "Coverage: captured 68 of 188 minutes; gaps at 18:02–18:11, 19:40–19:43."
 *
 * ONE LINE, REWRITTEN IN PLACE. A meeting can end more than once — a drop
 * that is waited out and then resumed, a Stop after it — so a later stamp
 * finds the earlier one by its `Coverage:` prefix under the meeting's own
 * heading and replaces it, rather than adding a second.
 *
 * Written through the notes pipeline's own seams (`readOutline`,
 * `notesHeadingId`, `onNotes`), the same path a note-taker trace line takes,
 * so it lands in the meeting's section and nowhere else. A meeting with no
 * notes, or no section yet, gets no line; `meeting.json` still gets the
 * figures (`writeCoverageJson` in `meeting-raw.ts`, which owns that file).
 */
import {
  COVERAGE_STAMP_PREFIX,
  type CoverageSummary,
  coverageStampLine,
  localClock,
  summarizeCoverage,
  wholeMeetingGaps,
} from '@claude-workspaces/core';
import type { MeetingNotesDeps } from './meeting-notes.ts';
import { type MeetingRecord, type MeetingStore, gapStreamsFor } from './meetings.ts';

/** The figures a stamp states, read off a folded record. */
export function coverageOfRecord(record: MeetingRecord, droppedAt?: number): CoverageSummary {
  const endedAt = record.endedAt ?? droppedAt ?? record.startedAt;
  const gaps = wholeMeetingGaps(gapStreamsFor(record.source ?? 'mic'), record.gaps ?? [], endedAt);
  return summarizeCoverage({
    audioMs: record.audioMs ?? 0,
    startedAt: record.startedAt,
    endedAt,
    gaps,
    ...(droppedAt !== undefined ? { droppedAt } : {}),
  });
}

/**
 * Put `line` in the meeting's notes section, replacing an earlier stamp.
 * Answers whether it was written.
 */
export function writeCoverageStamp(
  notes: Pick<MeetingNotesDeps, 'readOutline' | 'notesHeadingId' | 'onNotes'>,
  ids: { docId: string; meetingId: string },
  line: string,
): boolean {
  const outline = notes.readOutline?.(ids) ?? [];
  const headingId = notes.notesHeadingId?.({ ...ids, outline });
  if (headingId === undefined) return false;
  const prior = outline.find(
    (e) => e.underHeadingId === headingId && e.text.startsWith(COVERAGE_STAMP_PREFIX),
  );
  const answer = notes.onNotes({
    ...ids,
    // Not a tick: nothing was said, so nothing is charged to the room.
    tick: { tick: 0, reason: 'end', turns: [] },
    edits: [
      prior
        ? { op: 'replace_block', blockId: prior.id, markdown: line }
        : { op: 'insert_under_heading', headingId, markdown: line },
    ],
  });
  return answer !== false && answer !== 'refused';
}

/** The clock the stamp's times are read on: the server's, as the
 *  note-taker's own trace lines are (`notesMethodTraceLine`). */
export const stampClock = localClock;

/**
 * A meeting has ended for good: its figures into `meeting.json`, and its
 * stamp into the notes when it writes notes. Never throws — a stamp that
 * cannot be written must not fail the stop that asked for it.
 */
export function stampMeetingCoverage(args: {
  store: Pick<MeetingStore, 'list' | 'recordCoverage'>;
  notes: Pick<MeetingNotesDeps, 'readOutline' | 'notesHeadingId' | 'onNotes'> | null;
  docId: string;
  meetingId: string;
  droppedAt?: number;
  log: (line: string) => void;
}): CoverageSummary | null {
  const { docId, meetingId } = args;
  try {
    const record = args.store.list(docId).find((m) => m.meetingId === meetingId);
    if (!record) return null;
    const coverage = coverageOfRecord(record, args.droppedAt);
    args.store.recordCoverage(docId, meetingId, coverage);
    // A meeting that settled no turn wrote no notes, so there is nothing for
    // the line to qualify; `meeting.json` above still has the figures.
    if (args.notes && (record.turns ?? 0) > 0) {
      writeCoverageStamp(args.notes, { docId, meetingId }, coverageStampLine(coverage, stampClock));
    }
    args.log(
      `[meeting] coverage doc=${docId} meeting=${meetingId} capturedMs=${coverage.capturedMs} ` +
        `elapsedMs=${coverage.elapsedMs} gaps=${coverage.gaps.length}` +
        (args.droppedAt !== undefined ? ' dropped=true' : ''),
    );
    return coverage;
  } catch (err) {
    args.log(
      `[meeting] coverage not stamped doc=${docId} meeting=${meetingId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}
