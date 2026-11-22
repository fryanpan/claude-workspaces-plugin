/**
 * Noticing, while a meeting runs, that its audio has stopped arriving.
 *
 * A 188-minute meeting reached the transcript for 68 minutes and nobody in the
 * room was told. Two failures caused most of the loss, and the server sees
 * both:
 *
 * - The socket stays open and no audio frame arrives. A browser sends frames
 *   continuously, silent room or not, so a minute with none means the capture
 *   stopped (a suspended tab, a dead device), never that the room went quiet.
 * - The socket closes without a `stop` and does not come back. A page move
 *   closes it too, and resumes within a second, so a drop is only a gap once
 *   it has lasted `COVERAGE_GAP_MS` as well.
 *
 * Either way the meeting's live coverage goes to `gap`, which every page
 * showing the meeting turns into the alert. A no-audio gap is also written to
 * the record as gap lines, beside the ones a reconnect writes. A drop that is
 * never picked up is handed back as `abandoned` after `ABANDON_MS`, so the
 * notes still get their coverage stamp.
 *
 * ONE TIMER PER MEETING, NOT PER FRAME. A frame only stamps `lastFrameAt`;
 * the timer fires at most once a minute and re-arms for whatever is left of
 * the window. The clock and the scheduler are injected so the tests walk a
 * fake minute without sleeping.
 */
import {
  COVERAGE_GAP_MS,
  type CoverageGapReason,
  type CoverageState,
  type MeetingCoverageLive,
} from '@claude-workspaces/core';
import { type ActiveMeeting, NO_AUDIO_GAP_REASON } from './meetings.ts';

/**
 * How long a dropped recording is waited for before its meeting is treated
 * as over. The browser gives up reconnecting after two minutes
 * (`meeting-reconnect.ts`); the rest is margin for its last attempt.
 */
export const ABANDON_MS = 150_000;

export interface CoverageWatchDeps {
  schedule: (ms: number, fn: () => void) => () => void;
  now: () => number;
  /** The live coverage changed; every page showing the meeting wants it. */
  emit: (docId: string, coverage: MeetingCoverageLive) => void;
  /** A leg ended without a stop and nothing picked the meeting up.
   *  `withNotes` is whether the meeting writes notes into its doc. */
  abandoned: (docId: string, meetingId: string, droppedAt: number, withNotes: boolean) => void;
}

interface Watched {
  meeting: ActiveMeeting;
  streams: readonly string[];
  withNotes: boolean;
  lastFrameAt: number;
  state: CoverageState;
  gap?: { from: number; reason: CoverageGapReason } | undefined;
  gapsClosed: number;
  cancel: (() => void) | null;
}

export class MeetingCoverageWatch {
  private readonly watched = new Map<string, Watched>();

  constructor(private readonly deps: CoverageWatchDeps) {}

  /**
   * A leg went live: a fresh meeting, a resume, or a takeover. `gapsClosed`
   * is how many whole-meeting gaps the record already holds, so a resume
   * after a restart still says "of N" on the page.
   */
  legStarted(
    meeting: ActiveMeeting,
    opts: { streams: readonly string[]; gapsClosed: number; withNotes: boolean },
  ): void {
    const prior = this.watched.get(meeting.meetingId);
    prior?.cancel?.();
    const w: Watched = {
      meeting,
      streams: opts.streams,
      withNotes: opts.withNotes,
      lastFrameAt: this.deps.now(),
      state: 'recording',
      gapsClosed: opts.gapsClosed,
      cancel: null,
    };
    this.watched.set(meeting.meetingId, w);
    this.arm(w, COVERAGE_GAP_MS);
    this.emit(w);
  }

  /** One audio frame reached the meeting. Cheap: it runs fifty times a second. */
  frame(meetingId: string): void {
    const w = this.watched.get(meetingId);
    if (!w) return;
    const now = this.deps.now();
    w.lastFrameAt = now;
    if (w.state !== 'gap' || w.gap?.reason !== 'no-audio') return;
    for (const s of w.streams) w.meeting.recordGap(s, 'restored', undefined, now);
    w.state = 'recording';
    w.gap = undefined;
    w.gapsClosed += 1;
    this.arm(w, COVERAGE_GAP_MS);
    this.emit(w);
  }

  /**
   * The leg's socket closed at `at`. `over` is a person's Stop, the silence
   * timeout or a lost engine: nothing will resume it. Anything else may be a
   * page move, so it is waited for.
   *
   * Called BEFORE the meeting's own `stop`, because an open no-audio gap is
   * closed here at the instant the socket went, and a stopped meeting writes
   * no more lines. The reconnect gap from then on is the store's to write.
   */
  legEnded(meetingId: string, at: number, over: boolean): void {
    const w = this.watched.get(meetingId);
    if (!w) return;
    w.cancel?.();
    w.cancel = null;
    if (w.state === 'gap' && w.gap?.reason === 'no-audio') {
      for (const s of w.streams) w.meeting.recordGap(s, 'restored', undefined, at);
      w.gapsClosed += 1;
      w.gap = undefined;
    }
    if (over) {
      this.finish(w, at);
      return;
    }
    w.state = 'paused';
    this.emit(w, at);
    w.cancel = this.deps.schedule(COVERAGE_GAP_MS, () => {
      w.cancel = null;
      if (this.watched.get(meetingId) !== w || w.state !== 'paused') return;
      w.state = 'gap';
      w.gap = { from: at, reason: 'connection' };
      this.emit(w);
      w.cancel = this.deps.schedule(ABANDON_MS - COVERAGE_GAP_MS, () => {
        w.cancel = null;
        if (this.watched.get(meetingId) !== w) return;
        this.finish(w, at);
        this.deps.abandoned(w.meeting.docId, meetingId, at, w.withNotes);
      });
    });
  }

  /** The server is going down: no timer outlives it. */
  dispose(): void {
    for (const w of this.watched.values()) w.cancel?.();
    this.watched.clear();
  }

  private finish(w: Watched, at: number): void {
    w.cancel?.();
    w.cancel = null;
    w.state = 'stopped';
    w.gap = undefined;
    this.watched.delete(w.meeting.meetingId);
    this.emit(w, at);
  }

  private arm(w: Watched, ms: number): void {
    w.cancel?.();
    w.cancel = this.deps.schedule(ms, () => {
      w.cancel = null;
      if (this.watched.get(w.meeting.meetingId) !== w || w.state !== 'recording') return;
      const idle = this.deps.now() - w.lastFrameAt;
      if (idle < COVERAGE_GAP_MS) {
        this.arm(w, COVERAGE_GAP_MS - idle);
        return;
      }
      w.state = 'gap';
      w.gap = { from: w.lastFrameAt, reason: 'no-audio' };
      for (const s of w.streams) {
        w.meeting.recordGap(s, 'lost', NO_AUDIO_GAP_REASON, w.lastFrameAt);
      }
      this.emit(w);
    });
  }

  private emit(w: Watched, asOf = this.deps.now()): void {
    this.deps.emit(w.meeting.docId, {
      meetingId: w.meeting.meetingId,
      startedAt: w.meeting.startedAt,
      capturedMs: w.meeting.capturedMs(),
      asOf,
      state: w.state,
      ...(w.gap ? { gap: { ...w.gap } } : {}),
      gapsClosed: w.gapsClosed,
    });
  }
}
