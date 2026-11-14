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
  presenceUserFor,
  stampAwarenessUpdate,
} from '../src/presence-identity.ts';
import { createUpgradeStream } from '../src/routes/upgrade-stream.ts';
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
  socketSeed: 'k7q2m9x4abcd',
  ...over,
});

describe('stampAwarenessUpdate', () => {
  it('replaces the user a page announced with the stamp, and keeps the rest of its state', () => {
    const stamp = presenceUserFor(proof({ proven: ALICE }));
    const out = stampAwarenessUpdate(
      updateFrom([[101, { user: { id: 'user-x', name: 'Bob' }, surface: 'doc' }]]),
      { stamp, isForeign: () => false },
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
        isForeign: (id) => id === SERVER || id === OTHER,
      },
    );
    expect([...heard(out as Uint8Array).keys()]).toEqual([101]);
  });

  it('gives a state with no user the stamp too, so it cannot pose as the server', () => {
    const out = stampAwarenessUpdate(updateFrom([[101, { agentSpots: { forged: {} } }]]), {
      stamp: presenceUserFor(proof()),
      isForeign: () => false,
    });
    expect(heard(out as Uint8Array).get(101)?.user).toMatchObject({ id: OWNER.id });
  });

  it('answers null when nothing is left, or the frame is malformed', () => {
    expect(
      stampAwarenessUpdate(updateFrom([[101, { user: { name: 'Bob' } }]]), {
        stamp: presenceUserFor(proof()),
        isForeign: () => true,
      }),
    ).toBeNull();
    expect(
      stampAwarenessUpdate(new Uint8Array([3, 200]), {
        stamp: presenceUserFor(proof()),
        isForeign: () => false,
      }),
    ).toBeNull();
  });
});

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
    const u = presenceUserFor(proof({ shareKey: 's-1' }));
    expect(u.id).toMatch(/^guest-/);
    expect(u.kind).toBe('guest');
    expect(u.name).not.toBe(OWNER.name);
  });

  it('names a read-only socket Guest', () => {
    expect(presenceUserFor(proof({ readOnly: true }))).toMatchObject({
      name: 'Guest k7q2',
      kind: 'guest',
      verified: false,
    });
  });

  it('names a writable unproven socket the owner, unverified', () => {
    expect(presenceUserFor(proof())).toMatchObject({ ...OWNER, verified: false });
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
    who: { proven?: User; visitorShareId?: string; requireSignIn?: boolean },
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
      presenceRoster: { owner: () => OWNER, isAgent: () => false },
      j: (status: number, body: unknown) => Response.json(body, { status }),
    } as never);
    const url = new URL(`http://localhost:8787${path}`);
    stream.serveUpgradeAndStreamRoutes({
      req: new Request(url, { headers: UPGRADE }),
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
    it(`${path}: an unproven share visitor is stamped a guest-`, () => {
      expect(stampFor(path, { visitorShareId: 's-1' }).presenceUser?.id).toMatch(/^guest-/);
    });
    it(`${path}: a read-only socket is stamped Guest`, () => {
      expect(stampFor(path, { requireSignIn: true }).presenceUser?.name).toMatch(/^Guest /);
    });
    it(`${path}: a writable unproven socket is stamped the owner`, () => {
      expect(stampFor(path, {}).presenceUser).toMatchObject({ ...OWNER, verified: false });
    });
  }
});
