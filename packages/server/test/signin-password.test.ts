/**
 * Email and password sign-in, one user list per machine (plan step 8).
 *
 * The Mac signs people in at the one address, Riverbend at its own. Both
 * share a board with `@harborlight.test`, so Alice may hold an account at
 * either; she makes one at Riverbend only. Mail and Turnstile are injected:
 * every mail lands in an array, and the Turnstile stub passes one token.
 *
 * What this proves: Alice's password, set at Riverbend, signs in nowhere
 * else; she reaches the shared board only after following the emailed link
 * (plan step 4, verified by an emailed link); a reset link works once and
 * not after it expires; and a form whose Turnstile check fails reaches
 * neither Better Auth nor the mailer.
 */
import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SignInMail } from '../src/auth/board-signin-password.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { ACCESS_SHARE_CONFIG, mockCfApi } from './access-share.ts';
import { CookieJar } from './google-stub.ts';
import { waitFor } from './wait-for.ts';

const MAC_HOST = 'workspaces.harborlight.test';
const CLOUD_HOST = 'riverbend-workspaces.harborlight.test';
const OWNER = 'owner@harborlight.test';
const ALICE = 'alice@harborlight.test';
const SESSION = '__Host-cw-ba.session_token';
const TUNNEL = { 'cf-ray': '8a1b2c3d4e5f-SJC', 'x-forwarded-proto': 'https' };
const GOOD = 'turnstile-pass';

interface Machine {
  host: string;
  dataDir: string;
  server: ServerHandle;
  board: string;
  mail: SignInMail[];
  turnstileAsked: number;
}

describe('email and password sign-in, one user list per machine', () => {
  const dirs: string[] = [];
  let mac: Machine;
  let cloud: Machine;

  const start = async (host: string, name: string): Promise<Machine> => {
    const dataDir = mkdtempSync(join(tmpdir(), 'signin-password-'));
    dirs.push(dataDir);
    const m = { host, dataDir, mail: [] as SignInMail[], turnstileAsked: 0 } as Machine;
    m.server = createServer({
      port: 0,
      dataDir,
      proxiedTrustedHosts: [host],
      proxiedTrustedEmails: [OWNER],
      share: { config: ACCESS_SHARE_CONFIG, cfApi: mockCfApi() },
      signIn: {
        mode: 'better-auth',
        origin: `https://${host}`,
        google: { clientId: 'shared-client', clientSecret: 'stub-secret' },
        password: {
          mailer: {
            send: async (mail) => {
              m.mail.push(mail);
            },
          },
          turnstile: {
            siteKey: 'turnstile-site-key',
            verify: async (token) => {
              m.turnstileAsked += 1;
              return token === GOOD;
            },
          },
        },
      },
    });
    const local = (path: string, body: unknown) =>
      fetch(`http://127.0.0.1:${m.server.port}${path}`, {
        method: 'POST',
        headers: { host: `localhost:${m.server.port}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const created = await local('/workspaces', { name });
    expect(created.status).toBe(200);
    m.board = ((await created.json()) as { workspace: { id: string } }).workspace.id;
    m.server.shareLinks.addToAudience(m.board, ['@harborlight.test'], 'Owner');
    const shared = await local('/api/share/link', {
      workspaceId: m.board,
      allowDomains: ['@harborlight.test'],
    });
    expect(shared.status, await shared.clone().text()).toBe(200);
    return m;
  };

  /** A browser's request to a machine through the tunnel. */
  const send = (m: Machine, jar: CookieJar, path: string, init: RequestInit = {}) =>
    fetch(`http://127.0.0.1:${m.server.port}${path}`, {
      redirect: 'manual',
      ...init,
      headers: {
        host: m.host,
        ...TUNNEL,
        'cf-connecting-ip': jar.ip,
        cookie: jar.header(),
        ...((init.headers as Record<string, string>) ?? {}),
      },
    });
  /** Submit one of the sign-in page's forms, as the page would. */
  const submit = async (
    m: Machine,
    jar: CookieJar,
    path: string,
    fields: Record<string, string>,
    turnstile = GOOD,
  ) => {
    const res = await send(m, jar, path, {
      method: 'POST',
      headers: {
        origin: `https://${m.host}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ ...fields, 'cf-turnstile-response': turnstile }).toString(),
    });
    jar.take(res);
    return res;
  };
  const signIn = (m: Machine, jar: CookieJar, password: string, turnstile = GOOD) =>
    submit(m, jar, '/auth/sign-in/email', { email: ALICE, password, next: '/' }, turnstile);
  const board = (m: Machine, jar: CookieJar) => send(m, jar, `/workspaces/${m.board}?format=json`);
  /** Follow a mailed link the way a mail client opens it. */
  const follow = async (m: Machine, jar: CookieJar, url: string) => {
    const link = new URL(url);
    expect(link.host).toBe(m.host);
    const res = await send(m, jar, `${link.pathname}${link.search}`);
    jar.take(res);
    return res;
  };
  const lastMail = (m: Machine, kind: SignInMail['kind']) =>
    waitFor(() => m.mail.filter((x) => x.kind === kind && x.to === ALICE).at(-1), {
      describe: `a ${kind} mail to Alice`,
    });

  beforeAll(async () => {
    mac = await start(MAC_HOST, 'Harborlight board');
    cloud = await start(CLOUD_HOST, 'Riverbend board');
  });

  afterAll(async () => {
    await mac.server.stop();
    await cloud.server.stop();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it('Alice reaches the shared board only after following the emailed link', async () => {
    const jar = new CookieJar();
    const made = await submit(cloud, jar, '/auth/sign-up', {
      email: ALICE,
      password: 'riverbend-first-pass',
      next: '/',
    });
    expect(made.status).toBe(303);
    const verify = await lastMail(cloud, 'verify-email');
    // Before the link: the password signs nobody in.
    const early = await signIn(cloud, jar, 'riverbend-first-pass');
    expect(early.status).toBe(303);
    expect(early.headers.get('location')).toContain('error=');
    expect(jar.cookies.has(SESSION)).toBe(false);
    expect((await board(cloud, jar)).status).toBe(401);

    const followed = await follow(cloud, jar, verify.url);
    expect([302, 303]).toContain(followed.status);
    const signed = await signIn(cloud, jar, 'riverbend-first-pass');
    expect(signed.status).toBe(303);
    expect(signed.headers.get('location')).toBe('/');
    expect(jar.cookies.has(SESSION)).toBe(true);
    const res = await board(cloud, jar);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Riverbend board');
  });

  it('a password set at Riverbend does not sign in at the Mac', async () => {
    const atMac = new CookieJar();
    const res = await signIn(mac, atMac, 'riverbend-first-pass');
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toContain('error=');
    expect(atMac.cookies.has(SESSION)).toBe(false);
    expect((await board(mac, atMac)).status).toBe(401);
    // CONTROL: the same password, at the machine that holds it.
    const atCloud = new CookieJar();
    await signIn(cloud, atCloud, 'riverbend-first-pass');
    expect(atCloud.cookies.has(SESSION)).toBe(true);
  });

  it('a reset link works once', async () => {
    const jar = new CookieJar();
    const sent = await submit(cloud, jar, '/auth/forgot', { email: ALICE });
    expect(sent.status).toBe(303);
    const mail = await lastMail(cloud, 'reset-password');
    const opened = await follow(cloud, jar, mail.url);
    expect(opened.status).toBe(302);
    const page = new URL(opened.headers.get('location') ?? '', `https://${CLOUD_HOST}`);
    expect(page.pathname).toBe('/auth/reset');
    const token = page.searchParams.get('token') ?? '';
    expect(token).not.toBe('');

    const reset = () =>
      submit(cloud, jar, '/auth/reset', { token, password: 'riverbend-second-pass' });
    const first = await reset();
    expect(first.headers.get('location')).not.toContain('error=');
    const again = await reset();
    expect(again.headers.get('location')).toContain('error=');

    const fresh = new CookieJar();
    await signIn(cloud, fresh, 'riverbend-second-pass');
    expect(fresh.cookies.has(SESSION)).toBe(true);
    const stale = new CookieJar();
    await signIn(cloud, stale, 'riverbend-first-pass');
    expect(stale.cookies.has(SESSION)).toBe(false);
  });

  it('a reset link does not work after it expires', async () => {
    const jar = new CookieJar();
    const before = cloud.mail.length;
    await submit(cloud, jar, '/auth/forgot', { email: ALICE });
    const mail = await waitFor(
      () => cloud.mail.slice(before).find((x) => x.kind === 'reset-password'),
      {
        describe: 'a second reset mail',
      },
    );
    // An hour passes: move the token's expiry into the past.
    const db = new Database(join(cloud.dataDir, 'signin.sqlite'));
    try {
      const row = db
        .query("SELECT expiresAt FROM verification WHERE identifier LIKE 'reset-password:%'")
        .get() as { expiresAt: unknown } | null;
      expect(row).not.toBeNull();
      const past = typeof row?.expiresAt === 'number' ? 1 : '2020-01-01T00:00:00.000Z';
      db.query(
        "UPDATE verification SET expiresAt = ? WHERE identifier LIKE 'reset-password:%'",
      ).run(past);
    } finally {
      db.close();
    }
    const opened = await follow(cloud, jar, mail.url);
    const page = new URL(opened.headers.get('location') ?? '', `https://${CLOUD_HOST}`);
    expect(page.searchParams.get('error')).toBe('INVALID_TOKEN');
    const token = new URL(mail.url).pathname.split('/').at(-1) ?? '';
    const res = await submit(cloud, jar, '/auth/reset', {
      token,
      password: 'riverbend-third-pass',
    });
    expect(res.headers.get('location')).toContain('error=');
    const stale = new CookieJar();
    await signIn(cloud, stale, 'riverbend-third-pass');
    expect(stale.cookies.has(SESSION)).toBe(false);
  });

  it('a failed Turnstile check is refused before Better Auth or the mailer', async () => {
    const jar = new CookieJar();
    const asked = cloud.turnstileAsked;
    const mails = cloud.mail.length;
    const res = await signIn(cloud, jar, 'riverbend-second-pass', 'turnstile-fail');
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toContain('error=turnstile');
    expect(jar.cookies.has(SESSION)).toBe(false);
    const forgot = await submit(cloud, jar, '/auth/forgot', { email: ALICE }, 'turnstile-fail');
    expect(forgot.headers.get('location')).toContain('error=turnstile');
    const signUp = await submit(
      cloud,
      jar,
      '/auth/sign-up',
      { email: 'bob@harborlight.test', password: 'saltmarsh-pass-1' },
      '',
    );
    expect(signUp.headers.get('location')).toContain('error=turnstile');
    expect(cloud.turnstileAsked).toBe(asked + 3);
    expect(cloud.mail.length).toBe(mails);
    // CONTROL: the same sign-in with a passing check.
    await signIn(cloud, jar, 'riverbend-second-pass');
    expect(jar.cookies.has(SESSION)).toBe(true);
  });

  it('refuses a form posted from another site', async () => {
    const res = await send(cloud, new CookieJar(), '/auth/sign-in/email', {
      method: 'POST',
      headers: {
        origin: 'https://saltmarsh.example.test',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        email: ALICE,
        password: 'riverbend-second-pass',
        'cf-turnstile-response': GOOD,
      }).toString(),
    });
    expect(res.status).toBe(403);
  });

  it('the sign-in page offers the password forms with the Turnstile widget', async () => {
    const res = await send(cloud, new CookieJar(), '/auth/sign-in?next=%2F');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('action="/auth/sign-in/email"');
    expect(html).toContain('data-sitekey="turnstile-site-key"');
  });
});
