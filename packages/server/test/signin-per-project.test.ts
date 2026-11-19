/**
 * One Better Auth sign-in per machine, over two real servers and the board
 * router Worker's own handler (plan step 3) — `access-per-project.test.ts`
 * with Cloudflare Access taken away.
 *
 * The Mac answers the one address and its own subdomain, and signs people in
 * on the one address only (plan choice 4). Riverbend answers its own
 * subdomain and signs people in there. Both share one Google client.
 *
 * What this proves: a session Riverbend made, replayed to the Mac through
 * the router on either of the Mac's hosts, opens nothing there, while the
 * Mac's own session does; a Riverbend session token re-signed with the Mac's
 * own secret still opens nothing, because the Mac never wrote that session;
 * and an ID token posted straight to the Mac makes no session at all.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleBoardRequest } from '../../../infra/board-router-worker/worker.js';
import { signInSecret } from '../src/auth/board-signin.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { loadCookieKey } from '../src/share/link-session.ts';
import {
  CookieJar,
  type GoogleProfile,
  type GoogleStub,
  type Send,
  signInWithGoogle,
  startGoogleStub,
} from './google-stub.ts';

const ONE_HOST = 'workspaces.harborlight.test';
const MAC_HOST = 'harborlight-workspaces.harborlight.test';
const CLOUD_HOST = 'riverbend-workspaces.harborlight.test';
const MAC_ORIGIN = 'mac-origin.harborlight.test';
const CLOUD_ORIGIN = 'riverbend-origin.harborlight.test';
const OWNER = 'owner@harborlight.test';
const SESSION = '__Host-cw-ba.session_token';
const ownerProfile: GoogleProfile = {
  sub: 'g-owner',
  email: OWNER,
  email_verified: true,
  name: 'Owner',
};

describe('one Better Auth sign-in per machine', () => {
  const dataDirs: string[] = [];
  let google: GoogleStub;
  let mac: ServerHandle;
  let cloud: ServerHandle;
  let macDataDir: string;
  let macBoard: string;
  let cloudBoard: string;
  let env: Record<string, string>;
  const reached: string[] = [];
  /** The owner's browser after signing in at each machine. */
  const atMac = new CookieJar();
  const atCloud = new CookieJar();
  /** Where each machine sent the browser to sign in at Google. */
  let macAuthorize: URL;
  let cloudAuthorize: URL;

  const tmp = () => {
    const d = mkdtempSync(join(tmpdir(), 'signin-per-project-'));
    dataDirs.push(d);
    return d;
  };
  const local = (handle: ServerHandle, path: string, init: RequestInit = {}) =>
    fetch(`http://127.0.0.1:${handle.port}${path}`, {
      ...init,
      headers: {
        host: `localhost:${handle.port}`,
        'content-type': 'application/json',
        ...((init.headers as Record<string, string>) ?? {}),
      },
    });
  const makeBoard = async (handle: ServerHandle, name: string) => {
    const res = await local(handle, '/workspaces', {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { workspace: { id: string } }).workspace.id;
  };

  /** The tunnel: origin hostname to a loopback port, Host kept, `cf-ray` added. */
  const tunnel = async (
    request: Request,
    init: { redirect?: 'manual'; cf: { resolveOverride: string } },
  ) => {
    const origin = init.cf.resolveOverride;
    reached.push(origin);
    const port = origin === MAC_ORIGIN ? mac.port : origin === CLOUD_ORIGIN ? cloud.port : null;
    if (port === null) throw new Error(`no tunnel for ${origin}`);
    const url = new URL(request.url);
    const headers = new Headers(request.headers);
    headers.set('host', url.host);
    headers.set('cf-ray', '8a1b2c3d4e5f-SJC');
    headers.set('x-forwarded-proto', 'https');
    const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
    return fetch(`http://127.0.0.1:${port}${url.pathname}${url.search}`, {
      method: request.method,
      headers,
      redirect: 'manual',
      ...(hasBody ? { body: await request.arrayBuffer() } : {}),
    });
  };
  /** Through the Worker, as a browser on `host` would send it. */
  const browserOn =
    (host: string): Send =>
    (path, init = {}) =>
      handleBoardRequest(new Request(`https://${host}${path}`, init), env, tunnel);
  const withCookie = (jar: CookieJar | string) => ({
    headers: { cookie: typeof jar === 'string' ? jar : jar.header() },
  });
  const boardJson = (id: string) => `/workspaces/${id}?format=json`;

  beforeAll(async () => {
    google = startGoogleStub();
    const client = {
      clientId: 'shared-client',
      clientSecret: 'stub-secret',
      endpoints: google.endpoints,
    };
    macDataDir = tmp();
    mac = createServer({
      port: 0,
      dataDir: macDataDir,
      proxiedTrustedHosts: [ONE_HOST, MAC_HOST],
      proxiedTrustedEmails: [OWNER],
      signIn: { mode: 'better-auth', origin: `https://${ONE_HOST}`, google: client },
    });
    cloud = createServer({
      port: 0,
      dataDir: tmp(),
      proxiedTrustedHosts: [CLOUD_HOST],
      proxiedTrustedEmails: [OWNER],
      signIn: { mode: 'better-auth', origin: `https://${CLOUD_HOST}`, google: client },
    });
    macBoard = await makeBoard(mac, 'Harborlight board');
    cloudBoard = await makeBoard(cloud, 'Riverbend board');
    env = {
      ONE_ADDRESS: ONE_HOST,
      ONE_ADDRESS_ORIGIN: MAC_ORIGIN,
      PROJECT_ORIGINS: JSON.stringify({ harborlight: MAC_ORIGIN, riverbend: CLOUD_ORIGIN }),
      BOARD_ORIGINS: JSON.stringify({ [MAC_ORIGIN]: [macBoard], [CLOUD_ORIGIN]: [cloudBoard] }),
    };
    macAuthorize = (
      await signInWithGoogle(
        browserOn(ONE_HOST),
        `https://${ONE_HOST}`,
        atMac,
        google,
        ownerProfile,
      )
    ).authorize;
    cloudAuthorize = (
      await signInWithGoogle(
        browserOn(CLOUD_HOST),
        `https://${CLOUD_HOST}`,
        atCloud,
        google,
        ownerProfile,
      )
    ).authorize;
    expect(atMac.cookies.has(SESSION)).toBe(true);
    expect(atCloud.cookies.has(SESSION)).toBe(true);
    // The browser lands on a page after signing in. On each machine that
    // first admitted page is what records the owner's sign-in and opens the
    // lock-out guard (`signin-lockout-guard.test.ts`); until then
    // `better-auth` runs as `both`.
    expect((await browserOn(ONE_HOST)(boardJson(macBoard), withCookie(atMac))).status).toBe(200);
    expect((await browserOn(CLOUD_HOST)(boardJson(cloudBoard), withCookie(atCloud))).status).toBe(
      200,
    );
  });

  afterAll(async () => {
    await mac.stop();
    await cloud.stop();
    google.stop();
    for (const dir of dataDirs) rmSync(dir, { recursive: true, force: true });
  });

  describe("Riverbend's session, replayed to the Mac", () => {
    it('CONTROL: Riverbend admits the owner on its own session', async () => {
      const res = await browserOn(CLOUD_HOST)(boardJson(cloudBoard), withCookie(atCloud));
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('Riverbend board');
    });

    it("is refused on the Mac's subdomain, after reaching the Mac", async () => {
      reached.length = 0;
      const res = await browserOn(MAC_HOST)(boardJson(macBoard), withCookie(atCloud));
      expect(reached).toEqual([MAC_ORIGIN]);
      expect(res.status).toBe(401);
      expect(await res.text()).not.toContain('Harborlight board');
    });

    it("a page on the Mac's subdomain is sent to the one address, not admitted", async () => {
      reached.length = 0;
      const res = await browserOn(MAC_HOST)(`/workspaces/${macBoard}`, {
        headers: { cookie: atCloud.header(), accept: 'text/html' },
      });
      expect(reached).toEqual([MAC_ORIGIN]);
      expect(res.status).toBe(308);
      expect(res.headers.get('location')).toBe(`https://${ONE_HOST}/workspaces/${macBoard}`);
    });

    it('is refused on the one address, after reaching the Mac', async () => {
      reached.length = 0;
      const res = await browserOn(ONE_HOST)(boardJson(macBoard), withCookie(atCloud));
      expect(reached).toEqual([MAC_ORIGIN]);
      expect(res.status).toBe(401);
      expect(await res.text()).not.toContain('Harborlight board');
    });

    it("CONTROL: the Mac admits the owner on the Mac's own session", async () => {
      const res = await browserOn(ONE_HOST)(boardJson(macBoard), withCookie(atMac));
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('Harborlight board');
    });

    it("Riverbend refuses the Mac's session", async () => {
      const res = await browserOn(CLOUD_HOST)(boardJson(cloudBoard), withCookie(atMac));
      expect(res.status).toBe(401);
    });

    it("the Mac's session does not open its own subdomain either", async () => {
      // One address signs in (plan choice 4); the subdomain sends pages there.
      const res = await browserOn(MAC_HOST)(boardJson(macBoard), withCookie(atMac));
      expect(res.status).toBe(401);
    });
  });

  describe("a Riverbend session re-signed with the Mac's own secret", () => {
    /** A session cookie's value, signed as Better Auth signs one. */
    const signed = (token: string, secret: string) =>
      encodeURIComponent(`${token}.${createHmac('sha256', secret).update(token).digest('base64')}`);
    const tokenOf = (jar: CookieJar) => {
      const raw = decodeURIComponent(jar.cookies.get(SESSION) ?? '');
      return raw.slice(0, raw.lastIndexOf('.'));
    };

    it('CONTROL: re-signing the Mac’s own token reproduces a cookie the Mac admits', async () => {
      const macSecret = signInSecret(loadCookieKey(macDataDir));
      const value = signed(tokenOf(atMac), macSecret);
      expect(value).toBe(atMac.cookies.get(SESSION) ?? '');
      const res = await browserOn(ONE_HOST)(boardJson(macBoard), withCookie(`${SESSION}=${value}`));
      expect(res.status).toBe(200);
    });

    it('is refused: the Mac never wrote that session', async () => {
      const macSecret = signInSecret(loadCookieKey(macDataDir));
      const forged = `${SESSION}=${signed(tokenOf(atCloud), macSecret)}`;
      for (const host of [ONE_HOST, MAC_HOST]) {
        const res = await browserOn(host)(boardJson(macBoard), withCookie(forged));
        expect(res.status).toBe(401);
        expect(await res.text()).not.toContain('Harborlight board');
      }
    });
  });

  describe('a Google ID token posted straight to the Mac', () => {
    it('makes no session', async () => {
      const res = await browserOn(ONE_HOST)('/api/auth/sign-in/social', {
        method: 'POST',
        headers: { origin: `https://${ONE_HOST}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          provider: 'google',
          idToken: { token: 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJnLW93bmVyIn0.c2ln' },
        }),
      });
      expect(res.status).toBe(400);
      expect(res.headers.getSetCookie()).toEqual([]);
    });
  });

  describe('one Google client (plan step 5)', () => {
    it('both machines send the same client id and ask for the account picker', () => {
      for (const authorize of [macAuthorize, cloudAuthorize]) {
        expect(authorize.searchParams.get('client_id')).toBe('shared-client');
        expect(authorize.searchParams.get('prompt')).toBe('select_account');
      }
      // And the code exchange named it too, from each machine.
      expect(new Set(google.clientIds)).toEqual(new Set(['shared-client']));
      expect(google.clientIds.length).toBeGreaterThanOrEqual(2);
    });

    it('each names its own return address, which is all Google will send a result to', () => {
      expect(macAuthorize.searchParams.get('redirect_uri')).toBe(
        `https://${ONE_HOST}/api/auth/callback/google`,
      );
      expect(cloudAuthorize.searchParams.get('redirect_uri')).toBe(
        `https://${CLOUD_HOST}/api/auth/callback/google`,
      );
    });
  });
});
