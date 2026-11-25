/**
 * The local test sign-in (`CW_TEST_SIGNIN=1`, `auth/test-signin.ts`): Alice
 * and Bob sign in to a staging server through a fake Google that runs in the
 * same process, so no Google account and no secret is needed. And the three
 * refusals that keep it off anything real: prod's port, a request that came
 * through Cloudflare, and a real Google client.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  TEST_SIGNIN_HOST,
  TEST_SIGNIN_OWNER,
  type TestGoogle,
  startTestGoogle,
  testSignInFromEnv,
  testSignInOptions,
} from '../src/auth/test-signin.ts';
import { classifyHost } from '../src/middleware/host-guard.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { CookieJar } from './google-stub.ts';

const PORT = 8796;
const ON = { CW_TEST_SIGNIN: '1' };
const LOOPBACK = { port: PORT, bindHost: '127.0.0.1' };
const ALICE = 'alice@harborlight.test';
const BOB = 'bob@harborlight.test';
const CF_RAY = { 'cf-ray': '8a1b2c3d4e5f-SJC', 'x-forwarded-proto': 'https' };

describe('testSignInFromEnv', () => {
  it('is off unless asked for', () => {
    expect(testSignInFromEnv({}, LOOPBACK)).toEqual({ setting: null });
    expect(testSignInFromEnv({ CW_TEST_SIGNIN: '0' }, LOOPBACK)).toEqual({ setting: null });
  });

  it('on a staging port and loopback, signs in on the .localhost origin with its port', () => {
    const resolved = testSignInFromEnv(ON, LOOPBACK);
    if (!('setting' in resolved) || !resolved.setting) throw new Error(JSON.stringify(resolved));
    expect(resolved.setting.origin).toBe(`http://${TEST_SIGNIN_HOST}:${PORT}`);
    expect(resolved.setting.owner).toBe(ALICE);
  });

  it("refuses prod's port", () => {
    const resolved = testSignInFromEnv(ON, { port: 8787, bindHost: '127.0.0.1' });
    expect('error' in resolved && resolved.error).toContain('8787');
  });

  it('refuses when a real Google client id or secret is set', () => {
    for (const google of [
      { CW_GOOGLE_CLIENT_ID: 'riverbend.apps.example' },
      { CW_GOOGLE_CLIENT_SECRET: 'fixture-Saltmarsh' },
    ]) {
      const resolved = testSignInFromEnv({ ...ON, ...google }, LOOPBACK);
      expect('error' in resolved && resolved.error).toContain('CW_GOOGLE_CLIENT_ID');
    }
  });

  it('refuses a value other than 1, and port 0', () => {
    expect('error' in testSignInFromEnv({ CW_TEST_SIGNIN: 'yes' }, LOOPBACK)).toBe(true);
    expect('error' in testSignInFromEnv(ON, { port: 0, bindHost: '127.0.0.1' })).toBe(true);
  });

  it('CONTROL: runs beside CW_SIGNIN=access, the default', () => {
    const resolved = testSignInFromEnv({ ...ON, CW_SIGNIN: 'access' }, LOOPBACK);
    expect('setting' in resolved && resolved.setting !== null).toBe(true);
  });

  it('refuses beside another CW_SIGNIN mode', () => {
    const resolved = testSignInFromEnv({ ...ON, CW_SIGNIN: 'both' }, LOOPBACK);
    expect('error' in resolved && resolved.error).toContain('CW_SIGNIN');
  });

  it('refuses a bind wider than loopback, and an unnamed bind (the wildcard)', () => {
    for (const bindHost of ['0.0.0.0', undefined]) {
      const resolved = testSignInFromEnv(ON, { port: PORT, bindHost });
      expect('error' in resolved && resolved.error).toContain('loopback');
    }
  });
});

describe('the sign-in address in the host guard', () => {
  // The option set the server runs with: the setting's own operator list,
  // armed as it is at run time.
  const { proxiedTrustedHosts } = testSignInOptions(
    { origin: `http://${TEST_SIGNIN_HOST}:${PORT}`, owner: TEST_SIGNIN_OWNER },
    { authorizationUrl: '', tokenUrl: '', userInfoUrl: '' },
  );
  const classify = (viaProxy: boolean, loopbackPeer: boolean) =>
    classifyHost(`${TEST_SIGNIN_HOST}:${PORT}`, {
      accessOnly: true,
      accessFronted: true,
      viaProxy,
      loopbackPeer,
      proxiedTrustedHosts,
      localSignInHosts: [TEST_SIGNIN_HOST],
      lookupShare: () => null,
    }).kind;

  it('is a signed-in person only from this machine and off the edge', () => {
    expect(classify(false, true)).toBe('proxied-local');
    expect(classify(true, true)).toBe('deny');
    expect(classify(false, false)).toBe('deny');
  });
});

describe('a server running the test sign-in', () => {
  let dataDir: string;
  let google: TestGoogle;
  let server: ServerHandle;
  let board: string;
  const origin = `http://${TEST_SIGNIN_HOST}:${PORT}`;

  /** A browser on the sign-in address. The Host carries the port, as a browser's does. */
  const browser = (path: string, init: RequestInit = {}) =>
    fetch(`http://127.0.0.1:${server.port}${path}`, {
      redirect: 'manual',
      ...init,
      headers: {
        host: `${TEST_SIGNIN_HOST}:${PORT}`,
        ...((init.headers as Record<string, string>) ?? {}),
      },
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

  /** Press "Continue with Google", pick `who` on the fake Google page, come back. */
  const signInAs = async (who: 'alice' | 'bob', jar = new CookieJar()) => {
    const start = await browser('/auth/sign-in/google', {
      method: 'POST',
      // One rate-limit bucket per browser, as `CookieJar` keys them.
      headers: {
        origin,
        'content-type': 'application/x-www-form-urlencoded',
        'cf-connecting-ip': jar.ip,
      },
      body: new URLSearchParams({ next: '/workspaces' }).toString(),
    });
    expect(start.status, await start.clone().text()).toBe(303);
    jar.take(start);
    const authorize = new URL(start.headers.get('location') ?? '');
    const page = await fetch(authorize, { redirect: 'manual' });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain(ALICE);
    expect(html).toContain(BOB);
    const chose = await fetch(new URL('/choose', authorize), {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        person: who,
        state: authorize.searchParams.get('state') ?? '',
        redirect_uri: authorize.searchParams.get('redirect_uri') ?? '',
      }).toString(),
    });
    expect(chose.status).toBe(303);
    const back = new URL(chose.headers.get('location') ?? '');
    expect(back.origin).toBe(origin);
    const callback = await browser(`${back.pathname}${back.search}`, {
      headers: { cookie: jar.header(), 'cf-connecting-ip': jar.ip },
    });
    jar.take(callback);
    return { jar, callback };
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'test-signin-'));
    const resolved = testSignInFromEnv(ON, LOOPBACK);
    if (!('setting' in resolved) || !resolved.setting) throw new Error('test sign-in refused');
    google = startTestGoogle(resolved.setting);
    const opts = testSignInOptions(resolved.setting, google.endpoints);
    server = createServer({ port: 0, dataDir, ...opts });
    const created = await local('/workspaces', {
      method: 'POST',
      body: JSON.stringify({ name: 'Harborlight partners' }),
    });
    expect(created.status).toBe(200);
    board = ((await created.json()) as { workspace: { id: string } }).workspace.id;
  });

  afterAll(async () => {
    await server.stop();
    google.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('signs Alice in as the owner', async () => {
    const { jar, callback } = await signInAs('alice');
    expect(callback.status).toBe(302);
    expect(callback.headers.get('location')).toBe('/workspaces');
    const res = await browser(`/workspaces/${board}?format=json`, {
      headers: { cookie: jar.header() },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Harborlight partners');
  });

  it('signs Bob in as somebody else, who reaches no board until one is shared', async () => {
    const { jar, callback } = await signInAs('bob');
    expect(callback.status).toBe(302);
    expect(jar.cookies.has('__Host-cw-ba.session_token')).toBe(true);
    const session = await browser('/api/auth/get-session', { headers: { cookie: jar.header() } });
    expect(((await session.json()) as { user: { email: string } }).user.email).toBe(BOB);
    const res = await browser(`/workspaces/${board}?format=json`, {
      headers: { cookie: jar.header() },
    });
    expect(res.status).toBe(403);
  });

  it('refuses the sign-in page on a request that came through Cloudflare', async () => {
    const res = await browser('/auth/sign-in', { headers: CF_RAY });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'unknown_host' });
    // CONTROL: the same request without cf-ray is the page.
    expect((await browser('/auth/sign-in')).status).toBe(200);
  });

  it("refuses Alice's own session when the request came through Cloudflare", async () => {
    const { jar } = await signInAs('alice');
    const res = await browser(`/workspaces/${board}?format=json`, {
      headers: { cookie: jar.header(), ...CF_RAY },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'unknown_host' });
  });

  it('the fake Google refuses cf-ray and a return address that is not the sign-in callback', async () => {
    const start = await browser('/auth/sign-in/google', {
      method: 'POST',
      headers: {
        origin,
        'content-type': 'application/x-www-form-urlencoded',
        'cf-connecting-ip': new CookieJar().ip,
      },
      body: 'next=%2F',
    });
    expect(start.status, await start.clone().text()).toBe(303);
    const authorize = new URL(start.headers.get('location') ?? '');
    expect((await fetch(authorize, { headers: CF_RAY })).status).toBe(403);
    const elsewhere = new URL(authorize);
    elsewhere.searchParams.set('redirect_uri', 'https://riverbend.test/api/auth/callback/google');
    expect((await fetch(elsewhere)).status).toBe(400);
  });

  // With no CW_OWNER_EMAIL, the setting alone makes Alice the owner, so her
  // Add on the board page lets Bob in rather than filing an agent's proposal.
  it("lets Alice add Bob from the board's page with no CW_OWNER_EMAIL", async () => {
    const { jar } = await signInAs('alice');
    const res = await browser(`/workspaces/${board}/audience`, {
      method: 'POST',
      headers: {
        cookie: jar.header(),
        origin,
        'sec-fetch-site': 'same-origin',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ add: [BOB] }),
    });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(((await res.json()) as { added: string[] }).added).toEqual([BOB]);
  });
});
