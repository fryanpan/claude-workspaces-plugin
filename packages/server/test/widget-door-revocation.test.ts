/**
 * What ends a board widget token (`wt2`) beyond a single request: an open door
 * socket is hung up once its token stops verifying, and no session cookie can
 * mint one, since no logout could end it afterwards.
 *
 * Fixtures are fictional hosts and names; the repo is public.
 */
import { afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emailIdentityId } from '@claude-workspaces/core';
import { type JWK, SignJWT, exportJWK, generateKeyPair } from 'jose';
import { SESSION_COOKIE, mintSession, sessionKey, signSession } from '../src/auth/session.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { loadCookieKey } from '../src/share/link-session.ts';
import { ACCESS_SHARE_CONFIG, mockCfApi } from './access-share.ts';
import { waitFor } from './wait-for.ts';

const TEAM_DOMAIN = 'test.cloudflareaccess.com';
const AUD = 'aud-for-the-operator-app';
const OPERATOR_HOST = 'operator.example.com';
const OPERATOR_EMAIL = 'operator@example.com';
const DOOR = 'tailnet-host.test';
const PAGE = `http://${DOOR}:8994`;

let jwt = '';
let cfAccess: unknown;
const cleanups: Array<() => Promise<void> | void> = [];

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = (await exportJWK(publicKey)) as JWK;
  Object.assign(jwk, { kid: 'door-revocation', alg: 'RS256', use: 'sig' });
  cfAccess = { teamDomain: TEAM_DOMAIN, audience: AUD, jwks: { keys: [jwk] } };
  jwt = await new SignJWT({ email: OPERATOR_EMAIL })
    .setProtectedHeader({ alg: 'RS256', kid: 'door-revocation' })
    .setIssuer(`https://${TEAM_DOMAIN}`)
    .setAudience(AUD)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + 600)
    .setSubject('cf-access-operator')
    .sign(privateKey);
});

afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

function boot(): { handle: ServerHandle; base: string; dataDir: string; board: string } {
  const dataDir = mkdtempSync(join(tmpdir(), 'widget-door-revocation-'));
  const dist = mkdtempSync(join(tmpdir(), 'widget-door-revocation-dist-'));
  writeFileSync(join(dist, 'widget.iife.js'), '/* the widget */');
  const handle = createServer({
    port: 0,
    dataDir,
    cfAccess,
    share: { config: ACCESS_SHARE_CONFIG, cfApi: mockCfApi() },
    proxiedTrustedHosts: [OPERATOR_HOST],
    proxiedTrustedEmails: [OPERATOR_EMAIL],
    widgetDoorHosts: [DOOR],
    widgetDistDir: dist,
  } as Parameters<typeof createServer>[0]);
  cleanups.push(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(dist, { recursive: true, force: true });
  });
  const board = handle.tasks.createWorkspace('Riverbend').id;
  return { handle, base: `http://127.0.0.1:${handle.port}`, dataDir, board };
}

/** The sign-in popup's mint, as the operator's host sends it through the tunnel. */
function mintThroughAccess(base: string, board: string): Promise<Response> {
  return fetch(`${base}/api/auth/widget-token`, {
    method: 'POST',
    headers: {
      host: OPERATOR_HOST,
      'cf-ray': '8a1b2c3d4e5f-SJC',
      'x-forwarded-proto': 'https',
      origin: `https://${OPERATOR_HOST}`,
      'cf-access-jwt-assertion': jwt,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ origin: PAGE, workspaceId: board }),
  });
}

/** A door socket on one of the doc's two verbs, opened and watched. */
function openDoorSocket(
  base: string,
  board: string,
  verb: 'y' | 'voice',
  token: string,
): { ws: WebSocket; closed: { code: number | null }; opened: Promise<void> } {
  const url = `${base.replace('http', 'ws')}/workspaces/${board}/docs/doc-door/${verb}?type=mockup&sourceUrl=${encodeURIComponent(`${PAGE}/`)}`;
  const ws = new WebSocket(url, {
    headers: { host: `${DOOR}:8960`, origin: PAGE },
    protocols: [token],
  } as unknown as string[]);
  const closed: { code: number | null } = { code: null };
  ws.addEventListener('close', (ev) => {
    closed.code = (ev as CloseEvent).code;
  });
  const opened = new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', () => reject(new Error(`door ${verb} socket never opened`)));
  });
  return { ws, closed, opened };
}

describe('an open tailnet widget door socket', () => {
  it('is hung up by the sweep once its token stops verifying, and left open before', async () => {
    const { handle, base, board } = boot();
    const minted = await mintThroughAccess(base, board);
    expect(minted.status).toBe(200);
    const { token } = (await minted.json()) as { token: string };

    const { ws, closed, opened } = openDoorSocket(base, board, 'y', token);
    await opened;

    // Control: a sweep while the token is live leaves the socket alone.
    handle.sweepDeadShares();
    const stillOpen = await Promise.race([
      new Promise<'closed'>((r) => ws.addEventListener('close', () => r('closed'))),
      new Promise<'open'>((r) => setTimeout(() => r('open'), 200)), // timed: a live token's socket survives a sweep
    ]);
    expect(stillOpen).toBe('open');

    // Archiving the identity is one of the three things the token dies of;
    // the sweep asks the same verifier the upgrade did.
    handle.identities.archive(emailIdentityId(OPERATOR_EMAIL));
    handle.sweepDeadShares();
    await waitFor(() => closed.code !== null);
    expect(closed.code).toBe(1008);
  });

  /**
   * The recorder's socket is the one that costs money while it is open — it
   * spends a transcription engine on the owner's key — and it is in no doc's
   * `conns`, so the sweep can only reach it if the upgrade tracked it. Every
   * `/y` assertion above would pass with that tracking missing.
   */
  it('is hung up on the recorder’s socket too, and left open before', async () => {
    const { handle, base, board } = boot();
    const minted = await mintThroughAccess(base, board);
    expect(minted.status).toBe(200);
    const { token } = (await minted.json()) as { token: string };

    // The doc has to exist before the voice socket will take the upgrade,
    // and the widget's own first socket is what makes it.
    const live = openDoorSocket(base, board, 'y', token);
    await live.opened;

    const { closed, opened, ws } = openDoorSocket(base, board, 'voice', token);
    await opened;

    handle.sweepDeadShares();
    const stillOpen = await Promise.race([
      new Promise<'closed'>((r) => ws.addEventListener('close', () => r('closed'))),
      new Promise<'open'>((r) => setTimeout(() => r('open'), 200)), // timed: a live token's socket survives a sweep
    ]);
    expect(stillOpen).toBe('open');

    handle.identities.archive(emailIdentityId(OPERATOR_EMAIL));
    handle.sweepDeadShares();
    await waitFor(() => closed.code !== null);
    expect(closed.code).toBe(1008);
  });
});

describe('the board token mint', () => {
  it('refuses a caller proven only by a session cookie, which Access-proven callers pass', async () => {
    const { handle, base, dataDir, board } = boot();
    const person = handle.identities.upsertByEmail(OPERATOR_EMAIL);
    const cookie = `${SESSION_COOKIE}=${signSession(mintSession(person.id), sessionKey(loadCookieKey(dataDir)))}`;
    const local = `127.0.0.1:${handle.port}`;
    const res = await fetch(`${base}/api/auth/widget-token`, {
      method: 'POST',
      headers: {
        host: local,
        origin: `http://${local}`,
        cookie,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ origin: PAGE, workspaceId: board }),
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { token?: string }).token).toBeUndefined();
    // The cookie is live — the same server attributes it on the session probe.
    const me = await fetch(`${base}/api/auth/session`, { headers: { host: local, cookie } });
    expect(((await me.json()) as { authenticated: boolean }).authenticated).toBe(true);
    // Control: the same mint through Access gets its token.
    expect((await mintThroughAccess(base, board)).status).toBe(200);
  });
});
