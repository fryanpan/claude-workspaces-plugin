/**
 * How long each section took to fill in interview mode — the number the voice
 * plan compares against plans written by hand ("minutes per filled section").
 *
 * One row per gap the interview finished with, and one per answer saying
 * what the planning voice did after it, in two places:
 *
 *  - a log line, `[interview] doc=… section=N kind=… outcome=filled ms=…`,
 *    `[interview] doc=… section=N after-answer=edit|follow-up|discuss|quiet`
 *    per answer, and one more when the interview ends with the minutes per
 *    filled section;
 *  - `<dataDir>/interview-timings.jsonl`, one JSON row per gap and one per
 *    interview's end, so the numbers survive a restart.
 *
 * `ms` runs from the moment the question was asked (the reply carrying it
 * left the server) to the moment the answer was written into the doc. When
 * the question was talked over first (`after-answer=discuss`), it runs from
 * the last discussion reply instead, and the discussion's own time is the end
 * row's `discussMs`, so minutes per filled section still measure answering
 * and a long conversation about a question does not read as a slow answer. A row
 * carries the doc's id, the section's place among its headings and counts —
 * never a heading, a question or an answer, so the file holds no doc content.
 */
import { appendFileSync } from 'node:fs';
import type { GapKind } from './interview-gaps.ts';

export const INTERVIEW_TIMINGS_FILE = 'interview-timings.jsonl';

export type GapOutcome = 'filled' | 'skipped' | 'deferred' | 'ended' | 'gone';

export interface InterviewGapRow {
  type: 'gap';
  interview: string;
  docId: string;
  /** The section's place among the doc's headings, from 0. */
  section: number;
  kind: GapKind;
  outcome: GapOutcome;
  /** Question asked to answer written (or to the skip, the deferral, the end). */
  ms: number;
  /** Words written, for `filled`. */
  words?: number;
  at: number;
}

export interface InterviewEndRow {
  type: 'end';
  interview: string;
  docId: string;
  gaps: number;
  filled: number;
  skipped: number;
  /** Start of the interview to its end. */
  ms: number;
  /** Mean over filled sections; absent when none was filled. */
  minutesPerFilled?: number;
  /** Discussion replies, and their time; absent when there were none. */
  discussed?: number;
  discussMs?: number;
  at: number;
}

/** What the planning voice did after an answer: wrote it into the doc,
 *  asked for more, talked the question over and kept it open, or said
 *  nothing and waited for its next question. */
export type AfterAnswer = 'edit' | 'follow-up' | 'discuss' | 'quiet';

export interface InterviewAnswerRow {
  type: 'answer';
  interview: string;
  docId: string;
  section: number;
  kind: GapKind;
  after: AfterAnswer;
  at: number;
}

export type InterviewRow = InterviewGapRow | InterviewEndRow | InterviewAnswerRow;

export class InterviewLog {
  /** `file` absent: the log line only (tests, and a server with no data dir). */
  constructor(
    private readonly file?: string,
    private readonly log: (line: string) => void = (l) => console.log(l),
  ) {}

  record(row: InterviewRow): void {
    if (row.type === 'gap') {
      this.log(
        `[interview] doc=${row.docId} section=${row.section} kind=${row.kind} ` +
          `outcome=${row.outcome} ms=${row.ms}${row.words !== undefined ? ` words=${row.words}` : ''}`,
      );
    } else if (row.type === 'answer') {
      this.log(`[interview] doc=${row.docId} section=${row.section} after-answer=${row.after}`);
    } else {
      this.log(
        `[interview] done doc=${row.docId} gaps=${row.gaps} filled=${row.filled} ` +
          `skipped=${row.skipped} ms=${row.ms}` +
          (row.minutesPerFilled !== undefined
            ? ` minutesPerFilled=${row.minutesPerFilled.toFixed(2)}`
            : '') +
          (row.discussed ? ` discussed=${row.discussed} discussMs=${row.discussMs ?? 0}` : ''),
      );
    }
    if (!this.file) return;
    try {
      appendFileSync(this.file, `${JSON.stringify(row)}\n`);
    } catch {
      // A full disk loses a measurement, not the answer.
    }
  }
}
