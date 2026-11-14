/**
 * `presence-identity.ts` on its own, and the name each upgrade stamps on a
 * socket. The real sockets are `presence-stamp-room.test.ts`.
 */
import { describe, expect, it } from 'bun:test';
import type { User } from '@claude-workspaces/core';
import * as encoding from 'lib0/encoding';
import { Awareness, applyAwarenessUpdate } from 'y-protocols/awareness';
import * as Y from 'yjs';
import {
  type PresenceProof,
  type PresenceStamp,
  type PresenceUser,
  isGuestStamp,
  presenceUserFor,
  resolveStamp,
  stampAwarenessUpdate,
} from '../src/presence-identity.ts';
import { createUpgradeStream } from '../src/routes/upgrade-stream.ts';
import { sanitizeVisitorAuthor } from '../src/share/visitor-identity.ts';
import type { UpgradeData } from '../src/socket-handlers.ts';

const ALICE: User = { id: 'user-alice', name: 'Alice', kind: 'known', color: '#2e7dd7' };
const OWNER = { id: 'known-harborlight', name: 'Harborlight' };

/** An awareness update announcing `state` under each client id, at clock 1. */
function updateFrom(entries: Array<[number, Record<string, unknown> | null]>): Uint8Array {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, entries.length);
  for (const [clientId, state] of entries) {
    encoding.writeVarUint(enc, clientId);
    encoding.writeVarUint(enc, 1);
    encoding.writeVarString(enc, JSON.stringify(state));
  }
  return encoding.toUint8Array(enc);
}

/** What a reader hears after applying `update`. */
function heard(update: Uint8Array): Map<number, Record<string, unknown>> {
  const reader = new Awareness(new Y.Doc());
  applyAwarenessUpdate(reader, update, null);
  const out = new Map<number, Record<string, unknown>>();
  for (const [id, s] of reader.getStates()) {
    if (id !== reader.clientID) out.set(id, s as Record<string, unknown>);
  }
  return out;
}

const proof = (over: Partial<PresenceProof> = {}): PresenceProof => ({
  proven: null,
  shareKey: null,
  readOnly: false,
  isAgent: (id) => id.startsWith('agent-'),
  owner: () => OWNER,
  offBox: false,
  ...over,
});

describe('stampAwarenessUpdate', () => {
  it('replaces the user a page announced with the stamp, and keeps the rest of its state', () => {
    const stamp = presenceUserFor(proof({ proven: ALICE }));
    const out = stampAwarenessUpdate(
      updateFrom([[101, { user: { id: 'user-x', name: 'Bob' }, surface: 'doc' }]]),
      { stamp, mayCarry: () => true },
    );
    const state = heard(out as Uint8Array).get(101);
    expect(state?.surface).toBe('doc');
    expect(state?.user).toMatchObject({ id: 'user-alice', name: 'Alice', verified: true });
  });

  it("drops an entry for another socket's client id and for the server's own", () => {
    const SERVER = 9;
    const OTHER = 202;
    const out = stampAwarenessUpdate(
      updateFrom([
        [101, { user: { name: 'Bob' } }],
        [OTHER, { user: { name: 'Bob' } }],
        [SERVER, { agentSpots: { forged: {} } }],
      ]),
      {
        stamp: presenceUserFor(proof({ proven: ALICE })),
        mayCarry: (id) => !(id === SERVER || id === OTHER),
      },
    );
    expect([...heard(out as Uint8Array).keys()]).toEqual([101]);
  });

  it('gives a state with no user the stamp too, so it cannot pose as the server', () => {
    const out = stampAwarenessUpdate(updateFrom([[101, { agentSpots: { forged: {} } }]]), {
      stamp: presenceUserFor(proof()),
      mayCarry: () => true,
    });
    expect(heard(out as Uint8Array).get(101)?.user).toMatchObject({ id: OWNER.id });
  });

  it("drops the fields only the server writes: agents' spots and an agent's show directive", () => {
    const out = stampAwarenessUpdate(
      updateFrom([
        [
          101,
          {
            surface: 'board',
            agentSpots: { 'agent-x': { seq: 1, spot: { path: '/x' } } },
            personDirective: { to: 202, seq: 1e12, spot: { path: '/workspaces/w/docs/d' } },
          },
        ],
      ]),
      { stamp: presenceUserFor(proof({ proven: ALICE })), mayCarry: () => true },
    );
    const state = heard(out as Uint8Array).get(101);
    expect(state?.surface).toBe('board');
    expect(state?.agentSpots).toBeUndefined();
    expect(state?.personDirective).toBeUndefined();
  });

  it("names a guest from the browser's own id, the same on every socket, keeping a typed name", () => {
    const say = () =>
      heard(
        stampAwarenessUpdate(
          updateFrom([[101, { user: { id: 'anon-riverbend1', name: 'Alice' } }]]),
          // A fresh stamp per call: a second socket of the same browser.
          { stamp: presenceUserFor(proof({ shareKey: 's-1' })), mayCarry: () => true },
        ) as Uint8Array,
      ).get(101)?.user as { id: string; name: string; kind: string; verified: boolean };
    const first = say();
    const second = say();
    expect(first.id).toMatch(/^guest-/);
    expect(second.id).toBe(first.id);
    expect(first).toMatchObject({ name: 'Alice', kind: 'guest', verified: false });
  });

  it('gives a guest the same id their share comments carry', () => {
    const u = heard(
      stampAwarenessUpdate(
        updateFrom([[101, { user: { id: 'anon-riverbend1', name: 'Alice' } }]]),
        { stamp: presenceUserFor(proof({ shareKey: 's-1' })), mayCarry: () => true },
      ) as Uint8Array,
    ).get(101)?.user as { id: string };
    expect(u.id).toBe(sanitizeVisitorAuthor({ id: 'anon-riverbend1' }, { shareKey: 's-1' }).id);
  });

  it('refuses a guest a name a member of the roster goes by', () => {
    const u = heard(
      stampAwarenessUpdate(updateFrom([[101, { user: { id: 'anon-1', name: 'Harborlight' } }]]), {
        stamp: presenceUserFor(
          proof({ readOnly: true, reservedName: (n) => n.toLowerCase() === 'harborlight' }),
        ),
        mayCarry: () => true,
      }) as Uint8Array,
    ).get(101)?.user as { name: string };
    expect(u.name).not.toBe('Harborlight');
  });

  it('asks whether to carry each entry with the name it would carry', () => {
    const asked: Array<[number, string | null]> = [];
    stampAwarenessUpdate(
      updateFrom([
        [101, { user: { name: 'x' } }],
        [102, null],
      ]),
      {
        stamp: presenceUserFor(proof({ proven: ALICE })),
        mayCarry: (id, user: PresenceUser | null) => {
          asked.push([id, user?.id ?? null]);
          return true;
        },
      },
    );
    expect(asked).toEqual([
      [101, 'user-alice'],
      [102, null],
    ]);
  });

  it('answers null when nothing is left, or the frame is malformed', () => {
    expect(
      stampAwarenessUpdate(updateFrom([[101, { user: { name: 'Bob' } }]]), {
        stamp: presenceUserFor(proof()),
        mayCarry: () => false,
      }),
    ).toBeNull();
    expect(
      stampAwarenessUpdate(new Uint8Array([3, 200]), {
        stamp: presenceUserFor(proof()),
        mayCarry: () => true,
      }),
    ).toBeNull();
  });
});

/** The name a stamp gives a page that announced the browser id `anon-1`. */
const named = (stamp: PresenceStamp): PresenceUser => resolveStamp(stamp, { id: 'anon-1' });

describe('presenceUserFor', () => {
  it('names the proven identity first', () => {
    expect(presenceUserFor(proof({ proven: ALICE, shareKey: 's-1' }))).toMatchObject({
      id: 'user-alice',
      name: 'Alice',
      kind: 'person',
      verified: true,
    });
  });

  it('names an unproven share visitor a guest-, never the owner', () => {
    const u = named(presenceUserFor(proof({ shareKey: 's-1' })));
    expect(u.id).toMatch(/^guest-/);
    expect(u.kind).toBe('guest');
    expect(u.name).not.toBe(OWNER.name);
  });

  it('names a read-only socket a guest', () => {
    expect(presenceUserFor(proof({ readOnly: true }))).toMatchObject({
      kind: 'guest',
      verified: false,
    });
  });

  it('names a writable unproven socket on this machine the owner, unverified', () => {
    expect(presenceUserFor(proof())).toMatchObject({ ...OWNER, verified: false });
  });

  it('names a writable unproven socket from off this machine a guest, never the owner', () => {
    const u = named(presenceUserFor(proof({ offBox: true })));
    expect(u.kind).toBe('guest');
    expect(u.id).not.toBe(OWNER.id);
    expect(u.name).not.toBe(OWNER.name);
  });
});

describe('the name each upgrade stamps', () => {
  const WS = 'riverbend';
  const DOC = 'saltmarsh';
  const UPGRADE = {
    upgrade: 'websocket',
    connection: 'upgrade',
    'sec-websocket-version': '13',
    'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
    origin: 'http://localhost:8787',
  };

  function stampFor(
    path: string,
    who: {
      proven?: User;
      visitorShareId?: string;
      requireSignIn?: boolean;
      offBox?: boolean;
      tunnel?: boolean;
    },
  ): UpgradeData {
    const stamped: UpgradeData[] = [];
    const stream = createUpgradeStream({
      server: {
        upgrade: (_req: Request, options: { data: UpgradeData }) => {
          stamped.push(options.data);
          return true;
        },
      },
      docStore: { get: (id: string) => (id === DOC ? { docId: DOC } : undefined), list: () => [] },
      taskStore: { getWorkspace: (id: string) => (id === WS ? { id } : undefined) },
      isValidDocId: () => true,
      workspacesOfMember: () => [WS],
      policyFor: () => ({
        requestOrigin: 'http://localhost:8787',
        localHostnames: ['localhost', '127.0.0.1'],
        allowedOrigins: [],
      }),
      requireSignInToWrite: who.requireSignIn === true,
      requestAddress: () => (who.offBox ? '100.64.0.7' : '127.0.0.1'),
      presenceRoster: { owner: () => OWNER, isAgent: () => false },
      j: (status: number, body: unknown) => Response.json(body, { status }),
    } as never);
    const url = new URL(`http://localhost:8787${path}`);
    stream.serveUpgradeAndStreamRoutes({
      req: new Request(url, {
        headers: who.tunnel ? { ...UPGRADE, 'cf-ray': '8f00-SJC' } : UPGRADE,
      }),
      url,
      pathname: url.pathname,
      visitor: who.visitorShareId ? ({ workspaceId: WS } as never) : null,
      visitorShareId: who.visitorShareId ?? null,
      visitorMemberKey: null,
      ownerProven: () => false,
      anyoneProven: () => who.proven !== undefined,
      browserProvedNobody: () => who.proven === undefined,
      provenAuthor: () => who.proven ?? null,
      widgetDoorGrant: null,
      widgetTokenProved: false,
    });
    const data = stamped[0];
    if (!data) throw new Error(`no socket stamped for ${path}`);
    return data;
  }

  for (const path of [`/workspaces/${WS}/y`, `/workspaces/${WS}/docs/${DOC}/y`]) {
    it(`${path}: a proven session is stamped with its own name`, () => {
      expect(stampFor(path, { proven: ALICE }).presenceUser).toMatchObject({
        id: ALICE.id,
        verified: true,
      });
    });
    it(`${path}: an unproven share visitor is stamped a guest of that share`, () => {
      const stamp = stampFor(path, { visitorShareId: 's-1' }).presenceUser;
      expect(stamp && isGuestStamp(stamp) ? stamp.scope : null).toBe('s-1');
    });
    it(`${path}: a read-only socket is stamped a guest`, () => {
      expect(stampFor(path, { requireSignIn: true }).presenceUser?.kind).toBe('guest');
    });
    it(`${path}: a writable unproven loopback socket is stamped the owner`, () => {
      expect(stampFor(path, {}).presenceUser).toMatchObject({ ...OWNER, verified: false });
    });
    it(`${path}: a writable unproven socket from the tailnet is stamped a guest`, () => {
      expect(stampFor(path, { offBox: true }).presenceUser?.kind).toBe('guest');
    });
    it(`${path}: a writable unproven socket through the tunnel is a guest, though its peer is loopback`, () => {
      expect(stampFor(path, { tunnel: true }).presenceUser?.kind).toBe('guest');
    });
  }
});
