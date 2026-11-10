/**
 * One `LeadLineHold` per board meeting, listening to the room through the
 * meeting's own transcript (`MeetingEars`), so the `say` route can wait for
 * the speaker to finish before the lead's line is said.
 *
 * The room is heard from the moment the recording opens (`listen`) or, after
 * a server restart, from the lead's first line; until then a hold that has
 * heard nothing takes the room as quiet. A line that answers a "Lead, …"
 * ask is not held: the room asked and is waiting (`addressed`).
 *
 * Which arm runs is `CW_MEETING_LEAD_HOLD` (`leadHoldArm`): `judge` by
 * default when a Haiku completer is configured, `gate` without one, and
 * `off` says every line at once as before. The replay that chose the
 * default is `scripts/lead-hold-replay.ts`.
 */
import type { MeetingEars } from '../spoken-reply/meeting-ears.ts';
import type { GateTimers } from '../spoken-reply/pause-gate.ts';
import type { ThoughtJudge } from '../spoken-reply/thought-finished.ts';
import type { TranscriptionSession } from '../transcribe.ts';
import {
  HOLD_ARMS,
  type HoldArm,
  type HoldOutcome,
  type HoldTiming,
  LeadLineHold,
} from './lead-line-hold.ts';

/** How long after a "Lead, …" ask the lead's next line counts as its answer. */
export const ADDRESSED_MS = 60_000;

export type LeadHoldSetting = HoldArm | 'off';

/** The arm `CW_MEETING_LEAD_HOLD` names; an unknown value is the default. */
export function leadHoldArm(
  env: Record<string, string | undefined>,
  hasJudge: boolean,
): LeadHoldSetting {
  const v = env.CW_MEETING_LEAD_HOLD;
  if (v === 'off') return 'off';
  if (v && (HOLD_ARMS as readonly string[]).includes(v)) {
    return v === 'judge' && !hasJudge ? 'gate' : (v as HoldArm);
  }
  return hasJudge ? 'judge' : 'gate';
}

export interface LeadLineHoldsDeps {
  ears: Pick<MeetingEars, 'engine'> | null;
  setting: LeadHoldSetting;
  judge: ThoughtJudge | null;
  timing?: Partial<HoldTiming>;
  timers?: GateTimers;
  now?: () => number;
}

interface Room {
  meetingId: string;
  docId: string;
  hold: LeadLineHold;
  session: Promise<TranscriptionSession | null>;
  /** When a "Lead, …" ask reached the lead; null when none is open. */
  addressed: number | null;
}

export class LeadLineHolds {
  private readonly rooms = new Map<string, Room>();

  constructor(private readonly deps: LeadLineHoldsDeps) {}

  /** Start hearing the room of the meeting on `workspaceId`. */
  listen(workspaceId: string, meeting: { id: string; docId: string }): void {
    if (this.deps.setting === 'off' || this.deps.setting === 'at-once') return;
    const had = this.rooms.get(workspaceId);
    if (had && had.meetingId === meeting.id && had.docId === meeting.docId) return;
    const addressed = had?.meetingId === meeting.id ? had.addressed : null;
    if (had) this.close(workspaceId);
    const hold = new LeadLineHold({
      arm: this.deps.setting,
      now: this.deps.now ?? Date.now,
      ...(this.deps.timers ? { timers: this.deps.timers } : {}),
      judge: this.deps.judge,
      ...(this.deps.timing ? { timing: this.deps.timing } : {}),
    });
    const ears = this.deps.ears;
    const session: Promise<TranscriptionSession | null> = ears
      ? ears
          .engine(meeting.docId)
          .open({
            onTurn: (t) =>
              hold.heard({
                turn: t.turn,
                text: t.text,
                final: t.final,
                ...(t.speaker ? { speaker: t.speaker } : {}),
              }),
            onError: () => {},
            // The meeting's own engine carries the audio; these two are unread.
            sampleRate: 16_000,
            detectSpeakers: false,
          })
          .catch(() => null)
      : Promise.resolve(null);
    this.rooms.set(workspaceId, {
      meetingId: meeting.id,
      docId: meeting.docId,
      hold,
      session,
      addressed,
    });
  }

  /** A "Lead, …" line reached the lead: its next line answers it. */
  addressed(workspaceId: string, meeting: { id: string; docId: string }): void {
    this.listen(workspaceId, meeting);
    const room = this.rooms.get(workspaceId);
    if (room) room.addressed = (this.deps.now ?? Date.now)();
  }

  /** Wait until the lead's line may be said, or is dropped. */
  async wait(workspaceId: string, meeting: { id: string; docId: string }): Promise<HoldOutcome> {
    const now: HoldOutcome = { said: true, waitedMs: 0, judged: 0 };
    if (this.deps.setting === 'off' || this.deps.setting === 'at-once') return now;
    this.listen(workspaceId, meeting);
    const room = this.rooms.get(workspaceId);
    if (!room) return now;
    const askedAt = room.addressed;
    room.addressed = null;
    // An answer comes soon after the ask; a line long after it is the lead's own.
    if (askedAt !== null && (this.deps.now ?? Date.now)() - askedAt <= ADDRESSED_MS) {
      return now;
    }
    // Nothing to listen with means nothing to wait for.
    if (!(await room.session)) return now;
    // The meeting ended, or moved on, while the ears opened.
    if (this.rooms.get(workspaceId) !== room) return { said: false, reason: 'ended' };
    return new Promise((done) => room.hold.request(done));
  }

  /** The meeting ended: a waiting line is not said. */
  end(workspaceId: string): void {
    this.close(workspaceId);
  }

  private close(workspaceId: string): void {
    const room = this.rooms.get(workspaceId);
    if (!room) return;
    this.rooms.delete(workspaceId);
    room.hold.end();
    void room.session.then((s) => s?.close());
  }
}
