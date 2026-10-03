/**
 * The coach's calendar and its one file: the moments and their answers, the
 * day's event count, the weekly review offer, and that nothing saved is
 * ever lost.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localDay } from '../src/coach/clock.ts';
import { CoachStore } from '../src/coach/store.ts';
import { KEEP_EVENT_DAYS, REVIEW_AFTER_MS } from '../src/coach/types.ts';
import { ZONE, at } from './coach-fixtures.ts';

const moment = (when: number) => ({
  at: when,
  goalIndex: 0,
  goal: 'Do the hard work first',
  matched: 'more than twenty minutes on styling',
  observed: 'Half an hour on the hover mock',
  line: 'Hi, I’m noticing half an hour on hover states. Back to the post?',
});

let dir: string;
let store: CoachStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'coach-store-'));
  store = new CoachStore(dir, at(8));
  store.noteTimeZone(ZONE);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('the calendar', () => {
  it('names the local day in his zone, not UTC', () => {
    expect(localDay(at(23, 30), ZONE)).toBe('2026-10-07');
  });
});

describe('the moments', () => {
  it('stays open until answered or left, and takes an answer only once', () => {
    const m = store.addMoment(moment(at(9)));
    expect(store.openMoment()?.id).toBe(m.id);
    expect(store.answer(m.id, 'thanks', at(9, 6))).toBe(true);
    expect(store.answer(m.id, 'not-this', at(9, 7))).toBe(false);
    const left = store.addMoment(moment(at(11)));
    expect(store.answer(left.id, 'moved-on', at(23))).toBe(true);
    expect(store.openMoment()).toBeNull();
  });

  it('counts the week, and today’s events', () => {
    const a = store.addMoment(moment(at(9)));
    store.answer(a.id, 'not-this', at(9, 1));
    const b = store.addMoment(moment(at(11)));
    store.answer(b.id, 'moved-on', at(11, 30));
    store.addMoment(moment(at(12)));
    for (let i = 0; i < 5; i += 1) store.countEvent(at(12, i));
    expect(store.week(at(12, 10))).toEqual({
      moments: 3,
      thanks: 0,
      notNow: 0,
      notThis: 1,
      unanswered: 1,
      eventsToday: 5,
    });
  });

  it('keeps the event count for two weeks, and writes it on flush', () => {
    for (let d = 0; d < KEEP_EVENT_DAYS + 3; d += 1) store.countEvent(at(9) + d * 24 * 60 * 60_000);
    store.flush();
    const raw = JSON.parse(readFileSync(join(dir, 'coach', 'state.json'), 'utf8'));
    expect(Object.keys(raw.eventsByDay)).toHaveLength(KEEP_EVENT_DAYS);
  });
});

describe('the weekly review offer', () => {
  it('is due a week after the last change, and a week after “no update needed”', () => {
    expect(store.reviewDue(at(8))).toBe(false); // no doc yet
    store.setGoalsDoc({ workspaceId: 'w-coach', docId: 'd-goals', createdAt: at(8) });
    expect(store.reviewDue(at(8) + REVIEW_AFTER_MS - 1)).toBe(false);
    expect(store.reviewDue(at(8) + REVIEW_AFTER_MS)).toBe(true);
    store.declineReview(at(8) + REVIEW_AFTER_MS);
    expect(store.reviewDue(at(8) + REVIEW_AFTER_MS * 2 - 1)).toBe(false);
    store.noteGoalsChanged(at(8) + REVIEW_AFTER_MS * 2);
    expect(store.reviewDue(at(8) + REVIEW_AFTER_MS * 2 + 1)).toBe(false);
  });
});

describe('the file', () => {
  it('survives a restart, owner-only, and a bad setting falls back', () => {
    store.setReadiness('less');
    store.setMemoryDoc({ workspaceId: 'w-coach', docId: 'd-memory', createdAt: at(8) });
    store.addMoment(moment(at(9)));
    const path = join(dir, 'coach', 'state.json');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const again = new CoachStore(dir, at(10));
    expect(again.readiness).toBe('less');
    expect(again.memoryDoc?.docId).toBe('d-memory');
    expect(again.timeZone).toBe(ZONE);
    expect(again.moments()).toHaveLength(1);
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    writeFileSync(path, JSON.stringify({ ...raw, readiness: 'always', timeZone: 'Mars/Olympus' }));
    const fixed = new CoachStore(dir, at(10));
    expect(fixed.readiness).toBe('normal');
    expect(fixed.timeZone).not.toBe('Mars/Olympus');
  });

  it('moves a corrupt file aside and starts empty', () => {
    store.setReadiness('more');
    writeFileSync(join(dir, 'coach', 'state.json'), '{not json');
    const fresh = new CoachStore(dir, at(10));
    expect(fresh.readiness).toBe('normal');
    expect(fresh.moments()).toEqual([]);
  });
});
