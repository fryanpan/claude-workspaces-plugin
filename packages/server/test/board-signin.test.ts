/**
 * Better Auth inside the server (plan step 1): the module on its own, driven
 * through its own request handler against a local Google stub.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keptCookies, setsDomainCookie } from '../../../infra/board-router-worker/worker.js';
import {
  type BoardSignIn,
  createBoardSignIn,
  ownRateLimitStore,
  safeNext,
  signInSecret,
} from '../src/auth/board-signin.ts';
import { loadCookieKey } from '../src/share/link-session.ts';
import {
  CookieJar,
  type GoogleStub,
  type Send,
  signInWithGoogle,
  startGoogleStub,
} from './google-stub.ts';

const ORIGIN = 'https://riverbend-workspaces.harborlight.test';
const ALICE = 'alice@harborlight.test';
const BOB = 'bob@saltmarsh.test';

describe('Better Auth inside the server', () => {
  const dirs: string[] = [];
  let google: GoogleStub;
  let signIn: BoardSignIn;
  let dataDir: string;
  const allowed = new Set([ALICE]);

  const tmp = () => {
    const d = mkdtempSync(join(tmpdir(), 'board-signin-'));
    dirs.push(d);
    return d;
  };
  const sendTo =
    (s: BoardSignIn): Send =>
    async (path, init = {}) =>
      (await s.handle(new Request(`${s.origin}${path}`, init), new URL(path, s.origin).pathname)) ??
      new Response('not claimed', { status: 404 });

  beforeAll(() => {
    google = startGoogleStub();
    dataDir = tmp();
    signIn = createBoardSignIn({
      dataDir,
      baseKey: loadCookieKey(dataDir),
      origin: ORIGIN,
      google: {
        clientId: 'shared-client',
        clientSecret: 'stub-secret',
        endpoints: google.endpoints,
      },
      mayHaveAccount: (email, verified) => verified && allowed.has(email),
    });
  });

  afterAll(() => {
    signIn.close();
    google.stop();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it('signs a shared address in, and every cookie it sets is __Host-, Secure and host-only', async () => {
    const jar = new CookieJar();
    const { callback } = await signInWithGoogle(sendTo(signIn), ORIGIN, jar, google, {
      sub: 'g-alice',
      email: ALICE,
      email_verified: true,
      name: 'Alice',
      hd: 'harborlight.test',
    });
    expect(callback.status).toBe(302);
    expect(jar.seen.length).toBeGreaterThan(0);
    for (const raw of jar.seen) {
      expect(raw.startsWith('__Host-cw-ba.')).toBe(true);
      expect(raw).toMatch(/;\s*Secure/i);
      expect(raw).toMatch(/;\s*Path=\//i);
      expect(raw).not.toMatch(/;\s*Domain=/i);
      // The router drops a parent-domain cookie on the way back, and keeps
      // only `__Host-` names (and four others) on the way in.
      expect(setsDomainCookie(raw)).toBe(false);
    }
    const header = jar.header();
    expect(header).toContain('__Host-cw-ba.session_token=');
    expect(keptCookies(header)).toBe(header);

    const person = await signIn.personOf(new Request(ORIGIN, { headers: { cookie: header } }));
    expect(person?.email).toBe(ALICE);
    expect(person?.emailVerified).toBe(true);
    expect(person?.hd).toBe('harborlight.test');
  });

  it('asks Google for the account picker with the shared client and its own return address', async () => {
    const jar = new CookieJar();
    const { authorize } = await signInWithGoogle(sendTo(signIn), ORIGIN, jar, google, {
      sub: 'g-alice',
      email: ALICE,
      email_verified: true,
      name: 'Alice',
    });
    expect(authorize.searchParams.get('client_id')).toBe('shared-client');
    expect(authorize.searchParams.get('prompt')).toBe('select_account');
    expect(authorize.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/api/auth/callback/google`);
  });

  it('makes no account for an address no board is shared with', async () => {
    const jar = new CookieJar();
    await signInWithGoogle(sendTo(signIn), ORIGIN, jar, google, {
      sub: 'g-bob',
      email: BOB,
      email_verified: true,
      name: 'Bob',
    });
    expect(jar.cookies.has('__Host-cw-ba.session_token')).toBe(false);
    const person = await signIn.personOf(
      new Request(ORIGIN, { headers: { cookie: jar.header() } }),
    );
    expect(person).toBeNull();
  });

  it('refuses an ID token posted straight to the social sign-in route', async () => {
    const res = await sendTo(signIn)('/api/auth/sign-in/social', {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'google', idToken: { token: 'header.payload.sig' } }),
    });
    expect(res.status).toBe(400);
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it('refuses the Google button posted from another origin', async () => {
    const res = await sendTo(signIn)('/auth/sign-in/google', {
      method: 'POST',
      headers: {
        origin: 'https://saltmarsh.test',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: 'next=%2F',
    });
    expect(res.status).toBe(403);
  });

  it('claims only its own paths', async () => {
    const res = await signIn.handle(new Request(`${ORIGIN}/api/auth/session`), '/api/auth/session');
    expect(res).toBeNull();
    const admin = await signIn.handle(
      new Request(`${ORIGIN}/api/auth/sign-up/email`, { method: 'POST' }),
      '/api/auth/sign-up/email',
    );
    expect(admin).toBeNull();
  });

  it('limits how often one address may start a sign-in', async () => {
    const start = () =>
      sendTo(signIn)('/auth/sign-in/google', {
        method: 'POST',
        headers: {
          origin: ORIGIN,
          'content-type': 'application/x-www-form-urlencoded',
          // A documentation address (TEST-NET-3), as Cloudflare would set it.
          'cf-connecting-ip': '203.0.113.7',
        },
        body: 'next=%2F',
      });
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) statuses.push((await start()).status);
    expect(statuses.slice(0, 3)).toEqual([303, 303, 303]);
    expect(statuses[3]).toBe(429);
  });

  it('counts each key in its own window', async () => {
    let t = 0;
    const store = ownRateLimitStore(() => t);
    const rule = { window: 10, max: 2 };
    expect((await store.consume('a', rule)).allowed).toBe(true);
    expect((await store.consume('a', rule)).allowed).toBe(true);
    expect(await store.consume('a', rule)).toEqual({ allowed: false, retryAfter: 10 });
    expect((await store.consume('b', rule)).allowed).toBe(true);
    t = 10_000;
    expect((await store.consume('a', rule)).allowed).toBe(true);
  });

  it('keeps its user list readable only by the server', () => {
    expect(statSync(join(dataDir, 'signin.sqlite')).mode & 0o777).toBe(0o600);
  });

  it('two data directories derive two different secrets', () => {
    const a = loadCookieKey(tmp());
    const b = loadCookieKey(tmp());
    expect(signInSecret(a)).not.toBe(signInSecret(b));
    // CONTROL: one key file derives one secret, every time.
    expect(signInSecret(a)).toBe(signInSecret(a));
    // And never the key file itself, nor another protocol's key.
    expect(signInSecret(a)).not.toBe(a);
  });

  it('comes back only to a path on its own origin', () => {
    expect(safeNext('/workspaces/w1')).toBe('/workspaces/w1');
    expect(safeNext('//saltmarsh.test/x')).toBe('/');
    expect(safeNext('https://saltmarsh.test/')).toBe('/');
    expect(safeNext('/\\saltmarsh.test')).toBe('/');
    expect(safeNext(undefined)).toBe('/');
  });
});
