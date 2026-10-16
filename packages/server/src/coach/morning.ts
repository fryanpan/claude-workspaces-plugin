/**
 * The coach session's one morning wake-up a day.
 *
 * The feed (`coach/session-feed.ts`) hears only what the owner does, so the
 * coach cannot notice something that is not moving. Once each local day, at
 * `MORNING_HOUR` in his zone, the session gets one `coach.morning` frame
 * naming the day, and the `coaching` skill checks this week's nudges on it.
 *
 * - It goes through the feed like any event: it is one turn of the
 *   `DAILY_EVENT_LIMIT` budget, and it is dropped once the day's budget is
 *   spent.
 * - It is never sent twice for one local day. The day is written to the
 *   coach's state file the moment it comes, so a restart that day, a timer
 *   that fires early, or a zone that moved west cannot bring it back.
 * - With no coach session listening it is not held for later; the next
 *   morning sends the next one.
 * - It names no board, so there is nothing for `coach/exclusion.ts` to
 *   exclude; the digests the session reads beside it still honour it.
 *
 * No polling: one timer, set to the next morning instant and set again
 * after it fires and on every boot. The clock and the timer are injected so
 * a test moves time by hand.
 */
import { instantForLocal, zonedParts } from '@claude-workspaces/core/schedule-timezone';
import { localDay } from './clock.ts';
import { MORNING_HOUR } from './types.ts';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** What the session is told: which morning it is. */
export interface MorningNews {
  event: 'coach.morning';
  /** His local day, `YYYY-MM-DD`. */
  day: string;
  weekday: string;
}

/** The first morning instant strictly after `after`, in `timeZone`. */
export function nextMorning(after: number, timeZone: string, hour = MORNING_HOUR): number {
  const p = zonedParts(after, timeZone);
  for (let ahead = 0; ahead < 3; ahead += 1) {
    // Date.UTC rolls a day past the month's end into the next month.
    const d = new Date(Date.UTC(p.year, p.month - 1, p.day + ahead));
    const t = instantForLocal(
      timeZone,
      d.getUTCFullYear(),
      d.getUTCMonth() + 1,
      d.getUTCDate(),
      hour,
      0,
    );
    if (t > after) return t;
  }
  throw new Error(`no morning after ${after} in ${timeZone}`);
}

/** `Monday` for `2026-10-12`. */
export function weekdayOf(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return WEEKDAYS[new Date(Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1)).getUTCDay()] ?? '';
}

export interface MorningDeps {
  /** The owner's zone, read at each arming and each firing. */
  timeZone: () => string;
  /** The last local day the morning came (`CoachStore.morningDay`). */
  lastDay: () => string | undefined;
  setLastDay: (day: string) => void;
  /** Hands the frame to the feed; true when a session took it. */
  wake: (news: MorningNews, at: number) => boolean;
  /** Defaults to `MORNING_HOUR`. */
  hour?: number;
  now?: () => number;
  /** Runs `fn` after `ms`; answers a cancel. Defaults to an unref'd timer. */
  schedule?: (fn: () => void, ms: number) => () => void;
}

const timer = (fn: () => void, ms: number): (() => void) => {
  const t = setTimeout(fn, ms);
  t.unref?.();
  return () => clearTimeout(t);
};

export class MorningWake {
  private cancel: (() => void) | null = null;

  constructor(private readonly deps: MorningDeps) {}

  /** Sets the timer for the next morning. Called at boot. */
  start(): void {
    this.arm();
  }

  stop(): void {
    this.cancel?.();
    this.cancel = null;
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private arm(): void {
    this.cancel?.();
    const t = this.now();
    const due = nextMorning(t, this.deps.timeZone(), this.deps.hour ?? MORNING_HOUR);
    this.cancel = (this.deps.schedule ?? timer)(() => this.fire(), due - t);
  }

  private fire(): void {
    this.cancel = null;
    const t = this.now();
    const day = localDay(t, this.deps.timeZone());
    if (this.deps.lastDay() !== day) {
      // Written before it is sent: a morning the session missed, or the
      // budget dropped, is not tried again that day.
      this.deps.setLastDay(day);
      this.deps.wake({ event: 'coach.morning', day, weekday: weekdayOf(day) }, t);
    }
    this.arm();
  }
}
