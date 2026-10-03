/**
 * The coach's one file, `<dataDir>/coach/state.json`: where its docs are,
 * his how-readily setting, the moments, and how many events went to the
 * coach session each day. Owner-only on disk (mode 600), and written whole
 * through a temp file, like the inbox's files.
 */
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { isKnownTimezone } from '@claude-workspaces/core/schedule-timezone';
import { readJsonFile, writeJsonFile } from '../inbox/json-file.ts';
import { localDay } from './clock.ts';
import {
  COACH_READINESS,
  type CoachDocRef,
  type CoachMoment,
  type CoachReadiness,
  type CoachState,
  KEEP_EVENT_DAYS,
  type MomentAnswer,
  REVIEW_AFTER_MS,
} from './types.ts';

export const COACH_DIRNAME = 'coach';
/** Until a browser says otherwise, the zone this machine is in. */
const DEFAULT_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
/** The event count is written at most this often; a crash loses at most it. */
const COUNT_WRITE_MS = 60_000;

const empty = (): CoachState => ({
  timeZone: DEFAULT_ZONE,
  readiness: 'normal',
  moments: [],
  eventsByDay: {},
});

/** One week's answers, for the front page's line and the wrong-call rate. */
export interface CoachWeek {
  moments: number;
  thanks: number;
  notNow: number;
  notThis: number;
  unanswered: number;
  /** Events the coach session read today. */
  eventsToday: number;
}

export class CoachStore {
  private readonly path: string;
  private state: CoachState;
  private countWrittenAt = 0;

  constructor(dataDir: string, now: number = Date.now()) {
    this.path = join(dataDir, COACH_DIRNAME, 'state.json');
    const { value, error } = readJsonFile<CoachState>(this.path, empty(), now);
    if (error) console.warn(`[coach] state unreadable: ${error}; starting empty`);
    this.state = { ...empty(), ...value };
    if (!isKnownTimezone(this.state.timeZone)) this.state.timeZone = DEFAULT_ZONE;
    if (!COACH_READINESS.includes(this.state.readiness)) this.state.readiness = 'normal';
    if (typeof this.state.eventsByDay !== 'object' || this.state.eventsByDay === null) {
      this.state.eventsByDay = {};
    }
  }

  get timeZone(): string {
    return this.state.timeZone;
  }

  get readiness(): CoachReadiness {
    return this.state.readiness;
  }

  get goalsDoc(): CoachDocRef | undefined {
    return this.state.goalsDoc;
  }

  get memoryDoc(): CoachDocRef | undefined {
    return this.state.memoryDoc;
  }

  noteTimeZone(timeZone: unknown): void {
    if (typeof timeZone !== 'string' || timeZone === this.state.timeZone) return;
    if (!isKnownTimezone(timeZone)) return;
    this.state.timeZone = timeZone;
    this.write();
  }

  setGoalsDoc(doc: CoachDocRef): void {
    this.state.goalsDoc = doc;
    this.state.goalsChangedAt = doc.createdAt;
    this.write();
  }

  setMemoryDoc(doc: CoachDocRef): void {
    this.state.memoryDoc = doc;
    this.write();
  }

  setReadiness(readiness: CoachReadiness): void {
    this.state.readiness = readiness;
    this.write();
  }

  /** He edited the goals doc. Written at most once a minute. */
  noteGoalsChanged(at: number): void {
    const last = this.state.goalsChangedAt ?? 0;
    if (at - last < 60_000) return;
    this.state.goalsChangedAt = at;
    this.write();
  }

  declineReview(now: number): void {
    this.state.reviewDeclinedAt = now;
    this.write();
  }

  /** Is the weekly offer to review the goals due? Seven days after the
   *  later of his last change and his last "no update needed". */
  reviewDue(now: number): boolean {
    if (!this.state.goalsDoc) return false;
    const since = Math.max(this.state.goalsChangedAt ?? 0, this.state.reviewDeclinedAt ?? 0);
    return now - since >= REVIEW_AFTER_MS;
  }

  moments(): readonly CoachMoment[] {
    return this.state.moments;
  }

  /** The moment on the page, if any. It stays until he answers or moves on. */
  openMoment(): CoachMoment | null {
    return this.state.moments.find((m) => m.state === 'open') ?? null;
  }

  addMoment(m: Omit<CoachMoment, 'id' | 'day' | 'state'>): CoachMoment {
    const moment: CoachMoment = {
      ...m,
      id: `cm-${randomBytes(9).toString('base64url').slice(0, 12)}`,
      day: localDay(m.at, this.state.timeZone),
      state: 'open',
    };
    this.state.moments.push(moment);
    this.write();
    return moment;
  }

  /** His answer, or `moved-on` when he left it. False when it is not open. */
  answer(id: string, answer: MomentAnswer | 'moved-on', now: number): boolean {
    const m = this.state.moments.find((x) => x.id === id);
    if (!m || m.state !== 'open') return false;
    m.state = answer;
    m.answeredAt = now;
    this.write();
    return true;
  }

  /** One event went to the coach session. */
  countEvent(now: number): void {
    const day = localDay(now, this.state.timeZone);
    const counts = this.state.eventsByDay;
    counts[day] = (counts[day] ?? 0) + 1;
    const days = Object.keys(counts).sort();
    for (const d of days.slice(0, Math.max(0, days.length - KEEP_EVENT_DAYS))) delete counts[d];
    if (now - this.countWrittenAt < COUNT_WRITE_MS) return;
    this.countWrittenAt = now;
    this.write();
  }

  /** The seven days before `now`. */
  week(now: number): CoachWeek {
    const since = now - 7 * 24 * 60 * 60_000;
    const moments = this.state.moments.filter((m) => m.at >= since);
    const count = (s: CoachMoment['state']) => moments.filter((m) => m.state === s).length;
    return {
      moments: moments.length,
      thanks: count('thanks'),
      notNow: count('not-now'),
      notThis: count('not-this'),
      unanswered: count('moved-on'),
      eventsToday: this.state.eventsByDay[localDay(now, this.state.timeZone)] ?? 0,
    };
  }

  /** Write anything held back, such as the day's event count. */
  flush(): void {
    this.write();
  }

  private write(): void {
    writeJsonFile(this.path, this.state);
  }
}
