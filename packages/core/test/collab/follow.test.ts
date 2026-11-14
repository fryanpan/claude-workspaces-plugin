import { describe, expect, it, vi } from 'vitest';
import {
  type FollowStorage,
  type PresenceConnection,
  createFollowTab,
  createPresenceHub,
} from '../../src/collab/index.ts';
import { ROLES, type Spot, pageOf, parseSpot } from './presence-fixture.ts';

class MemoryStorage implements FollowStorage {
  private m = new Map<string, string>();
  getItem(k: string) {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
}

/** A browser tab: an address, a view, its own session storage and its own
 *  presence connection. A navigation is a reload: a fresh follow tab on the
 *  same storage, as a new page would make. */
function tab(conn: PresenceConnection<Spot>, storage = new MemoryStorage()) {
  const state = { spot: { page: 'notes', scroll: 0 } as Spot, gone: [] as string[] };
  const make = () =>
    createFollowTab<Spot>({
      slot: 'follow',
      storage,
      address: () => `/${state.spot.page}`,
      here: () => state.spot,
      pageOf,
      hrefOf: (s) => `/${s.page}`,
      samePlace: (a, b) => a.page === b.page && a.scroll === b.scroll,
      go: (href) => {
        state.gone.push(href);
        state.spot = { page: href.slice(1), scroll: 0 };
        api.follow = make();
      },
      show: (s) => {
        state.spot = { ...s };
      },
      send: (id) => conn.follow(id),
    });
  const api = { state, follow: make(), storage };
  return api;
}

function setup() {
  const h = createPresenceHub<Spot>({
    role: ROLES,
    parseSpot,
    pageOf,
    hasPresence: () => true,
    appWide: true,
    rate: { burst: 1000, perSecond: 1000 },
  });
  const join = (id: string) => {
    const r = h.join({ roomId: 'harborlight', principal: { id } });
    if (!r.ok) throw new Error(r.error);
    return r.connection;
  };
  return { join };
}

describe('a one-tab follower', () => {
  it('stays on the leader’s page and scroll position; the reader’s other tab stays put', () => {
    const { join } = setup();
    const leader = join('alice');
    const connA = join('bob');
    const connB = join('bob');
    const a = tab(connA);
    const b = tab(connB);
    const move = (spot: Spot) => {
      leader.update(spot);
      for (const [t, c] of [
        [a, connA],
        [b, connB],
      ] as const) {
        t.follow.leaderAt(c.view().leader?.spot ?? null);
      }
    };
    a.follow.follow('alice');

    move({ page: 'notes', scroll: 0.3 });
    expect(a.state.spot).toEqual({ page: 'notes', scroll: 0.3 });

    move({ page: 'tasks', scroll: 0 });
    expect(a.state.gone).toEqual(['/tasks']);
    expect(a.follow.leader()).toBe('alice'); // the page it loaded carries on

    move({ page: 'tasks', scroll: 0.8 });
    expect(a.state.spot).toEqual({ page: 'tasks', scroll: 0.8 });

    // The reader's other tab never moved.
    expect(b.state).toEqual({ spot: { page: 'notes', scroll: 0 }, gone: [] });
  });

  it('ends when the reader moves on their own, and tells the server', () => {
    const { join } = setup();
    const leader = join('alice');
    const conn = join('bob');
    const follow = vi.spyOn(conn, 'follow');
    const a = tab(conn);
    a.follow.follow('alice');
    a.follow.readerMoved();
    expect(follow).toHaveBeenLastCalledWith(null);
    leader.update({ page: 'tasks', scroll: 0.5 });
    a.follow.leaderAt({ page: 'tasks', scroll: 0.5 });
    expect(a.state.gone).toEqual([]);
  });

  it('ends when a page loads that the follow did not send the tab to', () => {
    const { join } = setup();
    const storage = new MemoryStorage();
    storage.setItem('follow', JSON.stringify({ leader: 'alice', arriving: '/tasks' }));
    const a = tab(join('bob'), storage);
    expect(a.follow.leader()).toBeNull();
    expect(storage.getItem('follow')).toBeNull();
  });
});
