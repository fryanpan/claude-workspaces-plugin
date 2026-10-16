/**
 * A planning-voice run as `interview.ts` holds it, and the rows it leaves in
 * the interview log (`interview-log.ts`): one per answer, one per settled
 * question, and one when the run ends.
 *
 * IN A MEETING THE RUN ENDS WITH THE MEETING. Off a meeting a run is one
 * stretch of questions, and its end row is written when it stops. In a
 * planning meeting the voice asks one question, reads again at the next
 * pause, and may ask another an hour later, so a run per question would log
 * the voice as done after its first answer while the meeting is still
 * recording. There, every run's counts go into one tally, and its end row is
 * written once, when the socket goes (`InterviewRecord.close`).
 */
import type { PlanGap } from './interview-gaps.ts';
import type { AfterAnswer, GapOutcome, InterviewLog } from './interview-log.ts';
import type { InterviewSlots, SlotTransition } from './interview-state.ts';

export interface Running {
  id: string;
  docId: string;
  slots: InterviewSlots;
  /** When the current slot was asked. */
  askedAt: number;
  startedAt: number;
  /** Question (or the last discussion reply) to answer written, summed over
   *  filled slots. */
  filledMs: number;
  /** Discussion replies, and the time spent talking questions over before
   *  their answers: kept out of `filledMs`. */
  discussed: number;
  discussMs: number;
  /** The latest reply talked the current question over; it is still open. */
  discussing: boolean;
  /** The current slot has had its one follow-up. */
  followedUp: boolean;
  /** The last answer settled nothing: the next question waits for a pause. */
  waiting: boolean;
  /** Its one slot was chosen by reading the plan, and the next will be. */
  reading: boolean;
}

/** The log's word for each transition. */
export const OUTCOME: Record<SlotTransition, GapOutcome> = {
  placed: 'filled',
  skipped: 'skipped',
  deferred: 'deferred',
  gone: 'gone',
  ended: 'ended',
};

interface Tally {
  id: string;
  docId: string;
  startedAt: number;
  gaps: number;
  filled: number;
  skipped: number;
  filledMs: number;
  discussed: number;
  discussMs: number;
}

export class InterviewRecord {
  /** A meeting's runs so far, logged as one when the socket goes. */
  private tally: Tally | null = null;

  constructor(
    private readonly log: InterviewLog,
    private readonly now: () => number,
  ) {}

  answer(run: Running, gap: PlanGap, after: AfterAnswer): void {
    this.log.record({
      type: 'answer',
      interview: run.id,
      docId: run.docId,
      section: gap.ordinal,
      kind: gap.kind,
      after,
      at: this.now(),
    });
  }

  gap(run: Running, gap: PlanGap, outcome: GapOutcome, words?: number): void {
    this.log.record({
      type: 'gap',
      interview: run.id,
      docId: run.docId,
      section: gap.ordinal,
      kind: gap.kind,
      outcome,
      ms: this.now() - run.askedAt,
      ...(words !== undefined ? { words } : {}),
      at: this.now(),
    });
  }

  /** `run` stopped. `meeting`: its counts wait for the meeting's end. */
  end(run: Running, meeting: boolean): void {
    const { slots } = run;
    if (meeting) {
      if (this.tally && this.tally.docId !== run.docId) this.close();
      const t = (this.tally ??= {
        id: run.id,
        docId: run.docId,
        startedAt: run.startedAt,
        gaps: 0,
        filled: 0,
        skipped: 0,
        filledMs: 0,
        discussed: 0,
        discussMs: 0,
      });
      t.gaps += slots.total;
      t.filled += slots.placed;
      t.skipped += slots.skipped;
      t.filledMs += run.filledMs;
      t.discussed += run.discussed;
      t.discussMs += run.discussMs;
      return;
    }
    this.row({
      id: run.id,
      docId: run.docId,
      startedAt: run.startedAt,
      gaps: slots.total,
      filled: slots.placed,
      skipped: slots.skipped,
      filledMs: run.filledMs,
      discussed: run.discussed,
      discussMs: run.discussMs,
    });
  }

  /** The socket went: a meeting's tally is written. */
  close(): void {
    if (this.tally) this.row(this.tally);
    this.tally = null;
  }

  private row(t: Tally): void {
    this.log.record({
      type: 'end',
      interview: t.id,
      docId: t.docId,
      gaps: t.gaps,
      filled: t.filled,
      skipped: t.skipped,
      ms: this.now() - t.startedAt,
      ...(t.filled > 0 ? { minutesPerFilled: t.filledMs / t.filled / 60_000 } : {}),
      ...(t.discussed > 0 ? { discussed: t.discussed, discussMs: t.discussMs } : {}),
      at: this.now(),
    });
  }
}
