/**
 * A line the board's lead wants to say into a meeting waits until the
 * speaker has finished the thought.
 *
 * Before this, `say_in_meeting` played the line at once, over whoever was
 * talking. Now the line is held here and released at a moment the room has
 * left for it. Three ways to pick that moment, kept side by side so the
 * replay (`scripts/lead-hold-replay.ts`) can score each on the same script:
 *
 *  - `at-once`: no hold. The old behaviour, and the replay's positive control.
 *  - `gate`: the pause gate as the tapped request ships it (`pause-gate.ts`):
 *    a final turn whose words look finished, or 1.5s of silence; 3s after a
 *    phrase that stops mid-sentence.
 *  - `judge`: the gate without the final (Soniox settles a mid-thought stop in
 *    about 200ms at the meeting's level, so a final says nothing here), at
 *    `quietMs` of silence, and then one "is this thought finished?" call
 *    (`thought-finished.ts`) on the last few lines. A question put to the room
 *    skips the call.
 *
 * In the judge arm, words heard while the judge is out cancel the call, and
 * the line goes only once the room has stayed quiet `graceMs` past the moment
 * the judge was asked; words inside that window put it back on hold, which
 * is the room starting to talk just before the voice plays. Without a judge
 * the arm releases on the same grace (the replay's G0). A judge that keeps
 * saying "unfinished" over a silent room is overruled after `overrideMs` of
 * silence. A line still held after `lapseMs` is dropped
 * and the lead is told: the talk has moved past it, and playing it late would
 * answer something nobody is discussing.
 *
 * One line waits at a time; a second request replaces the first. Room frames
 * in, one call out per request, timers and clock through seams so a test or
 * the replay drives it on a fake clock.
 */
import {
  type GateTimers,
  PauseGate,
  REAL_TIMERS,
  midSentence,
} from '../spoken-reply/pause-gate.ts';
import { type ThoughtJudge, invitesReply } from '../spoken-reply/thought-finished.ts';

export const HOLD_ARMS = ['at-once', 'gate', 'judge'] as const;
export type HoldArm = (typeof HOLD_ARMS)[number];

export interface HoldTiming {
  /** `gate`: silence after finished-looking words (the tap path's 1.5s). */
  finishedMs: number;
  /** Both held arms: silence after words that stop mid-sentence. */
  unfinishedMs: number;
  /** `judge`: silence before the judge is asked. */
  quietMs: number;
  /** After the decision, words heard inside this window put the line back. */
  graceMs: number;
  /** Silence after which a line goes even though the judge said unfinished. */
  overrideMs: number;
  /** How long a line may wait before it is dropped. */
  lapseMs: number;
}

export const HOLD_TIMING: HoldTiming = {
  finishedMs: 1500,
  unfinishedMs: 3000,
  quietMs: 1200,
  graceMs: 400,
  overrideMs: 4000,
  lapseMs: 20_000,
};

export type HoldOutcome =
  | { said: true; waitedMs: number; judged: number }
  | { said: false; reason: 'lapsed' | 'replaced' | 'ended' };

/** One frame of the room, in the shape `MeetingEars` hands on. */
export interface RoomFrame {
  turn: number;
  text: string;
  final: boolean;
  speaker?: string;
}

/** The lines the judge reads. */
const RECENT_LINES = 5;

interface Waiting {
  at: number;
  done: (o: HoldOutcome) => void;
  lapse: unknown;
  judged: number;
}

export interface LeadLineHoldOpts {
  arm: HoldArm;
  now: () => number;
  timers?: GateTimers;
  judge?: ThoughtJudge | null;
  timing?: Partial<HoldTiming>;
  /** `gate`: what reads as not yet a sentence (the tap path's
   *  `unfinishedAsk` is the replay's F2 arm). */
  unfinished?: (text: string) => boolean;
  /** `gate`: whether a final turn opens it (off for the replay's fixed-silence
   *  arm). */
  finalOpens?: boolean;
}

export class LeadLineHold {
  private readonly timing: HoldTiming;
  private readonly timers: GateTimers;
  private readonly gate: PauseGate | null;
  /** Nothing new has been said since the gate last opened. A room nobody
   *  has spoken in yet is quiet. */
  private quiet = true;
  private lastNewsAt = 0;
  private waiting: Waiting | null = null;
  private cancelJudge: (() => void) | null = null;
  private graceTimer: unknown = null;
  private overrideTimer: unknown = null;
  private readonly lines: RoomFrame[] = [];

  constructor(private readonly opts: LeadLineHoldOpts) {
    this.timing = { ...HOLD_TIMING, ...opts.timing };
    this.timers = opts.timers ?? REAL_TIMERS;
    const t = this.timing;
    this.gate =
      opts.arm === 'gate'
        ? new PauseGate(
            () => this.paused(),
            this.timers,
            { finishedMs: t.finishedMs, unfinishedMs: t.unfinishedMs },
            opts.unfinished ?? midSentence,
            opts.finalOpens ?? true,
          )
        : opts.arm === 'judge'
          ? new PauseGate(
              () => this.paused(),
              this.timers,
              { finishedMs: t.quietMs, unfinishedMs: t.unfinishedMs },
              midSentence,
              false,
            )
          : null;
  }

  get holding(): boolean {
    return this.waiting !== null;
  }

  /** What the room said: every frame, partials included. */
  heard(f: RoomFrame): void {
    const text = f.text.trim();
    if (!text) return;
    const i = this.lines.findIndex((l) => l.turn === f.turn);
    const news = i < 0 || this.lines[i]?.text.trim() !== text;
    if (i >= 0) this.lines.splice(i, 1);
    this.lines.push({ ...f, text });
    if (this.lines.length > RECENT_LINES) this.lines.shift();
    if (news) {
      this.quiet = false;
      this.lastNewsAt = this.opts.now();
      // Somebody is talking: whatever was about to let the line go stops.
      this.stopDeciding();
    }
    this.gate?.heard(text, f.final);
    // A question to the room hands over the floor once it settles.
    if (this.opts.arm === 'judge' && f.final && this.waiting && invitesReply(text)) {
      this.gate?.cancel();
      this.quiet = true;
      this.startGrace();
    }
  }

  /** The lead wants to speak; `done` hears once whether the line went. */
  request(done: (o: HoldOutcome) => void): void {
    if (this.waiting) this.finish({ said: false, reason: 'replaced' });
    if (this.opts.arm === 'at-once') {
      done({ said: true, waitedMs: 0, judged: 0 });
      return;
    }
    const lapse = this.timers.set(
      () => this.finish({ said: false, reason: 'lapsed' }),
      this.timing.lapseMs,
    );
    this.waiting = { at: this.opts.now(), done, lapse, judged: 0 };
    if (this.quiet) this.moment();
  }

  /** The meeting ended; a waiting line is not said. */
  end(): void {
    this.gate?.cancel();
    if (this.waiting) this.finish({ said: false, reason: 'ended' });
  }

  /** The recent lines, as the judge reads them. */
  recent(): string {
    return this.lines.map((l) => (l.speaker ? `${l.speaker}: ${l.text}` : l.text)).join('\n');
  }

  private paused(): void {
    this.quiet = true;
    if (this.waiting) this.moment();
  }

  /** The room is quiet and a line waits: decide. */
  private moment(): void {
    const w = this.waiting;
    if (!w) return;
    if (this.opts.arm === 'gate') {
      this.release();
      return;
    }
    if (this.cancelJudge || this.graceTimer !== null) return;
    if (!this.opts.judge) {
      this.startGrace();
      return;
    }
    w.judged += 1;
    const askedAt = this.opts.now();
    // A judge that answers after it was cancelled is not heard.
    let live = true;
    const cancel = this.opts.judge(this.recent(), (finished) => {
      if (!live) return;
      live = false;
      this.cancelJudge = null;
      if (!this.waiting) return;
      if (finished) this.startGrace(askedAt);
      else this.armOverride();
    });
    if (live)
      this.cancelJudge = () => {
        live = false;
        cancel();
      };
  }

  /** Release once the room has stayed quiet `graceMs` past `since`. The
   *  judge's own call counts: words heard during it would have cancelled it. */
  private startGrace(since = this.opts.now()): void {
    if (this.graceTimer !== null) return;
    const left = Math.max(0, this.timing.graceMs - (this.opts.now() - since));
    this.graceTimer = this.timers.set(() => {
      this.graceTimer = null;
      this.release();
    }, left);
  }

  private armOverride(): void {
    const quietFor = this.opts.now() - this.lastNewsAt;
    const left = Math.max(0, this.timing.overrideMs - quietFor);
    // The room has then been quiet far longer than any grace: no grace.
    this.overrideTimer = this.timers.set(() => {
      this.overrideTimer = null;
      this.release();
    }, left);
  }

  private stopDeciding(): void {
    this.cancelJudge?.();
    this.cancelJudge = null;
    if (this.graceTimer !== null) this.timers.clear(this.graceTimer);
    this.graceTimer = null;
    if (this.overrideTimer !== null) this.timers.clear(this.overrideTimer);
    this.overrideTimer = null;
  }

  private release(): void {
    const w = this.waiting;
    if (!w) return;
    this.finish({ said: true, waitedMs: this.opts.now() - w.at, judged: w.judged });
  }

  private finish(o: HoldOutcome): void {
    const w = this.waiting;
    if (!w) return;
    this.waiting = null;
    this.stopDeciding();
    this.timers.clear(w.lapse);
    w.done(o);
  }
}
