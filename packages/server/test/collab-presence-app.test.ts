/**
 * Presence and one-tab follow through the collab core, over real sockets,
 * in an app with no Workspaces imports (`collab-app/presence-app.ts`).
 */
import { afterEach, describe, expect, it } from 'bun:test';
import {
  type FollowStorage,
  type PresenceView,
  createFollowTab,
} from '@claude-workspaces/core/collab';
import { type AppSpot, startPresenceApp } from './collab-app/presence-app.ts';
import { waitFor } from './wait-for.ts';

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

function app(opts: { appWide: boolean; burst?: number }) {
  const a = startPresenceApp(opts);
  cleanup.push(a.stop);
  return a;
}

/** A page's presence socket, holding the newest view it was sent. */
async function page(url: string, person: string) {
  const ws = new WebSocket(url, { headers: { 'x-person': person } } as unknown as string[]);
  cleanup.push(() => ws.close());
  const state: { view: PresenceView<AppSpot> | null; views: number } = { view: null, views: 0 };
  const listeners: Array<() => void> = [];
  ws.addEventListener('message', (ev) => {
    state.view = (JSON.parse(String(ev.data)) as { view: PresenceView<AppSpot> }).view;
    state.views++;
    for (const l of listeners) l();
  });
  await new Promise<void>((r, j) => {
    ws.addEventListener('open', () => r());
    ws.addEventListener('error', () => j(new Error('socket failed')));
  });
  return {
    state,
    onView: (fn: () => void) => listeners.push(fn),
    at: (spot: AppSpot) => ws.send(JSON.stringify({ spot })),
    sendRaw: (body: unknown) => ws.send(JSON.stringify(body)),
    follow: (id: string | null) => ws.send(JSON.stringify({ follow: id })),
  };
}

const ids = (people: { id: string }[] | undefined) => (people ?? []).map((p) => p.id);

describe('presence through the core, over sockets', () => {
  it('shows who is on the page and who is elsewhere, only on boards the viewer shares', async () => {
    const a = app({ appWide: true });
    const alice = await page(a.url('harborlight'), 'alice');
    const bob = await page(a.url('harborlight'), 'bob');
    const salt = await page(a.url('riverbend'), 'saltmarsh');
    alice.at({ page: 'notes', scroll: 0 });
    bob.at({ page: 'notes', scroll: 0 });
    salt.at({ page: 'plan', scroll: 0 });
    await waitFor(
      () =>
        ids(alice.state.view?.here).join() === 'bob' &&
        ids(alice.state.view?.elsewhere).join() === 'saltmarsh',
      { describe: 'Alice to see Bob here and Saltmarsh elsewhere' },
    );
    await waitFor(() => ids(bob.state.view?.here).join() === 'alice', {
      describe: 'Bob to see Alice',
    });
    expect(ids(bob.state.view?.elsewhere)).toEqual([]);
    expect(ids(salt.state.view?.elsewhere)).toEqual([]);
  });

  it('shows only the page when app-wide presence is off', async () => {
    const a = app({ appWide: false });
    const alice = await page(a.url('harborlight'), 'alice');
    const bob = await page(a.url('harborlight'), 'bob');
    alice.at({ page: 'notes', scroll: 0 });
    bob.at({ page: 'tasks', scroll: 0 });
    bob.at({ page: 'notes', scroll: 0 });
    await waitFor(() => ids(alice.state.view?.here).join() === 'bob', { describe: 'Bob here' });
    bob.at({ page: 'tasks', scroll: 0 });
    await waitFor(() => alice.state.view?.here.length === 0, { describe: 'Bob gone from here' });
    expect(alice.state.view?.elsewhere).toEqual([]);
  });

  it('ignores a name or board the page sends', async () => {
    const a = app({ appWide: true });
    const alice = await page(a.url('harborlight'), 'alice');
    const bob = await page(a.url('harborlight'), 'bob');
    alice.at({ page: 'notes', scroll: 0 });
    bob.sendRaw({ spot: { page: 'notes' }, user: { id: 'saltmarsh' }, board: 'riverbend' });
    await waitFor(() => alice.state.view?.here.length === 1, { describe: 'one person here' });
    expect(alice.state.view?.here[0]).toMatchObject({ id: 'bob', roomId: 'harborlight' });
  });

  it('drops updates past the rate limit', async () => {
    const a = app({ appWide: true, burst: 3 });
    const alice = await page(a.url('harborlight'), 'alice');
    const bob = await page(a.url('harborlight'), 'bob');
    alice.at({ page: 'p3', scroll: 0 });
    for (const n of [1, 2, 3, 4, 5, 6]) bob.at({ page: `p${n}`, scroll: 0 });
    await waitFor(() => a.hub.droppedCount() === 3, { describe: 'three updates dropped' });
    // Bob's last applied update was his third: p3, beside Alice.
    await waitFor(() => ids(alice.state.view?.here).join() === 'bob', { describe: 'Bob on p3' });
    expect(alice.state.view?.elsewhere).toEqual([]);
  });
});

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

describe('one-tab follow through the core, over sockets', () => {
  it('keeps the following tab on the leader’s page and scroll; the other tab stays', async () => {
    const a = app({ appWide: true });
    const alice = await page(a.url('harborlight'), 'alice');
    const tabs = [await page(a.url('harborlight'), 'bob'), await page(a.url('harborlight'), 'bob')];
    const where = tabs.map(() => ({ page: 'notes', scroll: 0 }) as AppSpot);
    tabs.forEach((t, i) => {
      const f = createFollowTab<AppSpot>({
        slot: 'follow',
        storage: new MemoryStorage(),
        address: () => `/${where[i]?.page}`,
        here: () => where[i] as AppSpot,
        pageOf: (s) => s.page,
        hrefOf: (s) => `/${s.page}`,
        samePlace: (x, y) => x.page === y.page && x.scroll === y.scroll,
        go: (href) => {
          where[i] = { page: href.slice(1), scroll: 0 };
          t.at(where[i] as AppSpot);
        },
        show: (s) => {
          where[i] = { ...s };
          t.at(where[i] as AppSpot);
        },
        send: (id) => t.follow(id),
      });
      t.onView(() => f.leaderAt(t.state.view?.leader?.spot ?? null));
      t.at(where[i] as AppSpot);
      if (i === 0) f.follow('alice');
    });

    alice.at({ page: 'tasks', scroll: 0.25 });
    await waitFor(() => where[0]?.page === 'tasks' && where[0].scroll === 0.25, {
      describe: 'the following tab to reach Alice’s page and scroll',
    });
    alice.at({ page: 'tasks', scroll: 0.9 });
    await waitFor(() => where[0]?.scroll === 0.9, {
      describe: 'the following tab to scroll with Alice',
    });
    alice.at({ page: 'plan', scroll: 0.5 });
    await waitFor(() => where[0]?.page === 'plan' && where[0].scroll === 0.5, {
      describe: 'the following tab to follow Alice to another page',
    });
    expect(where[1]).toEqual({ page: 'notes', scroll: 0 });
  });
});
