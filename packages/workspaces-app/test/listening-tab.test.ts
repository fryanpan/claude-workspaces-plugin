/**
 * Which of the reader's tabs hears them (`listening-tab.ts`): the tab they
 * are on, or were on last, among those with listening on. Each tab here has
 * its own event targets and they share one storage, which tells the others
 * when it is written, as a browser's `storage` event does.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  LISTENING_TABS_KEY,
  type ListeningTab,
  STALE_MS,
  createListeningTab,
} from '../src/lead-chat/listening-tab.ts';

class Doc extends EventTarget {
  visibilityState: DocumentVisibilityState = 'visible';
}

function origin() {
  const items = new Map<string, string>();
  const wins: EventTarget[] = [];
  let clock = 1_000;
  const storageFor = (me: EventTarget) => ({
    getItem: (k: string) => items.get(k) ?? null,
    setItem: (k: string, v: string) => {
      items.set(k, v);
      for (const w of wins)
        if (w !== me) w.dispatchEvent(Object.assign(new Event('storage'), { key: k }));
    },
  });
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
      now: () => clock,
      onChange: (h) => heard.push(h),
    });
    made.push(tab);
    return { tab, win, doc, heard };
  };
  return {
    items,
    open,
    made,
    tick: (ms = 1) => {
      clock += ms;
    },
  };
}

let tabs: ListeningTab[] = [];
afterEach(() => {
  for (const t of tabs) t.destroy();
  tabs = [];
});

function twoTabs() {
  const o = origin();
  const a = o.open('a');
  o.tick();
  const b = o.open('b');
  tabs = o.made;
  return { o, a, b };
}

describe('which tab hears the reader', () => {
  it('is the tab listening went on in last, and the other pauses', () => {
    const { o, a, b } = twoTabs();
    a.tab.join();
    expect(a.tab.hears()).toBe(true);
    o.tick();
    b.tab.join();
    expect([a.tab.hears(), b.tab.hears()]).toEqual([false, true]);
    expect(a.heard).toEqual([false]);
  });

  it('moves to the tab the reader focuses, shows or taps in', () => {
    const { o, a, b } = twoTabs();
    a.tab.join();
    o.tick();
    b.tab.join();
    o.tick();
    a.win.dispatchEvent(new Event('focus'));
    expect([a.tab.hears(), b.tab.hears()]).toEqual([true, false]);
    o.tick();
    b.doc.dispatchEvent(new Event('visibilitychange'));
    expect([a.tab.hears(), b.tab.hears()]).toEqual([false, true]);
    o.tick();
    a.doc.dispatchEvent(new Event('pointerdown'));
    expect([a.tab.hears(), b.tab.hears()]).toEqual([true, false]);
  });

  it('stays with the last tab the reader was on when they leave for another', () => {
    const { o, a, b } = twoTabs();
    a.tab.join();
    o.tick();
    b.tab.join();
    // B goes to the background: hidden, blurred. Nothing claims.
    b.doc.visibilityState = 'hidden';
    b.doc.dispatchEvent(new Event('visibilitychange'));
    b.win.dispatchEvent(new Event('blur'));
    expect([a.tab.hears(), b.tab.hears()]).toEqual([false, true]);
  });

  it('is not moved by a tab with listening off', () => {
    const { o, a, b } = twoTabs();
    a.tab.join();
    o.tick();
    b.win.dispatchEvent(new Event('focus'));
    expect(a.tab.hears()).toBe(true);
    expect(JSON.parse(o.items.get(LISTENING_TABS_KEY) ?? '{}')).not.toHaveProperty('b');
  });

  it('goes back to the other tab when listening goes off, or the tab unloads', () => {
    const { o, a, b } = twoTabs();
    a.tab.join();
    o.tick();
    b.tab.join();
    b.tab.leave();
    expect(a.tab.hears()).toBe(true);
    o.tick();
    b.tab.join();
    expect(a.tab.hears()).toBe(false);
    b.win.dispatchEvent(new Event('pagehide'));
    expect(a.tab.hears()).toBe(true);
  });

  it('ignores a tab that stopped saying it is there', () => {
    const { o, a, b } = twoTabs();
    a.tab.join();
    o.tick();
    b.tab.join();
    expect(a.tab.hears()).toBe(false);
    // B died without unloading; A's next look finds its line too old.
    o.tick(STALE_MS + 1);
    a.win.dispatchEvent(Object.assign(new Event('storage'), { key: LISTENING_TABS_KEY }));
    expect(a.tab.hears()).toBe(true);
  });

  it('lets every tab hear when there is no storage', () => {
    const heard: boolean[] = [];
    const tab = createListeningTab({
      storage: null,
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
