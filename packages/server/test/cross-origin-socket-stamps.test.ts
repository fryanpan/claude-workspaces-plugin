/**
 * What each websocket upgrade stamps on its socket when a page on another
 * origin brings the reader's cookie.
 *
 * A dev server on another port is same-site with this server, so the browser
 * sends the reader's cookie with every socket a page there opens. The REST
 * write gate refuses such a write; an upgrade is a GET and cannot refuse it
 * the same way, so the cookie is ignored instead: the socket is stamped as one
 * that proved nobody. Driven through the upgrade run itself with a fake
 * `server.upgrade` that records the stamp, as `meeting-takeover.test.ts` does,
 * so every socket kind is checked without standing up its engines.
 *
 * Each case has its positive control: the same request from this server's own
 * origin, and the same request carrying a widget token, keep the identity.
 */
import { describe, expect, it } from 'bun:test';
import type { User } from '@claude-workspaces/core';
import { createUpgradeStream } from '../src/routes/upgrade-stream.ts';
import type { UpgradeData } from '../src/socket-handlers.ts';

const ALICE: User = { id: 'known-alice', name: 'Alice', kind: 'known', color: '#2e7dd7' };
const WS = 'harborlight';
const DOC = 'riverbend';
const OWN = 'http://localhost:8787';
const DEV = 'http://localhost:3000';

const UPGRADE = {
  upgrade: 'websocket',
  connection: 'upgrade',
  'sec-websocket-version': '13',
  'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
};

const SOCKETS: Record<string, string> = {
  doc: `/workspaces/${WS}/docs/${DOC}/y`,
  board: `/workspaces/${WS}/y`,
  audio: `/workspaces/${WS}/docs/${DOC}/audio`,
  voice: `/workspaces/${WS}/docs/${DOC}/voice`,
  converse: `/workspaces/${WS}/voice/converse`,
};

interface Case {
  origin: string;
  credential?: Record<string, string>;
  widgetTokenProved?: boolean;
}

/** Open `path` as Alice, whose sign-in the request proved, and return the stamp. */
function stampFor(path: string, c: Case): UpgradeData {
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
      requestOrigin: OWN,
      localHostnames: ['localhost', '127.0.0.1'],
      allowedOrigins: [],
    }),
    requireSignInToWrite: true,
    j: (status: number, body: unknown) => Response.json(body, { status }),
  } as never);
  const url = new URL(`${OWN}${path}`);
  const out = stream.serveUpgradeAndStreamRoutes({
    req: new Request(url, { headers: { ...UPGRADE, origin: c.origin, ...c.credential } }),
    url,
    pathname: url.pathname,
    visitor: null,
    visitorShareId: null,
    visitorMemberKey: null,
    // What the request's cookie proved, before this gate looks at where it came from.
    ownerProven: () => true,
    anyoneProven: () => true,
    browserProvedNobody: () => false,
    provenAuthor: () => ALICE,
    widgetDoorGrant: null,
    widgetTokenProved: c.widgetTokenProved === true,
  });
  expect(out?.kind, path).toBe('upgraded');
  const data = stamped[0];
  if (!data) throw new Error(`no socket stamped for ${path}`);
  return data;
}

/** What a stamp grants, in one shape for every socket kind. */
function grants(d: UpgradeData) {
  return {
    readOnly: d.readOnly === true,
    named: (d.author ?? d.editor?.user ?? null) !== null,
    ownerProven: d.ownerProven === true,
  };
}

describe('a socket from another origin carrying the reader’s credentials', () => {
  for (const [kind, path] of Object.entries(SOCKETS)) {
    for (const credential of [
      { cookie: 'cw_session=v2.riverbend' },
      { 'cf-access-jwt-assertion': 'riverbend' },
    ] as Record<string, string>[]) {
      it(`${kind}: opens read-only and names nobody (${Object.keys(credential)[0]})`, () => {
        const g = grants(stampFor(path, { origin: DEV, credential }));
        expect(g).toEqual({ readOnly: true, named: false, ownerProven: false });
      });
    }

    it(`${kind}: the same cookie on this server’s own page keeps the sign-in — POSITIVE CONTROL`, () => {
      const g = grants(
        stampFor(path, { origin: OWN, credential: { cookie: 'cw_session=v2.riverbend' } }),
      );
      expect(g.readOnly).toBe(false);
      // The board room carries no identity at all, so there is nothing to name.
      if (kind !== 'board') expect(g.named).toBe(true);
      if (kind === 'converse') expect(g.ownerProven).toBe(true);
    });

    it(`${kind}: a widget token on the socket is judged by the token — the widget keeps working`, () => {
      const g = grants(
        stampFor(path, {
          origin: DEV,
          credential: { cookie: 'cw_session=v2.riverbend' },
          widgetTokenProved: true,
        }),
      );
      expect(g.readOnly).toBe(false);
      if (kind !== 'board') expect(g.named).toBe(true);
      // The token never proves the owner, and the cookie beside it crossed
      // origins, so nothing on this socket does.
      expect(g.ownerProven).toBe(false);
    });

    it(`${kind}: a widget token from this server’s own page keeps owner proof — POSITIVE CONTROL`, () => {
      const g = grants(
        stampFor(path, {
          origin: OWN,
          credential: { cookie: 'cw_session=v2.riverbend' },
          widgetTokenProved: true,
        }),
      );
      if (kind === 'converse') expect(g.ownerProven).toBe(true);
    });

    it(`${kind}: another origin with no credential is not touched by this gate`, () => {
      expect(grants(stampFor(path, { origin: DEV })).readOnly).toBe(false);
    });
  }
});
