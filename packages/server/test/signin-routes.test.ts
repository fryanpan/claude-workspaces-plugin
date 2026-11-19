/**
 * The sign-in routes and `CW_SIGNIN` (plan step 2), on a real server reached
 * the way the tunnel reaches it: the public Host, `cf-ray`, no Access stamp.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { CookieJar, type GoogleStub, signInWithGoogle, startGoogleStub } from './google-stub.ts';

const HOST = 'workspaces.harborlight.test';
const ORIGIN = `https://${HOST}`;
const OWNER = 'owner@harborlight.test';
/** A second owner address, never signed in verified. */
const SECOND_OWNER = 'second@harborlight.test';
/** What cloudflared adds to every request it forwards. */
const CF_RAY = { 'cf-ray': '8a1b2c3d4e5f-SJC', 'x-forwarded-proto': 'https' };

describe('sign-in routes', () => {
  const dirs: string[] = [];
  let google: GoogleStub;
  let server: ServerHandle;
  let access: ServerHandle;

  const tmp = () => {
    const d = mkdtempSync(join(tmpdir(), 'signin-routes-'));
    dirs.push(d);
    return d;
  };
  /** Through the tunnel to `handle`, on the public address. */
  const viaTunnel =
    (handle: ServerHandle) =>
    (path: string, init: RequestInit = {}) =>
      fetch(`http://127.0.0.1:${handle.port}${path}`, {
        redirect: 'manual',
        ...init,
        headers: { host: HOST, ...CF_RAY, ...((init.headers as Record<string, string>) ?? {}) },
      });
  const local = (handle: ServerHandle, path: string, init: RequestInit = {}) =>
    fetch(`http://127.0.0.1:${handle.port}${path}`, {
      redirect: 'manual',
      ...init,
      headers: {
        host: `localhost:${handle.port}`,
        ...((init.headers as Record<string, string>) ?? {}),
      },
    });

  beforeAll(() => {
    google = startGoogleStub();
    const signIn = {
      origin: ORIGIN,
      google: {
        clientId: 'shared-client',
        clientSecret: 'stub-secret',
        endpoints: google.endpoints,
      },
    };
    server = createServer({
      port: 0,
      dataDir: tmp(),
      proxiedTrustedHosts: [HOST],
      proxiedTrustedEmails: [OWNER, SECOND_OWNER],
      signIn: { mode: 'better-auth', ...signIn },
    });
    access = createServer({
      port: 0,
      dataDir: tmp(),
      proxiedTrustedHosts: [HOST],
      proxiedTrustedEmails: [OWNER],
      signIn: { mode: 'access', ...signIn },
    });
  });

  afterAll(async () => {
    await server.stop();
    await access.stop();
    google.stop();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it('sends a page load with no session to the sign-in page, and back afterwards', async () => {
    const res = await viaTunnel(server)('/workspaces?view=list', {
      headers: { accept: 'text/html' },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(
      `/auth/sign-in?next=${encodeURIComponent('/workspaces?view=list')}`,
    );
    const page = await viaTunnel(server)('/auth/sign-in?next=%2Fworkspaces');
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('action="/auth/sign-in/google"');
    expect(html).toContain('value="/workspaces"');
  });

  it('refuses a script with no session, without a redirect', async () => {
    const res = await viaTunnel(server)('/workspaces');
    expect(res.status).toBe(401);
  });

  it("the owner's Google sign-in makes them the owner", async () => {
    const jar = new CookieJar();
    const { callback } = await signInWithGoogle(
      viaTunnel(server),
      ORIGIN,
      jar,
      google,
      {
        sub: 'g-owner',
        email: OWNER,
        email_verified: true,
        name: 'Owner',
      },
      '/workspaces',
    );
    expect(callback.status).toBe(302);
    expect(callback.headers.get('location')).toBe('/workspaces');
    // The list of every board is an owner verb: a member is refused it.
    const docs = await viaTunnel(server)('/workspaces', { headers: { cookie: jar.header() } });
    expect(docs.status).toBe(200);
  });

  it('CONTROL: an owner address Google has not verified gets no account', async () => {
    const jar = new CookieJar();
    await signInWithGoogle(viaTunnel(server), ORIGIN, jar, google, {
      sub: 'g-second',
      email: SECOND_OWNER,
      email_verified: false,
      name: 'Owner',
    });
    expect(jar.cookies.has('__Host-cw-ba.session_token')).toBe(false);
    const list = await viaTunnel(server)('/workspaces', { headers: { cookie: jar.header() } });
    expect(list.status).toBe(401);
  });

  it('in access mode the sign-in routes do not exist', async () => {
    for (const path of ['/auth/sign-in', '/api/auth/get-session']) {
      const res = await local(access, path);
      expect(res.status).toBe(404);
    }
    const social = await local(access, '/api/auth/sign-in/social', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'google' }),
    });
    expect(social.status).toBe(404);
    // And through the tunnel the host is not even served: Access mode with no
    // Access configured honours no public hostname at all.
    const tunnel = await viaTunnel(access)('/auth/sign-in');
    expect(tunnel.status).toBe(403);
  });
});
