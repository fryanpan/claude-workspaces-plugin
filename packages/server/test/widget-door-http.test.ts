/**
 * The tailnet widget door, over HTTP: an app page on the tailnet hostname
 * loads the widget, signs in through a popup on the operator's public Access
 * host, and reaches ONE board's comment routes and socket with the board token
 * that popup minted — and nothing else, with any token or none.
 *
 * Every refusal here is paired with the same request succeeding with the
 * right token, so nothing passes on a server that refuses everything.
 * Fixtures are fictional hosts and names; the repo is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createThread, emailIdentityId } from '@claude-workspaces/core';
import { type JSONWebKeySet, type JWK, SignJWT, exportJWK, generateKeyPair } from 'jose';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import { activityLogPath } from '../src/activity.ts';
import {
  BOARD_WIDGET_TOKEN_TTL_MS,
  mintBoardWidgetToken,
  widgetTokenKey,
} from '../src/auth/widget-token.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { loadCookieKey } from '../src/share/link-session.ts';
import { ACCESS_SHARE_CONFIG, mockCfApi } from './access-share.ts';
import { waitFor } from './wait-for.ts';
import { seedBoard } from './workspace-seed.ts';

const TEAM_DOMAIN = 'test.cloudflareaccess.com';
const KID = 'widget-door-kid';
const AUD = 'aud-for-the-operator-app';
/** The operator's public Access host, where the sign-in popup opens. */
const OPERATOR_HOST = 'operator.example.com';
const OPERATOR_EMAIL = 'operator@example.com';
/** The tailnet hostname the door answers on. */
const DOOR = 'tailnet-host.test';
/** An app page served on the tailnet hostname. */
const PAGE = `http://${DOOR}:8994`;
const CF_RAY = { 'cf-ray': '8a1b2c3d4e5f-SJC' };

const anchor = {
  kind: 'element',
  fingerprint: {
    tag: 'BUTTON',
    stableAttrs: {},
    classes: [],
    text: 'Go',
    path: 'BUTTON[0] > BODY[0]',
    dataAttrs: {},
  },
  snippet: { text: 'Go' },
};
const claimed = { id: 'known-harborlight', name: 'Harborlight', kind: 'known', color: '#2e7dd7' };

let jwt = '';
let widgetDist = '';

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const publicJwk = (await exportJWK(publicKey)) as JWK;
  Object.assign(publicJwk, { kid: KID, alg: 'RS256', use: 'sig' });
  const jwks: JSONWebKeySet = { keys: [publicJwk] };
  serverOpts.cfAccess = { teamDomain: TEAM_DOMAIN, audience: AUD, jwks };
  jwt = await new SignJWT({ email: OPERATOR_EMAIL })
    .setProtectedHeader({ alg: 'RS256', kid: KID })
    .setIssuer(`https://${TEAM_DOMAIN}`)
    .setAudience(AUD)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + 600)
    .setSubject('cf-access-operator')
    .sign(privateKey);
  widgetDist = mkdtempSync(join(tmpdir(), 'widget-door-dist-'));
  writeFileSync(join(widgetDist, 'widget.iife.js'), '/* the widget */');
  serverOpts.widgetDistDir = widgetDist;
});

afterAll(() => rmSync(widgetDist, { recursive: true, force: true }));

/** As prod runs: access-only on, shares wired, the operator's Access host. */
const serverOpts: Record<string, unknown> = {
  share: { config: ACCESS_SHARE_CONFIG, cfApi: mockCfApi() },
  proxiedTrustedHosts: [OPERATOR_HOST],
  proxiedTrustedEmails: [OPERATOR_EMAIL],
  widgetDoorHosts: [DOOR],
};

function boot(dataDir: string): { handle: ServerHandle; base: string } {
  const handle = createServer({ port: 0, dataDir, ...serverOpts });
  return { handle, base: `http://127.0.0.1:${handle.port}` };
}

interface DoorInit {
  method?: string;
  token?: string | null;
  origin?: string | null;
  body?: unknown;
  headers?: Record<string, string>;
}

/** A request the widget on the tailnet page makes. */
function onDoor(base: string, path: string, init: DoorInit = {}): Promise<Response> {
  const origin = init.origin === undefined ? PAGE : init.origin;
  return fetch(`${base}${path}`, {
    method: init.method ?? 'GET',
    redirect: 'manual',
    headers: {
      host: `${DOOR}:8960`,
      ...(origin === null ? {} : { origin }),
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(init.headers ?? {}),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

/** The widget's socket: the token rides as the one subprotocol offered. */
function doorSocket(base: string, path: string, token: string | null, origin = PAGE) {
  return fetch(`${base}${path}?type=mockup&sourceUrl=${encodeURIComponent(`${PAGE}/`)}`, {
    headers: {
      host: `${DOOR}:8960`,
      origin,
      connection: 'Upgrade',
      upgrade: 'websocket',
      'sec-websocket-version': '13',
      'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      ...(token ? { 'sec-websocket-protocol': token } : {}),
    },
  });
}

/** The sign-in popup's mint, on the operator's host through the tunnel. */
function mint(base: string, body: unknown, withAccess = true): Promise<Response> {
  return fetch(`${base}/api/auth/widget-token`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      host: OPERATOR_HOST,
      ...CF_RAY,
      'x-forwarded-proto': 'https',
      origin: `https://${OPERATOR_HOST}`,
      'content-type': 'application/json',
      ...(withAccess ? { 'cf-access-jwt-assertion': jwt } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function mintFor(base: string, workspaceId: string, origin = PAGE): Promise<string> {
  const res = await mint(base, { origin, workspaceId });
  expect(res.status).toBe(200);
  return ((await res.json()) as { token: string }).token;
}

const threadBody = { author: claimed, text: 'the header overlaps the menu', anchor };

function commentActors(dataDir: string): string[] {
  if (!existsSync(activityLogPath(dataDir))) return [];
  return readFileSync(activityLogPath(dataDir), 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as { type: string; actorId: string })
    .filter((r) => r.type === 'comment')
    .map((r) => r.actorId);
}

describe('the tailnet widget door', () => {
  let dataDir: string;
  let handle: ServerHandle;
  let base: string;
  /** The board the page's widget is on, and a second board it is not. */
  let boardA: string;
  let boardB: string;
  let tokenA: string;
  let threadId: string;
  const docA = 'riverbend-page';
  const docB = 'saltmarsh-page';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'widget-door-'));
    ({ handle, base } = boot(dataDir));
    boardA = await seedBoard(base, { name: 'Riverbend' });
    boardB = await seedBoard(base, { name: 'Saltmarsh' });
    tokenA = await mintFor(base, boardA);
    // The page's doc comes to exist the way it does in a browser: the
    // widget's first socket creates it.
    expect((await doorSocket(base, `/workspaces/${boardA}/docs/${docA}/y`, tokenA)).status).toBe(
      101,
    );
    const tokenB = await mintFor(base, boardB);
    expect((await doorSocket(base, `/workspaces/${boardB}/docs/${docB}/y`, tokenB)).status).toBe(
      101,
    );
    const posted = await onDoor(base, `/workspaces/${boardA}/docs/${docA}/threads`, {
      method: 'POST',
      token: tokenA,
      body: threadBody,
    });
    expect(posted.status).toBe(200);
    threadId = ((await posted.json()) as { thread: { id: string } }).thread.id;
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  /** Every route the door admits besides the bundle, as the widget calls it. */
  const admitted = (): Array<[string, string, string]> => [
    ['GET', '/api/auth/session', 'the load probe'],
    ['GET', '/api/auth/widget-session', 'the token probe'],
    ['GET', `/workspaces/${boardA}/docs/${docA}/threads`, 'the thread list'],
    ['POST', `/workspaces/${boardA}/docs/${docA}/threads`, 'a new thread'],
    ['POST', `/workspaces/${boardA}/docs/${docA}/threads/${threadId}/comments`, 'a reply'],
    ['POST', `/workspaces/${boardA}/docs/${docA}/threads/${threadId}/answer`, 'an answer'],
    ['POST', `/workspaces/${boardA}/docs/${docA}/threads/${threadId}/resolve`, 'a resolve'],
    ['POST', `/workspaces/${boardA}/docs/${docA}/threads/${threadId}/reopen`, 'a reopen'],
  ];

  const bodyFor = (method: string) =>
    method === 'POST' ? { text: 'a reply', author: claimed, anchor, answer: 'yes' } : undefined;

  describe('with no token', () => {
    it('serves the widget bundle, the one request that needs none', async () => {
      const res = await onDoor(base, '/widget.iife.js');
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('/* the widget */');
    });

    it('refuses every other admitted route with the sign-in cue and where to sign in', async () => {
      for (const [method, path, name] of admitted()) {
        const res = await onDoor(base, path, { method, body: bodyFor(method) });
        expect(res.status, name).toBe(401);
        expect(await res.json(), name).toEqual({
          error: 'sign_in_required',
          signInToWrite: true,
          signInOrigin: `https://${OPERATOR_HOST}`,
        });
      }
      expect(commentActors(dataDir).length).toBe(1);
    });

    it('refuses the socket', async () => {
      const res = await doorSocket(base, `/workspaces/${boardA}/docs/${docA}/y`, null);
      expect(res.status).toBe(401);
    });

    it('refuses a session-shaped or forged token the same way', async () => {
      for (const token of ['wt1.forged.sig', `${tokenA.slice(0, -2)}xx`]) {
        const res = await onDoor(base, `/workspaces/${boardA}/docs/${docA}/threads`, { token });
        expect(res.status, token.slice(0, 4)).toBe(401);
      }
    });
  });

  describe('with the board token', () => {
    it('POSITIVE CONTROL: every admitted route answers', async () => {
      for (const [method, path, name] of admitted()) {
        const res = await onDoor(base, path, { method, token: tokenA, body: bodyFor(method) });
        expect(res.status, name).not.toBe(401);
        expect(res.status, name).not.toBe(403);
        expect(res.status, name).not.toBe(404);
      }
    });

    it('credits a comment to the person the popup proved, not the name the body claims', async () => {
      const before = commentActors(dataDir).length;
      const res = await onDoor(base, `/workspaces/${boardA}/docs/${docA}/threads`, {
        method: 'POST',
        token: tokenA,
        body: threadBody,
      });
      expect(res.status).toBe(200);
      const actors = commentActors(dataDir);
      expect(actors.length).toBe(before + 1);
      expect(actors.at(-1)).toBe(emailIdentityId(OPERATOR_EMAIL));
    });

    it('answers the token probe as that person', async () => {
      const res = await onDoor(base, '/api/auth/widget-session', { token: tokenA });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ authenticated: true });
    });

    it('opens the socket and echoes the subprotocol the browser asked for', async () => {
      const res = await doorSocket(base, `/workspaces/${boardA}/docs/${docA}/y`, tokenA);
      expect(res.status).toBe(101);
      expect(res.headers.get('sec-websocket-protocol')).toBe(tokenA);
    });
  });

  describe('the socket is read-only', () => {
    /** Plant a thread straight into the ydoc over a live socket. */
    const plant = async (
      url: string,
      init: { headers: Record<string, string>; protocols?: string[] },
      threadId: string,
    ) => {
      const sock = new WebSocket(url, init as unknown as string[]);
      sock.binaryType = 'arraybuffer';
      const replies: number[] = [];
      sock.addEventListener('message', (ev) => {
        const dec = decoding.createDecoder(new Uint8Array(ev.data as ArrayBuffer));
        if (decoding.readVarUint(dec) === 0) replies.push(decoding.readVarUint(dec));
      });
      await new Promise((r) => sock.addEventListener('open', r, { once: true }));
      const local = new Y.Doc();
      createThread(local, {
        threadId,
        anchor: { kind: 'subject' },
        createdBy: { id: 'anon-x', kind: 'known', name: 'Mallory', color: '#000' },
        firstComment: { id: `${threadId}-c`, text: 'planted' },
      });
      const up = encoding.createEncoder();
      encoding.writeVarUint(up, 0);
      syncProtocol.writeUpdate(up, Y.encodeStateAsUpdate(local));
      sock.send(encoding.toUint8Array(up));
      // A step 1 after the update: its reply proves the update frame was read.
      const ask = encoding.createEncoder();
      encoding.writeVarUint(ask, 0);
      syncProtocol.writeSyncStep1(ask, new Y.Doc());
      sock.send(encoding.toUint8Array(ask));
      await waitFor(() => replies.includes(syncProtocol.messageYjsSyncStep2));
      sock.close();
    };

    it('takes no ydoc edit from a door socket, and the same edit from the box', async () => {
      const path = `/workspaces/${boardA}/docs/${docA}/y`;
      const wsBase = base.replace(/^http/, 'ws');
      await plant(
        `${wsBase}${path}`,
        { headers: { host: `localhost:${handle.port}` } },
        'th-from-the-box',
      );
      await plant(
        `${wsBase}${path}`,
        { headers: { host: `${DOOR}:8960`, origin: PAGE }, protocols: [tokenA] },
        'th-from-the-door',
      );
      const thread = (id: string) =>
        fetch(`${base}/workspaces/${boardA}/docs/${docA}/threads/${id}`);
      // CONTROL: the box's socket wrote, so the handshake and update are real.
      expect((await thread('th-from-the-box')).status).toBe(200);
      expect((await thread('th-from-the-door')).status).toBe(404);
    });
  });

  describe('one board', () => {
    it("refuses board B's threads and socket to a token for board A", async () => {
      const read = await onDoor(base, `/workspaces/${boardB}/docs/${docB}/threads`, {
        token: tokenA,
      });
      expect(read.status).toBe(403);
      const write = await onDoor(base, `/workspaces/${boardB}/docs/${docB}/threads`, {
        method: 'POST',
        token: tokenA,
        body: threadBody,
      });
      expect(write.status).toBe(403);
      const socket = await doorSocket(base, `/workspaces/${boardB}/docs/${docB}/y`, tokenA);
      expect(socket.status).toBe(403);
    });

    it("refuses board B's doc addressed under board A's path", async () => {
      const read = await onDoor(base, `/workspaces/${boardA}/docs/${docB}/threads`, {
        token: tokenA,
      });
      expect(read.status).toBe(404);
      const socket = await doorSocket(base, `/workspaces/${boardA}/docs/${docB}/y`, tokenA);
      expect(socket.status).toBe(404);
    });

    it("refuses a board's markdown doc: only the widget's own docs are on the door", async () => {
      const file = join(dataDir, 'notes.md');
      writeFileSync(file, '# Notes\n\nPrivate prose.\n');
      const created = await fetch(`${base}/workspaces/${boardA}/docs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ docId: 'notes', type: 'markdown', sourceUrl: file }),
      });
      expect(created.status).toBe(200);
      const read = await onDoor(base, `/workspaces/${boardA}/docs/notes/threads`, {
        token: tokenA,
      });
      expect(read.status).toBe(403);
      const socket = await doorSocket(base, `/workspaces/${boardA}/docs/notes/y`, tokenA);
      expect(socket.status).toBe(403);
    });
  });

  describe('one page origin', () => {
    it('refuses the token from another origin, or from none', async () => {
      const path = `/workspaces/${boardA}/docs/${docA}/threads`;
      for (const origin of [`http://${DOOR}:9999`, 'http://harborlight.test:8994', null]) {
        const res = await onDoor(base, path, { token: tokenA, origin });
        expect(res.status, String(origin)).toBe(401);
      }
      const socket = await doorSocket(
        base,
        `/workspaces/${boardA}/docs/${docA}/y`,
        tokenA,
        `http://${DOOR}:9999`,
      );
      expect(socket.status).toBe(401);
    });
  });

  describe('an expired token', () => {
    it('is refused, where the same token minted just now is served', async () => {
      const key = widgetTokenKey(loadCookieKey(dataDir));
      const grant = {
        identityId: emailIdentityId(OPERATOR_EMAIL),
        workspaceId: boardA,
        origin: PAGE,
      };
      const path = `/workspaces/${boardA}/docs/${docA}/threads`;
      const fresh = mintBoardWidgetToken(grant, key);
      expect((await onDoor(base, path, { token: fresh })).status).toBe(200);
      const stale = mintBoardWidgetToken(grant, key, Date.now() - BOARD_WIDGET_TOKEN_TTL_MS - 1000);
      expect((await onDoor(base, path, { token: stale })).status).toBe(401);
    });
  });

  describe('nothing else is on the door', () => {
    const elsewhere = (): Array<[string, string]> => [
      ['POST', '/api/deploy'],
      ['GET', '/api/deploy'],
      ['POST', '/api/plugin/refresh'],
      ['GET', '/api/agents/agent-1/token'],
      ['GET', '/events/agent/agent-1'],
      ['GET', '/api/share'],
      ['POST', '/api/share/link'],
      ['GET', '/share/some-slug'],
      ['GET', '/'],
      ['GET', '/workspaces'],
      ['GET', `/workspaces/${boardA}?format=json`],
      ['GET', `/workspaces/${boardA}/tasks`],
      ['GET', `/workspaces/${boardA}/docs`],
      ['GET', `/workspaces/${boardA}/docs/${docA}?format=json`],
      ['GET', `/workspaces/${boardA}/docs/${docA}/events:stream`],
      ['GET', `/workspaces/${boardA}/events:stream`],
      ['GET', '/widget-auth'],
      ['POST', '/api/auth/widget-token'],
    ];

    it('answers 404 to every other route, even with a valid board token', async () => {
      for (const [method, path] of elsewhere()) {
        const body = method === 'POST' ? {} : undefined;
        const res = await onDoor(base, path, { method, token: tokenA, body });
        expect(res.status, `${method} ${path}`).toBe(404);
      }
    });

    it("refuses the board's own room socket", async () => {
      const res = await doorSocket(base, `/workspaces/${boardA}/y`, tokenA);
      expect(res.status).toBe(404);
    });

    it('is not a door at all through the Cloudflare edge', async () => {
      const res = await onDoor(base, `/workspaces/${boardA}/docs/${docA}/threads`, {
        token: tokenA,
        headers: CF_RAY,
      });
      expect(res.status).toBe(403);
    });
  });

  describe('the mint', () => {
    it('refuses a page origin that is not on the door', async () => {
      for (const origin of [
        'http://harborlight.test:8994',
        `http://${DOOR}.evil.example:8994`,
        `http://app.${DOOR}:8994`,
        `${PAGE}/page`,
      ]) {
        const res = await mint(base, { origin, workspaceId: boardA });
        expect(res.status, origin).not.toBe(200);
        expect(((await res.json()) as { token?: string }).token, origin).toBeUndefined();
      }
    });

    it('refuses a board that does not exist, or none', async () => {
      expect((await mint(base, { origin: PAGE, workspaceId: 'w-nope' })).status).toBe(400);
      expect((await mint(base, { origin: PAGE })).status).toBe(400);
    });

    it('refuses a caller Access did not prove', async () => {
      const res = await mint(base, { origin: PAGE, workspaceId: boardA }, false);
      expect(res.status).not.toBe(200);
    });

    it('names the board and the origin in what it hands back', async () => {
      const res = await mint(base, { origin: PAGE, workspaceId: boardA });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        ok: true,
        origin: PAGE,
        user: { id: emailIdentityId(OPERATOR_EMAIL) },
      });
    });
  });
});

describe('a watermark-revoked board token', () => {
  it('is refused once the identity’s sessions are cut off, and served before', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'widget-door-watermark-'));
    try {
      const first = boot(dataDir);
      const board = await seedBoard(first.base, { name: 'Riverbend' });
      const token = await mintFor(first.base, board);
      const probe = (b: string) => onDoor(b, '/api/auth/widget-session', { token });
      expect((await probe(first.base)).status).toBe(200);
      await first.handle.stop();

      // What "sign out everywhere" and archiving both do: move the watermark
      // past every token already minted.
      const rosterPath = join(dataDir, 'identities.json');
      const roster = JSON.parse(readFileSync(rosterPath, 'utf8')) as {
        identities: Record<string, { sessionsValidFrom: number }>;
      };
      const row = roster.identities[emailIdentityId(OPERATOR_EMAIL)];
      expect(row).toBeTruthy();
      (row as { sessionsValidFrom: number }).sessionsValidFrom = Date.now() + 60_000;
      writeFileSync(rosterPath, JSON.stringify(roster));

      const second = boot(dataDir);
      try {
        expect((await probe(second.base)).status).toBe(401);
      } finally {
        await second.handle.stop();
      }
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
