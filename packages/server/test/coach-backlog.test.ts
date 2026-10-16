/**
 * What the coach session has not read waits on disk: closed windows in
 * order, bounded by count and age with the dropped ones counted, and the
 * open window kept so a restart closes it when it would have closed.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CoachBacklog,
  type HeldDigest,
  MAX_HELD_AGE_MS,
  MAX_HELD_DIGESTS,
} from '../src/coach/backlog.ts';
import { HeldWindow } from '../src/held-window.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'coach-backlog-unit-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const digest = (to: number): HeldDigest => ({ from: to - 1, to, items: [], turns: [] });

describe('CoachBacklog', () => {
  it('keeps closed windows across a restart, owner-only, until they are read', () => {
    const a = new CoachBacklog(dir, 0);
    a.add(digest(10), 10);
    a.add(digest(20), 20);
    expect(statSync(join(dir, 'coach', 'backlog.json')).mode & 0o777).toBe(0o600);
    const b = new CoachBacklog(dir, 30);
    const { digests, dropped } = b.waiting(30);
    expect(digests.map((d) => d.to)).toEqual([10, 20]);
    expect(dropped).toBe(0);
    b.add(digest(40), 40);
    b.delivered(digests);
    expect(new CoachBacklog(dir, 50).waiting(50).digests.map((d) => d.to)).toEqual([40]);
  });

  it('drops past the count and the age, and says how many it dropped until they are read', () => {
    const b = new CoachBacklog(dir, 0);
    for (let i = 1; i <= MAX_HELD_DIGESTS + 3; i += 1) b.add(digest(i), i);
    let w = b.waiting(MAX_HELD_DIGESTS + 3);
    expect(w.digests).toHaveLength(MAX_HELD_DIGESTS);
    expect(w.dropped).toBe(3);
    w = b.waiting(MAX_HELD_DIGESTS + 4 + MAX_HELD_AGE_MS);
    expect(w.digests).toHaveLength(0);
    expect(w.dropped).toBe(MAX_HELD_DIGESTS + 3);
    b.delivered(w.digests);
    expect(b.waiting(MAX_HELD_AGE_MS * 2).dropped).toBe(0);
  });

  it('keeps the open window, written at most every 30s unless forced', () => {
    const b = new CoachBacklog(dir, 0);
    b.noteWindow({ openedAt: 1, items: [{ turn: turnAt(1) }] }, 1);
    b.noteWindow({ openedAt: 1, items: [{ turn: turnAt(1) }, { turn: turnAt(2) }] }, 2);
    expect(new CoachBacklog(dir, 3).window?.items).toHaveLength(1);
    b.noteWindow(null, 3, true);
    expect(new CoachBacklog(dir, 4).window).toBeUndefined();
  });

  it('starts empty on a file it cannot read', () => {
    const b = new CoachBacklog(join(dir, 'missing'), 0);
    expect(b.waiting(0)).toEqual({ digests: [], dropped: 0 });
  });
});

const turnAt = (at: number) => ({
  kind: 'prompt' as const,
  at,
  boardId: 'w-harbor',
  session: 's',
  repo: 'harborlight',
  creditMs: 0,
});

describe('HeldWindow, kept across a restart', () => {
  function clock() {
    let now = 0;
    const timers: { due: number; fn: () => void; live: boolean }[] = [];
    return {
      now: () => now,
      schedule: (fn: () => void, ms: number) => {
        const t = { due: now + ms, fn, live: true };
        timers.push(t);
        return () => {
          t.live = false;
        };
      },
      advance(ms: number) {
        now += ms;
        for (const t of timers) {
          if (t.live && t.due <= now) {
            t.live = false;
            t.fn();
          }
        }
      },
    };
  }

  it('resumes a window to close when it would have, and closes now when asked', () => {
    const c = clock();
    const closed: [string[], number, number][] = [];
    const w = new HeldWindow<string>({
      windowMs: 100,
      close: (items, from, to) => closed.push([items, from, to]),
      now: c.now,
      schedule: c.schedule,
    });
    c.advance(40);
    w.resume(['a'], 0);
    expect(w.snapshot()).toEqual({ items: ['a'], openedAt: 0 });
    c.advance(59);
    expect(closed).toEqual([]);
    c.advance(1);
    expect(closed).toEqual([[['a'], 0, 100]]);
    expect(w.snapshot()).toBeNull();
    w.hold('b');
    w.closeNow();
    expect(closed[1]?.[0]).toEqual(['b']);
    w.closeNow();
    expect(closed).toHaveLength(2);
  });
});
