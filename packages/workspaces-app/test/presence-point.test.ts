/**
 * A spot that names any page of the workspace: a board tab, a panel, a
 * thread, a mock, or a position in a doc (a phrase, a scroll fraction).
 *
 * The spot is read off presence, which any page may write, so what it may
 * send a follower to is checked here: a path on this board, or the review
 * queue and the workspaces list, and nothing else.
 */
import { type PresenceSpot, parseSpot } from '@claude-workspaces/core/workspace-presence';
import { describe, expect, it } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { carriedFollowBoard } from '../src/presence/carried-follow.ts';
import { spotHref, spotKey } from '../src/presence/follow-model.ts';
import { createFollower, followStorageKey } from '../src/presence/follower.ts';
import { joinMockPresence, mockHere } from '../src/presence/mock-presence.ts';

const WS = 'w-harbor';

const storage0 = (): Storage =>
  ({ getItem: () => null, setItem: () => {}, removeItem: () => {} }) as never;
const fakeClient = () => {
  const doc = new Y.Doc();
  return { awareness: new Awareness(doc), ydoc: doc, destroy: () => {} } as never;
};

describe('a follow carried off the board', () => {
  const storage = (entries: Record<string, string>): Storage => {
    const keys = Object.keys(entries);
    return {
      length: keys.length,
      key: (i: number) => keys[i] ?? null,
      getItem: (k: string) => entries[k] ?? null,
    } as Storage;
  };
  const slot = followStorageKey(WS);

  it('names the board whose follow arrives at this address, or holds on', () => {
    const arriving = JSON.stringify({ key: 'a-lead', arriving: '/review' });
    expect(carriedFollowBoard(storage({ [slot]: arriving }), '/review')).toBe(WS);
    expect(carriedFollowBoard(storage({ [slot]: JSON.stringify({ key: 'a-lead' }) }), '/')).toBe(
      WS,
    );
  });

  it('is nobody when the reader went somewhere else, or nothing is stored', () => {
    const arriving = JSON.stringify({ key: 'a-lead', arriving: '/review' });
    expect(carriedFollowBoard(storage({ [slot]: arriving }), '/')).toBeNull();
    expect(carriedFollowBoard(storage({ other: arriving }), '/review')).toBeNull();
    expect(carriedFollowBoard(storage({ [slot]: '{not json' }), '/review')).toBeNull();
  });
});

describe('what a mock tells its host page', () => {
  const heard = (data: unknown) => {
    let spot: PresenceSpot | null = null;
    let listener: ((ev: { source: unknown; data: unknown }) => void) | null = null;
    const frameWindow = { postMessage: () => {} };
    const presence = joinMockPresence({
      workspaceId: WS,
      docId: 'm-quay',
      user: { id: 'anon-first-person', name: 'Alice' },
      connect: () => fakeClient(),
      win: {
        location: {
          pathname: '/workspaces/w-harbor/mockups/m-quay',
          search: '',
          origin: 'https://board.test',
        },
        sessionStorage: storage0(),
        addEventListener: (_: string, cb: never) => {
          listener = cb;
        },
      } as never,
      frame: () => ({ contentWindow: frameWindow, addEventListener: () => {} }) as never,
    });
    presence.moveTo = (s) => {
      spot = s;
    };
    (listener as unknown as (ev: { source: unknown; data: unknown }) => void)({
      source: frameWindow,
      data,
    });
    return { spot: spot as PresenceSpot | null, here: mockHere() };
  };

  it('moves the spot and keeps the section and thread for a voice message', () => {
    const { spot, here } = heard({ cw: 'here', scroll: 0.5, heading: 'Tides', thread: 'th-1' });
    expect(spot).toMatchObject({ surface: 'mock', docId: 'm-quay', scroll: 0.5, threadId: 'th-1' });
    expect(here).toEqual({ scroll: 0.5, heading: 'Tides', threadId: 'th-1' });
  });

  it('drops what the frame wrote that is not a place', () => {
    const { spot } = heard({ cw: 'here', scroll: 9, heading: 3, thread: '../x' });
    expect(spot).toEqual({ surface: 'mock', docId: 'm-quay' });
    expect(heard({ cw: 'other' }).spot).toBeNull();
  });
});

describe('a spot that names a page', () => {
  it('keeps a path, a scroll fraction and a mock, and drops what could leave', () => {
    expect(parseSpot({ surface: 'board', path: '/workspaces/w-harbor/home?item=x:1' })).toEqual({
      surface: 'board',
      path: '/workspaces/w-harbor/home?item=x:1',
    });
    expect(parseSpot({ surface: 'doc', docId: 'd-quay', scroll: 0.5 })).toEqual({
      surface: 'doc',
      docId: 'd-quay',
      scroll: 0.5,
    });
    expect(parseSpot({ surface: 'mock', docId: 'm-quay', quote: 'tide table' })).toEqual({
      surface: 'mock',
      docId: 'm-quay',
      quote: 'tide table',
    });
    for (const path of ['//evil.example/x', 'javascript:alert(1)', '/a/../b', '/a\\b', 'home']) {
      expect(parseSpot({ surface: 'board', path })?.path, path).toBeUndefined();
    }
    for (const scroll of [-0.1, 1.5, Number.NaN, '0.5']) {
      expect(parseSpot({ surface: 'doc', docId: 'd', scroll })?.scroll).toBeUndefined();
    }
  });

  it('opens a path on this board, the review queue or the list, and nowhere else', () => {
    const board = (path: string): PresenceSpot => ({ surface: 'board', path });
    expect(spotHref(WS, board('/workspaces/w-harbor/library'))).toBe(
      '/workspaces/w-harbor/library',
    );
    expect(spotHref(WS, board('/workspaces/w-harbor?task=t-1&thread=th-1'))).toBe(
      '/workspaces/w-harbor?task=t-1&thread=th-1',
    );
    expect(spotHref(WS, board('/workspaces/w-harbor/apps/a-1/'))).toBe(
      '/workspaces/w-harbor/apps/a-1/',
    );
    expect(spotHref(WS, board('/review'))).toBe('/review');
    expect(spotHref(WS, board('/'))).toBe('/');
    // Another board's page, or a look-alike prefix, is not this board's.
    expect(spotHref(WS, board('/workspaces/w-other/home'))).toBe('/workspaces/w-harbor');
    expect(spotHref(WS, board('/workspaces/w-harbor-2/home'))).toBe('/workspaces/w-harbor');
    expect(spotHref(WS, board('/settings'))).toBe('/workspaces/w-harbor');
  });

  it('opens a mock on its own host page, at the thread when it names one', () => {
    expect(spotHref(WS, { surface: 'mock', docId: 'm-quay' })).toBe(
      '/workspaces/w-harbor/mockups/m-quay',
    );
    expect(spotHref(WS, { surface: 'mock', docId: 'm-quay', threadId: 'th-2' })).toBe(
      '/workspaces/w-harbor/mockups/m-quay?thread=th-2',
    );
  });

  it('is a new spot when only its path, phrase or scroll moved', () => {
    const base: PresenceSpot = { surface: 'board', path: '/workspaces/w-harbor/home' };
    const keys = new Set([
      spotKey(base),
      spotKey({ ...base, path: '/workspaces/w-harbor/library' }),
      spotKey({ surface: 'doc', docId: 'd', quote: 'a' }),
      spotKey({ surface: 'doc', docId: 'd', quote: 'b' }),
      spotKey({ surface: 'doc', docId: 'd', scroll: 0.2 }),
      spotKey({ surface: 'doc', docId: 'd', scroll: 0.8 }),
    ]);
    expect(keys.size).toBe(6);
  });

  it('shows a board path in place on the board, rather than loading it', () => {
    const room = new Awareness(new Y.Doc());
    const went: string[] = [];
    const shown: PresenceSpot[] = [];
    const store = new Map<string, string>();
    const follower = createFollower({
      room,
      workspaceId: WS,
      here: () => ({ surface: 'board', path: '/workspaces/w-harbor' }),
      address: () => '/workspaces/w-harbor',
      go: (href) => went.push(href),
      show: (spot) => shown.push(spot),
      storage: {
        getItem: (k) => store.get(k) ?? null,
        setItem: (k, v) => void store.set(k, v),
        removeItem: (k) => void store.delete(k),
      },
    });
    const server = new Awareness(new Y.Doc());
    server.setLocalState({
      agentSpots: {
        'agent-harbor': {
          surface: 'board',
          path: '/workspaces/w-harbor/home?item=x:1',
          name: 'Harborlight',
          seq: 1,
        },
      },
    });
    // The room hears the server's state the way a socket applies it.
    room.states.set(server.clientID, server.getLocalState() as Record<string, unknown>);
    follower.follow('a-agent-harbor');
    expect(went).toEqual([]);
    expect(shown.map((s) => s.path)).toEqual(['/workspaces/w-harbor/home?item=x:1']);
    // A spot that is on another page is loaded.
    server.setLocalState({
      agentSpots: {
        'agent-harbor': { surface: 'doc', docId: 'd-quay', name: 'Harborlight', seq: 2 },
      },
    });
    room.states.set(server.clientID, server.getLocalState() as Record<string, unknown>);
    follower.refresh();
    expect(went).toEqual(['/workspaces/w-harbor/docs/d-quay']);
  });

  it('loads a page the board does not draw itself, from the board', () => {
    const room = new Awareness(new Y.Doc());
    const went: string[] = [];
    const shown: PresenceSpot[] = [];
    const follower = createFollower({
      room,
      workspaceId: WS,
      here: () => ({ surface: 'board', path: '/workspaces/w-harbor' }),
      address: () => '/workspaces/w-harbor',
      go: (href) => went.push(href),
      show: (spot) => shown.push(spot),
      storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    });
    const server = new Awareness(new Y.Doc());
    let seq = 0;
    for (const path of [
      '/workspaces/w-harbor/apps/a-1/',
      '/review',
      '/workspaces/w-harbor/activity',
    ]) {
      server.setLocalState({
        agentSpots: { 'agent-harbor': { surface: 'board', path, name: 'Harborlight', seq: ++seq } },
      });
      room.states.set(server.clientID, server.getLocalState() as Record<string, unknown>);
      if (seq === 1) follower.follow('a-agent-harbor');
      else follower.refresh();
    }
    expect(went).toEqual(['/workspaces/w-harbor/apps/a-1/', '/review']);
    expect(shown.map((s) => s.path)).toEqual(['/workspaces/w-harbor/activity']);
  });
});
