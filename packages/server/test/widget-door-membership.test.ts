/**
 * Who a board widget token (`wt2`) may belong to: the board's owner, or a
 * person whose role on THAT board lets them comment. Checked when the token is
 * minted and again on every use, because membership can end inside its 24h.
 *
 * Collaborators are Access-proved too, so "Cloudflare vouched for this email"
 * is never enough on its own. Every refusal here is paired with a request that
 * succeeds, so nothing passes on a server that refuses everything.
 *
 * Fixtures are fictional hosts and names; the repo is public.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type JWK, SignJWT, exportJWK, generateKeyPair } from 'jose';
import { mintBoardWidgetToken, widgetTokenKey } from '../src/auth/widget-token.ts';
import { type ServerHandle, type ServerOptions, createServer } from '../src/server.ts';
import { loadCookieKey } from '../src/share/link-session.ts';
import { ACCESS_SHARE_CONFIG, mockCfApi } from './access-share.ts';
import { waitFor } from './wait-for.ts';

const TEAM_DOMAIN = 'test.cloudflareaccess.com';
const KID = 'door-membership-kid';
const OWNER_AUD = 'aud-for-the-owner-app';
const SHARE_AUD = 'aud-for-the-share-app';
const OPERATOR_HOST = 'operator.example.test';
const COLLAB_HOST = 'collab.example.test';
const SHARE_HOST = 'share.example.test';
const DOOR = 'tailnet-host.test';
const PAGE = `http://${DOOR}:8994`;
const CF_RAY = { 'cf-ray': '8a1b2c3d4e5f-SJC' };

const OPERATOR = 'operator@example.test';
/** A member of Riverbend through a share link, at the default level. */
const MEMBER = 'keeper@harborlight.example';
/** Access-proved, and a member of nothing. */
const STRANGER = 'guest@saltmarsh.example';

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
const threadBody = {
  author: { id: 'known-harborlight', name: 'Harborlight', kind: 'known', color: '#2e7dd7' },
  text: 'the header overlaps the menu',
  anchor,
};

let jwks: { keys: JWK[] };
let signJwt: (aud: string, email: string) => Promise<string>;
let dist = '';
const cleanups: Array<() => Promise<void> | void> = [];

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = (await exportJWK(publicKey)) as JWK;
  Object.assign(jwk, { kid: KID, alg: 'RS256', use: 'sig' });
  jwks = { keys: [jwk] };
  signJwt = (aud, email) =>
    new SignJWT({ email })
      .setProtectedHeader({ alg: 'RS256', kid: KID })
      .setIssuer(`https://${TEAM_DOMAIN}`)
      .setAudience(aud)
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 600)
      .setSubject('cf-access-door-membership')
      .sign(privateKey);
  dist = mkdtempSync(join(tmpdir(), 'door-membership-dist-'));
  writeFileSync(join(dist, 'widget.iife.js'), '/* the widget */');
});

afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

afterAll(() => rmSync(dist, { recursive: true, force: true }));

interface Booted {
  handle: ServerHandle;
  base: string;
  dataDir: string;
  riverbend: string;
  saltmarsh: string;
}

function boot(extra: Partial<ServerOptions>): Booted {
  const dataDir = mkdtempSync(join(tmpdir(), 'door-membership-'));
  const handle = createServer({
    port: 0,
    dataDir,
    cfAccess: { teamDomain: TEAM_DOMAIN, audience: OWNER_AUD, jwks },
    proxiedTrustedEmails: [OPERATOR],
    widgetDoorHosts: [DOOR],
    widgetDistDir: dist,
    ...extra,
  } as ServerOptions);
  cleanups.push(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });
  return {
    handle,
    base: `http://127.0.0.1:${handle.port}`,
    dataDir,
    riverbend: handle.tasks.createWorkspace('Riverbend').id,
    saltmarsh: handle.tasks.createWorkspace('Saltmarsh').id,
  };
}

/** Prod's shape: the operator's Access host, a collaboration host, a share hostname. */
function bootShared(): Booted {
  return boot({
    share: { config: ACCESS_SHARE_CONFIG, cfApi: mockCfApi() },
    proxiedTrustedHosts: [OPERATOR_HOST],
    accessTunnelHosts: [COLLAB_HOST],
    shareLinkHosts: [SHARE_HOST],
    shareLinkAudience: SHARE_AUD,
  });
}

/** POST as `email` on `host`, holding an Access token for `aud`. */
async function viaAccess(
  s: Booted,
  host: string,
  aud: string,
  email: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return fetch(`${s.base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    redirect: 'manual',
    headers: {
      host,
      ...CF_RAY,
      'x-forwarded-proto': 'https',
      'cf-access-jwt-assertion': await signJwt(aud, email),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const mintOn = (s: Booted, host: string, aud: string, email: string, board: string) =>
  viaAccess(s, host, aud, email, '/api/auth/widget-token', { origin: PAGE, workspaceId: board });

async function tokenOf(res: Response): Promise<string | undefined> {
  const text = await res.text();
  try {
    return (JSON.parse(text) as { token?: string }).token;
  } catch {
    return undefined;
  }
}

/** Make `email` a member of `board` the way a person becomes one: redeem a link. */
async function redeem(s: Booted, board: string, email: string): Promise<void> {
  const minted = await fetch(`${s.base}/api/share/workspace`, {
    method: 'POST',
    headers: { host: `localhost:${s.handle.port}`, 'content-type': 'application/json' },
    body: JSON.stringify({ workspaceId: board }),
  });
  expect(minted.status, await minted.clone().text()).toBe(200);
  const { link } = (await minted.json()) as { link: { linkId: string } };
  expect((await viaAccess(s, SHARE_HOST, SHARE_AUD, email, `/s/${link.linkId}`)).status).toBe(302);
}

/** A board token signed with this server's own key, as if a mint had issued it. */
function signedToken(s: Booted, email: string, board: string): string {
  const person = s.handle.identities.upsertByEmail(email);
  return mintBoardWidgetToken(
    { identityId: person.id, workspaceId: board, origin: PAGE },
    widgetTokenKey(loadCookieKey(s.dataDir)),
  );
}

function onDoor(s: Booted, path: string, token: string, body?: unknown): Promise<Response> {
  return fetch(`${s.base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      host: `${DOOR}:8960`,
      origin: PAGE,
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** The widget's first socket, which is what brings the page's doc into being. */
async function openDoc(s: Booted, board: string, token: string): Promise<void> {
  const res = await fetch(
    `${s.base}/workspaces/${board}/docs/doc-door/y?type=mockup&sourceUrl=${encodeURIComponent(`${PAGE}/`)}`,
    {
      headers: {
        host: `${DOOR}:8960`,
        origin: PAGE,
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'sec-websocket-protocol': token,
      },
    },
  );
  expect(res.status).toBe(101);
}

describe('minting a board token', () => {
  it('is refused to a collaborator on every host they can reach, member or not', async () => {
    const s = bootShared();
    await redeem(s, s.riverbend, MEMBER);
    // Control: the member's Access token is live and their membership is real —
    // they read Riverbend's members on the share hostname, and not Saltmarsh's.
    const members = (b: string) =>
      viaAccess(s, SHARE_HOST, SHARE_AUD, MEMBER, `/workspaces/${b}/members`);
    expect((await members(s.riverbend)).status).toBe(200);
    expect((await members(s.saltmarsh)).status).not.toBe(200);

    const attempts: Array<[string, string, string]> = [
      [SHARE_HOST, SHARE_AUD, s.riverbend],
      [SHARE_HOST, SHARE_AUD, s.saltmarsh],
      [COLLAB_HOST, OWNER_AUD, s.riverbend],
      [COLLAB_HOST, OWNER_AUD, s.saltmarsh],
      [OPERATOR_HOST, OWNER_AUD, s.riverbend],
      [OPERATOR_HOST, OWNER_AUD, s.saltmarsh],
    ];
    for (const [host, aud, board] of attempts) {
      const res = await mintOn(s, host, aud, MEMBER, board);
      expect([host, board, res.status]).toEqual([host, board, expect.any(Number)]);
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(await tokenOf(res)).toBeUndefined();
    }
    // Control: the operator, through their own host, gets a token.
    const own = await mintOn(s, OPERATOR_HOST, OWNER_AUD, OPERATOR, s.riverbend);
    expect(own.status).toBe(200);
    expect(await tokenOf(own)).toMatch(/^wt2\./);
  });

  it('is refused to an Access-proved stranger where Access fronts the whole server', async () => {
    // No sharing surface at all: Cloudflare Access is the only gate, and its
    // policy may admit people who are not this board's owner.
    const s = boot({});
    const mint = async (email: string, board = s.riverbend) =>
      fetch(`${s.base}/api/auth/widget-token`, {
        method: 'POST',
        headers: {
          host: `127.0.0.1:${s.handle.port}`,
          'cf-access-jwt-assertion': await signJwt(OWNER_AUD, email),
          'content-type': 'application/json',
        },
        body: JSON.stringify({ origin: PAGE, workspaceId: board }),
      });
    const stranger = await mint(STRANGER);
    expect(stranger.status).toBe(403);
    expect(await tokenOf(stranger)).toBeUndefined();
    // The same answer for a board that does not exist: no telling ids apart.
    expect((await mint(STRANGER, 'w-nope')).status).toBe(403);
    const owner = await mint(OPERATOR);
    expect(owner.status).toBe(200);
    expect(await tokenOf(owner)).toMatch(/^wt2\./);
  });
});

describe('using a board token on the door', () => {
  it('refuses a token whose holder has no role on its board, to read or to comment', async () => {
    const s = bootShared();
    const threads = `/workspaces/${s.riverbend}/docs/doc-door/threads`;
    const owners = signedToken(s, OPERATOR, s.riverbend);
    await openDoc(s, s.riverbend, owners);
    const strangers = signedToken(s, STRANGER, s.riverbend);
    expect((await onDoor(s, threads, strangers)).status).toBe(401);
    expect((await onDoor(s, threads, strangers, threadBody)).status).toBe(401);
    // Control: the owner's token, signed the same way, reads and comments.
    expect((await onDoor(s, threads, owners)).status).toBe(200);
    expect((await onDoor(s, threads, owners, threadBody)).status).toBe(200);
    // And nothing the stranger sent landed: the one thread is the owner's.
    const listed = (await (await onDoor(s, threads, owners)).json()) as { threads: unknown[] };
    expect(listed.threads).toHaveLength(1);
  });

  it('admits a member while they are one, and refuses them and hangs up once removed', async () => {
    const s = bootShared();
    await redeem(s, s.riverbend, MEMBER);
    const token = signedToken(s, MEMBER, s.riverbend);
    const threads = `/workspaces/${s.riverbend}/docs/doc-door/threads`;
    await openDoc(s, s.riverbend, token);
    // A member's role on Riverbend lets them comment, so the door admits them.
    expect((await onDoor(s, threads, token)).status).toBe(200);

    const url = `${s.base.replace('http', 'ws')}/workspaces/${s.riverbend}/docs/doc-door/y?type=mockup&sourceUrl=${encodeURIComponent(`${PAGE}/`)}`;
    const ws = new WebSocket(url, {
      headers: { host: `${DOOR}:8960`, origin: PAGE },
      protocols: [token],
    } as unknown as string[]);
    const closed: { code: number | null } = { code: null };
    ws.addEventListener('close', (ev) => {
      closed.code = (ev as CloseEvent).code;
    });
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', () => reject(new Error('door socket never opened')));
    });

    const removed = await fetch(
      `${s.base}/workspaces/${s.riverbend}/members/${encodeURIComponent(MEMBER)}`,
      { method: 'DELETE', headers: { host: `localhost:${s.handle.port}` } },
    );
    expect(removed.status, await removed.clone().text()).toBe(200);

    expect((await onDoor(s, threads, token)).status).toBe(401);
    expect((await onDoor(s, threads, token, threadBody)).status).toBe(401);
    s.handle.sweepDeadShares();
    await waitFor(() => closed.code !== null);
    expect(closed.code).toBe(1008);
  });
});
