import { describe, expect, it, vi } from 'vitest';
import {
  type FollowPlace,
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

const hrefOf = (p: FollowPlace<Spot>) => `/${p.roomId}/${p.spot.page}`;

/** A browser tab: an address, a view, its own session storage and its own
 *  presence connection. By default a navigation is a reload: a fresh follow
 *  tab on the same storage, as a new page would make. With `inPlace`, the
 *  address changes only when the test calls `finish()`. */
function tab(
  conn: PresenceConnection<Spot>,
  opts: { storage?: MemoryStorage; roomId?: string; inPlace?: boolean } = {},
) {
  const storage = opts.storage ?? new MemoryStorage();
  const state = {
    place: {
      roomId: opts.roomId ?? 'harborlight',
      spot: { page: 'notes', scroll: 0 },
    } as FollowPlace<Spot>,
    gone: [] as string[],
    inFlight: null as string | null,
  };
  const make = () =>
    createFollowTab<Spot>({
      slot: 'follow',
      storage,
      address: () => hrefOf(state.place),
      here: () => state.place,
      pageOf,
      hrefOf,
      samePlace: (a, b) => a.page === b.page && a.scroll === b.scroll,
      go: (href) => {
        state.gone.push(href);
        if (opts.inPlace) {
          state.inFlight = href;
          return;
        }
        arrive(href);
        api.follow = make();
      },
      show: (s) => {
        state.place = { ...state.place, spot: { ...s } };
      },
      send: (id) => conn.follow(id),
    });
  const arrive = (href: string) => {
    const [, roomId = '', page = ''] = href.split('/');
    state.place = { roomId, spot: { page, scroll: 0 } };
  };
  const api = {
    state,
    follow: make(),
    finish: () => {
      if (state.inFlight) arrive(state.inFlight);
      state.inFlight = null;
      api.follow.arrived();
    },
  };
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
  const join = (id: string, roomId = 'harborlight') => {
    const r = h.join({ roomId, principal: { id } });
    if (!r.ok) throw new Error(r.error);
    return r.connection;
  };
  return { join };
}

const leaderOf = (c: PresenceConnection<Spot>) => c.view().leader;

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
      a.follow.leaderAt(leaderOf(connA));
      b.follow.leaderAt(leaderOf(connB));
    };
    a.follow.follow('alice');

    move({ page: 'notes', scroll: 0.3 });
    expect(a.state.place.spot).toEqual({ page: 'notes', scroll: 0.3 });

    move({ page: 'tasks', scroll: 0 });
    expect(a.state.gone).toEqual(['/harborlight/tasks']);
    expect(a.follow.leader()).toBe('alice'); // the page it loaded carries on

    move({ page: 'tasks', scroll: 0.8 });
    expect(a.state.place.spot).toEqual({ page: 'tasks', scroll: 0.8 });

    // The reader's other tab never moved.
    expect(b.state.place.spot).toEqual({ page: 'notes', scroll: 0 });
    expect(b.state.gone).toEqual([]);
  });

  it('follows the leader to their board, the one the server named, not the same page name here', () => {
    const { join } = setup();
    const leader = join('alice', 'riverbend');
    const follower = join('saltmarsh', 'riverbend');
    const t = tab(follower, { roomId: 'riverbend' });
    t.state.place = { roomId: 'harborlight', spot: { page: 'notes', scroll: 0 } };
    t.follow.follow('alice');
    leader.update({ page: 'notes', scroll: 0.4 });
    t.follow.leaderAt(leaderOf(follower));
    expect(t.state.gone).toEqual(['/riverbend/notes']);
  });

  it('applies the newest place the leader reached while an in-place navigation was on the way', () => {
    const { join } = setup();
    const leader = join('alice');
    const conn = join('bob');
    const t = tab(conn, { inPlace: true });
    t.follow.follow('alice');
    leader.update({ page: 'tasks', scroll: 0 });
    t.follow.leaderAt(leaderOf(conn));
    leader.update({ page: 'tasks', scroll: 0.6 });
    t.follow.leaderAt(leaderOf(conn)); // still on the way: held
    expect(t.state.place.spot.page).toBe('notes');
    t.finish();
    expect(t.state.place.spot).toEqual({ page: 'tasks', scroll: 0.6 });
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
    a.follow.leaderAt({ roomId: 'harborlight', spot: { page: 'tasks', scroll: 0.5 } });
    expect(a.state.gone).toEqual([]);
  });

  it('ends when a page loads that the follow did not send the tab to', () => {
    const { join } = setup();
    const storage = new MemoryStorage();
    storage.setItem('follow', JSON.stringify({ leader: 'alice', arriving: '/harborlight/tasks' }));
    const a = tab(join('bob'), { storage });
    expect(a.follow.leader()).toBeNull();
    expect(storage.getItem('follow')).toBeNull();
  });
});
