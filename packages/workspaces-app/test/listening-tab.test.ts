/**
 * Which of the reader's tabs hears them (`listening-tab.ts`): the tab they
 * are on, or were on last, among those with listening on. Each tab here has
 * its own event targets and they share one storage, which tells the others
 * when it is written, as a browser's `storage` event does. The clock and the
 * timers are vitest's fakes, so a heartbeat and a lapse run as they would.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GRACE_MS,
  LISTENING_TAB_PREFIX,
  type ListeningTab,
  SEEN_MS,
  STALE_MS,
  createListeningTab,
} from '../src/lead-chat/listening-tab.ts';

class Doc extends EventTarget {
  visibilityState: DocumentVisibilityState = 'visible';
}

function origin() {
  const items = new Map<string, string>();
  const wins: EventTarget[] = [];
  const dead = new Set<EventTarget>();
  /** Every key each tab wrote or removed, by the tab's window. */
  const touched = new Map<EventTarget, Set<string>>();
  const touch = (me: EventTarget, k: string): void => {
    touched.set(me, (touched.get(me) ?? new Set()).add(k));
  };
  const storageFor = (me: EventTarget) => {
    const tell = (key: string): void => {
      for (const w of wins)
        if (w !== me) w.dispatchEvent(Object.assign(new Event('storage'), { key }));
    };
    return {
      get length() {
        return items.size;
      },
      key: (i: number) => [...items.keys()][i] ?? null,
      getItem: (k: string) => items.get(k) ?? null,
      setItem: (k: string, v: string) => {
        if (dead.has(me)) return;
        touch(me, k);
        items.set(k, v);
        tell(k);
      },
      removeItem: (k: string) => {
        if (dead.has(me) || !items.delete(k)) return;
        tell(k);
      },
      clear: () => items.clear(),
    };
  };
  const made: ListeningTab[] = [];
  const open = (id: string) => {
    const win = new EventTarget();
    const doc = new Doc();
    wins.push(win);
    const heard: boolean[] = [];
    const tab = createListeningTab({
      id,
      win: win as unknown as Window,
      doc: doc as unknown as Document,
      storage: storageFor(win),
      now: Date.now,
      onChange: (h) => heard.push(h),
    });
    made.push(tab);
    /** The tab stops running without unloading: it writes nothing more. */
    const die = (): void => {
      dead.add(win);
    };
    return { tab, win, doc, heard, die };
  };
  return { items, open, made, touched };
}

let tabs: ListeningTab[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});
afterEach(() => {
  for (const t of tabs) t.destroy();
  tabs = [];
  vi.useRealTimers();
});

const tick = (ms = 1): void => {
  vi.advanceTimersByTime(ms);
};

function twoTabs() {
  const o = origin();
  const a = o.open('a');
  const b = o.open('b');
  tabs = o.made;
  return { o, a, b };
}

describe('which tab hears the reader', () => {
  it('is the tab listening went on in last, and the other pauses', () => {
    const { a, b } = twoTabs();
    a.tab.join();
    expect(a.tab.hears()).toBe(true);
    tick();
    b.tab.join();
    expect([a.tab.hears(), b.tab.hears()]).toEqual([false, true]);
    expect(a.heard).toEqual([false]);
  });

  it('moves to the tab the reader focuses or shows', () => {
    const { a, b } = twoTabs();
    a.tab.join();
    tick();
    b.tab.join();
    tick();
    a.win.dispatchEvent(new Event('focus'));
    expect([a.tab.hears(), b.tab.hears()]).toEqual([true, false]);
    tick();
    b.doc.dispatchEvent(new Event('visibilitychange'));
    expect([a.tab.hears(), b.tab.hears()]).toEqual([false, true]);
  });

  it('is not moved by a tap, so tapping off in a paused tab leaves the other alone', () => {
    const { a, b } = twoTabs();
    a.tab.join();
    tick();
    b.tab.join();
    tick();
    a.doc.dispatchEvent(new Event('pointerdown'));
    expect([a.tab.hears(), b.tab.hears()]).toEqual([false, true]);
    expect(b.heard).toEqual([]);
  });

  it('stays with the last tab the reader was on when they leave for another', () => {
    const { a, b } = twoTabs();
    a.tab.join();
    tick();
    b.tab.join();
    b.doc.visibilityState = 'hidden';
    b.doc.dispatchEvent(new Event('visibilitychange'));
    b.win.dispatchEvent(new Event('blur'));
    expect([a.tab.hears(), b.tab.hears()]).toEqual([false, true]);
  });

  it('is not taken by a tab that turns listening on while hidden, as a background reload does', () => {
    const { a, b } = twoTabs();
    a.tab.join();
    tick();
    b.doc.visibilityState = 'hidden';
    b.tab.join();
    expect([a.tab.hears(), b.tab.hears()]).toEqual([true, false]);
    // A hidden tab alone with listening on still hears.
    a.tab.leave();
    expect(b.tab.hears()).toBe(true);
  });

  it('is not moved by a tab with listening off', () => {
    const { o, a, b } = twoTabs();
    a.tab.join();
    tick();
    b.win.dispatchEvent(new Event('focus'));
    expect(a.tab.hears()).toBe(true);
    expect(o.items.has(`${LISTENING_TAB_PREFIX}b`)).toBe(false);
  });

  it('keeps a claim that another tab heartbeats over, since each tab writes only its own line', () => {
    const { a, b } = twoTabs();
    b.tab.join();
    tick();
    a.tab.join();
    expect(a.tab.hears()).toBe(true);
    // B's heartbeat fires after A's claim.
    tick(SEEN_MS);
    expect([a.tab.hears(), b.tab.hears()]).toEqual([true, false]);
  });

  it('writes only its own line, so no tab can write back over another tab’s claim', () => {
    const { o, a, b } = twoTabs();
    a.tab.join();
    tick();
    b.tab.join();
    tick(SEEN_MS);
    a.win.dispatchEvent(new Event('focus'));
    expect([...(o.touched.get(a.win) ?? [])]).toEqual([`${LISTENING_TAB_PREFIX}a`]);
    expect([...(o.touched.get(b.win) ?? [])]).toEqual([`${LISTENING_TAB_PREFIX}b`]);
  });

  it('goes back to the other tab when listening goes off', () => {
    const { a, b } = twoTabs();
    a.tab.join();
    tick();
    b.tab.join();
    b.tab.leave();
    expect(a.tab.hears()).toBe(true);
  });

  it('hands over once a closed tab’s line lapses, and not during a page move in it', () => {
    const { o, a, b } = twoTabs();
    a.tab.join();
    tick();
    b.tab.join();
    // B's page unloads; the next page in the same tab takes its line back.
    b.win.dispatchEvent(new Event('pagehide'));
    b.tab.destroy();
    tick(GRACE_MS / 2);
    const next = o.open('b');
    tabs = o.made;
    next.tab.join();
    tick(GRACE_MS);
    expect([a.tab.hears(), next.tab.hears()]).toEqual([false, true]);
    expect(a.heard).toEqual([false]);
    // Now the tab closes for good: A hears once the line lapses.
    next.win.dispatchEvent(new Event('pagehide'));
    next.tab.destroy();
    tick(GRACE_MS - 1);
    expect(a.tab.hears()).toBe(false);
    tick(1);
    expect(a.tab.hears()).toBe(true);
  });

  it('keeps hearing past the stale window while its heartbeat runs', () => {
    const { a, b } = twoTabs();
    a.tab.join();
    tick();
    b.tab.join();
    tick(STALE_MS * 2);
    expect([a.tab.hears(), b.tab.hears()]).toEqual([false, true]);
  });

  it('hands over from a tab that died without unloading once its line goes stale', () => {
    const { a, b } = twoTabs();
    a.tab.join();
    tick();
    b.tab.join();
    b.die();
    tick(STALE_MS - SEEN_MS);
    expect(a.tab.hears()).toBe(false);
    tick(SEEN_MS);
    expect(a.tab.hears()).toBe(true);
  });

  it('lets every tab hear when there is no storage', () => {
    const heard: boolean[] = [];
    const tab = createListeningTab({
      storage: null,
      id: 'solo',
      win: new EventTarget() as unknown as Window,
      doc: new Doc() as unknown as Document,
      onChange: (h) => heard.push(h),
    });
    tabs = [tab];
    tab.join();
    expect(tab.hears()).toBe(true);
    expect(heard).toEqual([]);
  });
});
