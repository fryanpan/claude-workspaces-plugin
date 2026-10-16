/**
 * The coach session's morning wake-up: one `coach.morning` frame per local
 * day at 08:00 his time, spent from the same daily budget as a digest,
 * dropped when that budget is spent or no session is listening, and never
 * sent twice for one day, across a restart included. Driven through
 * `wireCoach` with a fixed clock and a timer the test moves by hand.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { instantForLocal } from '@claude-workspaces/core/schedule-timezone';
import { nextMorning, weekdayOf } from '../src/coach/morning.ts';
import type { SessionFrame } from '../src/coach/session-feed.ts';
import { CoachStore } from '../src/coach/store.ts';
import { DAILY_EVENT_LIMIT } from '../src/coach/types.ts';
import { type CoachWiringDeps, wireCoach } from '../src/coach/wiring.ts';
import { GOALS_DOC, ZONE } from './coach-fixtures.ts';

/** October 2026, his time. The 12th is a Monday. */
const local = (day: number, hour: number, minute = 0, zone = ZONE) =>
  instantForLocal(zone, 2026, 10, day, hour, minute);

/** A clock and a timer the test moves by hand. `early` makes the next
 *  timer fire that many ms before it is due, once, as a real one may. */
function fakeTime(start: number) {
  let now = start;
  let early = 0;
  const timers: { due: number; fn: () => void; live: boolean }[] = [];
  return {
    now: () => now,
    schedule: (fn: () => void, ms: number) => {
      const t = { due: now + ms - early, fn, live: true };
      early = 0;
      timers.push(t);
      return () => {
        t.live = false;
      };
    },
    fireEarlyBy(ms: number) {
      early = ms;
    },
    to(end: number) {
      for (;;) {
        const next = timers.filter((t) => t.live && t.due <= end).sort((a, b) => a.due - b.due)[0];
        if (!next) break;
        now = next.due;
        next.live = false;
        next.fn();
      }
      now = end;
    },
    pending: () => timers.filter((t) => t.live).length,
  };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'coach-morning-'));
  // The coach was set up before this boot: his zone and the Coach board.
  const before = new CoachStore(dir, local(11, 12));
  before.noteTimeZone(ZONE);
  before.setGoalsDoc({ workspaceId: 'w-coach', docId: 'd-goals', createdAt: local(11, 12) });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** One boot of the server's coach, sending to the Coach board's lead. */
function boot(time: ReturnType<typeof fakeTime>, connected: () => boolean = () => true) {
  const sent: SessionFrame[] = [];
  const deps: CoachWiringDeps = {
    dataDir: dir,
    docStore: {
      prewarmHydration: async () => undefined,
      createForCaller: (docId) => ({ ok: true, doc: { docId } }),
      attachFileAsync: async () => ({ ok: true }),
      docExists: () => true,
      readMarkdownBody: () => GOALS_DOC,
    },
    createBoard: () => 'w-coach',
    fileUnderBoard: () => {},
    label: () => ({}),
    boardName: () => undefined,
    workspaceOf: () => 'w-coach',
    privacy: {
      localOnlyBoard: () => false,
      localOnlyDoc: () => false,
      locked: () => false,
      shared: () => false,
      boardsOfDoc: () => [],
    },
    leadOf: () => 'agent-coach',
    sendToAgent: (_ws, _agent, frame) => {
      sent.push(frame);
      return 1;
    },
    agentConnected: connected,
    planBoard: () => undefined,
    now: time.now,
    schedule: () => () => {},
    morningSchedule: time.schedule,
  };
  const w = wireCoach(deps);
  const mornings = () => sent.filter((f) => f.event === 'coach.morning');
  return { w, sent, mornings };
}

describe('nextMorning', () => {
  it('is today at 08:00 before it, tomorrow from it on, across a month end', () => {
    expect(nextMorning(local(12, 7, 59), ZONE)).toBe(local(12, 8));
    expect(nextMorning(local(12, 8), ZONE)).toBe(local(13, 8));
    expect(nextMorning(instantForLocal(ZONE, 2026, 10, 31, 9, 0), ZONE)).toBe(
      instantForLocal(ZONE, 2026, 11, 1, 8, 0),
    );
    expect(weekdayOf('2026-10-12')).toBe('Monday');
  });
});

describe('the morning wake-up', () => {
  it('sends exactly one per local day, at 08:00 his time, over three days', () => {
    const time = fakeTime(local(11, 20));
    const { w, mornings } = boot(time);
    time.to(local(14, 20));
    expect(mornings().map((f) => f.at)).toEqual([local(12, 8), local(13, 8), local(14, 8)]);
    expect(mornings().map((f) => f.event === 'coach.morning' && f.weekday)).toEqual([
      'Monday',
      'Tuesday',
      'Wednesday',
    ]);
    expect(time.pending()).toBe(1);
    w.stop();
    expect(time.pending()).toBe(0);
  });

  it('carries the day and its weekday, addressed on the Coach board, and spends one turn', () => {
    const time = fakeTime(local(11, 20));
    const { w, mornings } = boot(time);
    time.to(local(12, 9));
    expect(mornings()).toEqual([
      {
        event: 'coach.morning',
        day: '2026-10-12',
        weekday: 'Monday',
        workspaceId: 'w-coach',
        at: local(12, 8),
      },
    ]);
    expect(w.store.eventsOn(local(12, 9))).toBe(1);
    w.stop();
  });

  it('is dropped when the day’s budget is spent, and comes again the next day', () => {
    const time = fakeTime(local(11, 20));
    const { w, mornings } = boot(time);
    for (let i = 0; i < DAILY_EVENT_LIMIT; i += 1) w.store.countEvent(local(12, 0, 30));
    time.to(local(12, 20));
    expect(mornings()).toEqual([]);
    time.to(local(13, 9));
    expect(mornings().map((f) => f.at)).toEqual([local(13, 8)]);
    w.stop();
  });

  it('is not held for a session that is not there: the next morning sends the next one', () => {
    const time = fakeTime(local(11, 20));
    let connected = false;
    const { w, mornings } = boot(time, () => connected);
    time.to(local(12, 9));
    connected = true;
    time.to(local(12, 23));
    expect(mornings()).toEqual([]);
    time.to(local(13, 9));
    expect(mornings().map((f) => f.at)).toEqual([local(13, 8)]);
    w.stop();
  });

  it('is not sent again after a restart the same day', () => {
    const time = fakeTime(local(11, 20));
    const first = boot(time);
    time.to(local(12, 8));
    expect(first.mornings()).toHaveLength(1);
    first.w.stop();
    const second = boot(time);
    time.to(local(12, 23));
    expect(second.mornings()).toEqual([]);
    time.to(local(13, 9));
    expect(second.mornings().map((f) => f.at)).toEqual([local(13, 8)]);
    second.w.stop();
  });

  it('is not sent again the same day when he moves west and the server restarts', () => {
    const time = fakeTime(local(11, 20));
    const first = boot(time);
    time.to(local(12, 8));
    first.w.stop();
    // Honolulu's 08:00 Monday is three hours after his 08:00 Monday.
    first.w.store.noteTimeZone('Pacific/Honolulu');
    const second = boot(time);
    time.to(local(12, 23));
    expect(second.mornings()).toEqual([]);
    expect(second.w.store.morningDay).toBe('2026-10-12');
    second.w.stop();
  });

  it('sends one when the timer fires a moment early', () => {
    const time = fakeTime(local(11, 20));
    time.fireEarlyBy(1);
    const { w, mornings } = boot(time);
    time.to(local(12, 9));
    expect(mornings()).toHaveLength(1);
    w.stop();
  });
});
