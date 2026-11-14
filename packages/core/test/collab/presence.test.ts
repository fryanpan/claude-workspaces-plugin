import { describe, expect, it } from 'vitest';
import { type PresenceOptions, createPresenceHub } from '../../src/collab/index.ts';
import { ROLES, type Spot, pageOf, parseSpot } from './presence-fixture.ts';

function hub(over: Partial<PresenceOptions<Spot>> = {}) {
  let t = 1_000;
  const h = createPresenceHub<Spot>({
    role: ROLES,
    parseSpot,
    pageOf,
    hasPresence: (page) => page !== 'private',
    appWide: true,
    now: () => t,
    ...over,
  });
  const join = (id: string, roomId: string) => {
    const res = h.join({ roomId, principal: { id, name: id[0]?.toUpperCase() + id.slice(1) } });
    if (!res.ok) throw new Error(res.error);
    return res.connection;
  };
  return { h, join, tick: (ms: number) => (t += ms) };
}

const ids = (people: { id: string }[]) => people.map((p) => p.id);

describe('createPresenceHub', () => {
  it('refuses to build without a role function', () => {
    expect(() =>
      createPresenceHub({ parseSpot, pageOf, hasPresence: () => true, appWide: true } as never),
    ).toThrow(/role function/);
  });

  it('refuses a connection the role function gives no role', () => {
    const { h } = hub();
    expect(h.join({ roomId: 'riverbend', principal: { id: 'bob' } })).toEqual({
      ok: false,
      error: 'no-role',
    });
  });
});

describe('who a page shows', () => {
  it('shows who is on the page, and who is elsewhere only on boards the viewer shares', () => {
    const { join, tick } = hub();
    const alice = join('alice', 'harborlight');
    const bob = join('bob', 'harborlight');
    const salt = join('saltmarsh', 'riverbend');
    alice.update({ page: 'notes' });
    tick(1);
    bob.update({ page: 'notes' });
    tick(1);
    salt.update({ page: 'plan' });

    expect(ids(alice.view().here)).toEqual(['bob']);
    expect(ids(alice.view().elsewhere)).toEqual(['saltmarsh']);
    // Bob has no role on Riverbend, so Saltmarsh is hidden from him.
    expect(ids(bob.view().here)).toEqual(['alice']);
    expect(ids(bob.view().elsewhere)).toEqual([]);
    // Saltmarsh has no role on Harborlight.
    expect(ids(salt.view().elsewhere)).toEqual([]);
  });

  it('shows only the page when the app turns app-wide presence off', () => {
    const { join } = hub({ appWide: false });
    const alice = join('alice', 'harborlight');
    const bob = join('bob', 'harborlight');
    alice.update({ page: 'notes' });
    bob.update({ page: 'tasks' });
    expect(alice.view()).toMatchObject({ here: [], elsewhere: [] });
    bob.update({ page: 'notes' });
    expect(ids(alice.view().here)).toEqual(['bob']);
  });

  it('shows nobody on a page without presence, and nobody sees who is on one', () => {
    const { join } = hub();
    const alice = join('alice', 'harborlight');
    const bob = join('bob', 'harborlight');
    alice.update({ page: 'private' });
    bob.update({ page: 'notes' });
    expect(alice.view()).toMatchObject({ here: [], elsewhere: [] });
    expect(bob.view()).toMatchObject({ here: [], elsewhere: [] });
  });

  it('takes identity and board from the connection, never from what the page sends', () => {
    const { join } = hub();
    const alice = join('alice', 'harborlight');
    const bob = join('bob', 'harborlight');
    alice.update({ page: 'notes' });
    bob.update({
      page: 'notes',
      user: { id: 'saltmarsh', name: 'Saltmarsh' },
      roomId: 'riverbend',
      board: 'riverbend',
    });
    expect(alice.view().here).toEqual([
      expect.objectContaining({ id: 'bob', name: 'Bob', roomId: 'harborlight' }),
    ]);
  });

  it('shows a person once, at their most recently active tab', () => {
    const { join, tick } = hub();
    const alice = join('alice', 'harborlight');
    const bob1 = join('bob', 'harborlight');
    const bob2 = join('bob', 'harborlight');
    alice.update({ page: 'notes' });
    bob1.update({ page: 'notes' });
    tick(5);
    bob2.update({ page: 'tasks' });
    expect(alice.view().here).toEqual([]);
    expect(alice.view().elsewhere).toEqual([expect.objectContaining({ id: 'bob', page: 'tasks' })]);
    bob2.close();
    expect(ids(alice.view().here)).toEqual(['bob']);
  });
});

describe('boards the viewer cannot see', () => {
  it('neither hides nor shows a person through their tab on a hidden board', () => {
    const { join, tick } = hub({ appWide: false });
    const bob = join('bob', 'harborlight');
    const alice = join('alice', 'harborlight');
    const aliceAway = join('alice', 'riverbend');
    bob.update({ page: 'doc' });
    alice.update({ page: 'doc' });
    expect(ids(bob.view().here)).toEqual(['alice']);
    tick(10);
    aliceAway.update({ page: 'plan' });
    expect(ids(bob.view().here)).toEqual(['alice']);
  });

  it('does not wake a connection for a change on a board it cannot see', () => {
    let t = 0;
    const woke: string[] = [];
    const h = createPresenceHub<Spot>({
      role: ROLES,
      parseSpot,
      pageOf,
      hasPresence: () => true,
      appWide: true,
      now: () => ++t,
    });
    const join = (id: string, roomId: string) => {
      const r = h.join({ roomId, principal: { id }, onChange: () => woke.push(id) });
      if (!r.ok) throw new Error(r.error);
      return r.connection;
    };
    join('bob', 'harborlight');
    join('alice', 'harborlight');
    const salt = join('saltmarsh', 'riverbend');
    salt.update({ page: 'plan' });
    expect(woke).toEqual(['alice']);
  });
});

describe('a role taken away', () => {
  it('stops a viewer seeing or publishing, and hides a subject, from the next call', () => {
    let bobAllowed = true;
    const { join } = hub({
      role: (p, room) => (p.id === 'bob' && !bobAllowed ? null : ROLES(p, room)),
    });
    const alice = join('alice', 'harborlight');
    const bob = join('bob', 'harborlight');
    alice.update({ page: 'notes' });
    bob.update({ page: 'notes' });
    expect(ids(alice.view().here)).toEqual(['bob']);
    bobAllowed = false;
    expect(bob.update({ page: 'tasks' })).toBe('revoked');
    expect(bob.view()).toEqual({ here: [], elsewhere: [], leader: null });
    expect(alice.view().here).toEqual([]);
  });
});

describe('rate limit', () => {
  it('shares one budget across a person’s tabs, so more tabs do not raise it', () => {
    const { h, join } = hub({ rate: { burst: 3, perSecond: 1 } });
    const tabs = [
      join('bob', 'harborlight'),
      join('bob', 'harborlight'),
      join('bob', 'harborlight'),
    ];
    const results = tabs.flatMap((c) => [c.update({ page: 'a' }), c.update({ page: 'b' })]);
    expect(results.filter((r) => r === 'applied')).toHaveLength(3);
    expect(h.droppedCount()).toBe(3);
    tabs[0]?.close();
    expect(join('bob', 'harborlight').update({ page: 'c' })).toBe('rate-limited');
  });

  it('drops updates past the limit, counts them, and lets one through once earned back', () => {
    const { h, join, tick } = hub({ rate: { burst: 3, perSecond: 1 } });
    const alice = join('alice', 'harborlight');
    const bob = join('bob', 'harborlight');
    const results = [1, 2, 3, 4, 5].map((n) => bob.update({ page: `p${n}` }));
    expect(results).toEqual(['applied', 'applied', 'applied', 'rate-limited', 'rate-limited']);
    expect(h.droppedCount()).toBe(2);
    alice.update({ page: 'p3' });
    expect(ids(alice.view().here)).toEqual(['bob']);
    tick(1_000);
    expect(bob.update({ page: 'p9' })).toBe('applied');
    expect(bob.update({ page: 'p10' })).toBe('rate-limited');
    expect(alice.view().elsewhere).toEqual([expect.objectContaining({ id: 'bob', page: 'p9' })]);
  });
});

describe('leader', () => {
  it('refuses a follow of the viewer’s own id', () => {
    const { join } = hub();
    const bob1 = join('bob', 'harborlight');
    const bob2 = join('bob', 'harborlight');
    bob2.update({ page: 'notes' });
    bob1.follow('bob');
    expect(bob1.view().leader).toBeNull();
  });

  it('names where the followed person is, only while the viewer may see them', () => {
    const { join } = hub();
    const bob = join('bob', 'harborlight');
    const salt = join('saltmarsh', 'riverbend');
    const alice = join('alice', 'riverbend');
    salt.update({ page: 'plan', scroll: 0.4 });
    alice.update({ page: 'plan', scroll: 0.4 });
    bob.follow('alice');
    expect(bob.view().leader).toBeNull(); // Alice is on Riverbend, where Bob has no role
    bob.follow('saltmarsh');
    expect(bob.view().leader).toBeNull();
    const alice2 = join('alice', 'harborlight');
    alice2.update({ page: 'notes', scroll: 0.7 });
    bob.follow('alice');
    expect(bob.view().leader).toMatchObject({ id: 'alice', spot: { page: 'notes', scroll: 0.7 } });
  });
});
