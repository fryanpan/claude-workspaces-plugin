/**
 * The lock-out guard (plan step 6, 3.5 step 3): a switch to
 * `CW_SIGNIN=better-auth` is refused until the owner has signed in here
 * through Better Auth. Until then the machine runs `both`, so the Access
 * stamp still opens the board; the owner's own sign-in writes the record,
 * and only then does the Access stamp stop counting. The record is read on
 * a loopback-only route, for a script that is about to remove Access.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type JSONWebKeySet, type JWK, SignJWT, exportJWK, generateKeyPair } from 'jose';
import { type ServerHandle, createServer } from '../src/server.ts';
import { ACCESS_SHARE_CONFIG, mockCfApi } from './access-share.ts';
import { CookieJar, type GoogleStub, signInWithGoogle, startGoogleStub } from './google-stub.ts';

const HOST = 'workspaces.harborlight.test';
const ORIGIN = `https://${HOST}`;
const OWNER = 'owner@harborlight.test';
const TEAM_DOMAIN = 'test.cloudflareaccess.com';
const AUD = 'aud-harborlight-app';
const TUNNEL = { 'cf-ray': '8a1b2c3d4e5f-SJC', 'x-forwarded-proto': 'https' };

interface OwnerRecordBody {
  recorded: boolean;
  owner?: { email: string; at: string };
  configured: string;
  effective: string;
}

describe('a switch to better-auth waits for the owner’s own sign-in', () => {
  let dataDir: string;
  let google: GoogleStub;
  let server: ServerHandle;
  let board: string;
  let jwks: JSONWebKeySet;
  let stamp: () => Promise<string>;

  const start = () =>
    createServer({
      port: 0,
      dataDir,
      cfAccess: { teamDomain: TEAM_DOMAIN, audience: AUD, jwks },
      proxiedTrustedHosts: [HOST],
      proxiedTrustedEmails: [OWNER],
      share: { config: ACCESS_SHARE_CONFIG, cfApi: mockCfApi() },
      signIn: {
        mode: 'better-auth',
        origin: ORIGIN,
        google: {
          clientId: 'shared-client',
          clientSecret: 'stub-secret',
          endpoints: google.endpoints,
        },
      },
    });
  const viaTunnel = (path: string, init: RequestInit = {}) =>
    fetch(`http://127.0.0.1:${server.port}${path}`, {
      redirect: 'manual',
      ...init,
      headers: { host: HOST, ...TUNNEL, ...((init.headers as Record<string, string>) ?? {}) },
    });
  const local = (path: string, init: RequestInit = {}) =>
    fetch(`http://127.0.0.1:${server.port}${path}`, {
      ...init,
      headers: {
        host: `localhost:${server.port}`,
        'content-type': 'application/json',
        ...((init.headers as Record<string, string>) ?? {}),
      },
    });
  const ownerRecord = async () => {
    const res = await local('/api/signin/owner');
    expect(res.status, await res.clone().text()).toBe(200);
    return (await res.json()) as OwnerRecordBody;
  };
  const boardOnStamp = async () =>
    viaTunnel(`/workspaces/${board}?format=json`, {
      headers: { 'cf-access-jwt-assertion': await stamp() },
    });

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'signin-lockout-guard-'));
    google = startGoogleStub();
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const jwk = (await exportJWK(publicKey)) as JWK;
    jwk.kid = 'guard-kid';
    jwk.alg = 'RS256';
    jwk.use = 'sig';
    jwks = { keys: [jwk] };
    stamp = () =>
      new SignJWT({ email: OWNER })
        .setProtectedHeader({ alg: 'RS256', kid: 'guard-kid' })
        .setIssuer(`https://${TEAM_DOMAIN}`)
        .setAudience(AUD)
        .setIssuedAt()
        .setExpirationTime(Math.floor(Date.now() / 1000) + 600)
        .sign(privateKey);
    server = start();
    const created = await local('/workspaces', {
      method: 'POST',
      body: JSON.stringify({ name: 'Harborlight board' }),
    });
    expect(created.status, await created.clone().text()).toBe(200);
    board = ((await created.json()) as { workspace: { id: string } }).workspace.id;
  });

  afterAll(async () => {
    await server.stop();
    google.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('before the owner signs in, the switch is refused: the machine runs both', async () => {
    expect(await ownerRecord()).toEqual({
      recorded: false,
      configured: 'better-auth',
      effective: 'both',
    });
  });

  it('so the Access stamp still opens the board', async () => {
    const res = await boardOnStamp();
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Harborlight board');
  });

  it('the owner’s Google sign-in writes the record, though Access still stamps every request', async () => {
    // Prod as it is while Access is in front: every request after the
    // sign-in carries an Access stamp AND the new session cookie. The stamp
    // admits first, so the record cannot wait for a session-only request.
    const jar = new CookieJar();
    await signInWithGoogle(viaTunnel, ORIGIN, jar, google, {
      sub: 'g-owner',
      email: OWNER,
      email_verified: true,
      name: 'Owner',
    });
    const res = await viaTunnel(`/workspaces/${board}?format=json`, {
      headers: { cookie: jar.header(), 'cf-access-jwt-assertion': await stamp() },
    });
    expect(res.status).toBe(200);
    const body = await ownerRecord();
    expect(body).toMatchObject({
      recorded: true,
      owner: { email: OWNER },
      configured: 'better-auth',
      effective: 'better-auth',
    });
  });

  it('after the switch, the Access stamp alone opens nothing', async () => {
    expect((await boardOnStamp()).status).toBe(401);
  });

  it('the record outlives a restart', async () => {
    await server.stop();
    server = start();
    expect((await ownerRecord()).effective).toBe('better-auth');
  });

  describe('the record is read on this machine only', () => {
    it('is refused through the edge', async () => {
      const res = await local('/api/signin/owner', { headers: TUNNEL });
      expect(res.status).toBe(403);
    });

    it('is read, not written', async () => {
      const res = await local('/api/signin/owner', { method: 'POST', body: '{}' });
      expect(res.status).toBe(405);
    });
  });
});
