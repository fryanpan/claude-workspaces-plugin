/**
 * Email and password sign-in, one user list per machine (plan step 8).
 *
 * The Mac signs people in at the one address, Riverbend at its own. Both
 * share a board with `@harborlight.test`, so Alice may hold an account at
 * either; she makes one at Riverbend only. Mail, Turnstile and Google are
 * stubbed: every mail lands in an array, the Turnstile stub passes one token
 * for the right host and form, and Google is a local server.
 *
 * No account and no password exist until the address is proved: asking
 * mails a single-use link, and the account is made only when the person who
 * followed it sets a password on our own form. What this proves: a sign-up
 * in somebody else's name makes nothing and blocks nothing; a password set
 * at Riverbend signs in nowhere else; a link works once and not after it
 * expires; the answer never waits on the mail; and a form whose Turnstile
 * check fails reaches neither the account nor the mailer.
 */
import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SignInMail } from '../src/auth/board-signin-password.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { ACCESS_SHARE_CONFIG, mockCfApi } from './access-share.ts';
import { CookieJar, type GoogleStub, signInWithGoogle, startGoogleStub } from './google-stub.ts';
import { waitFor } from './wait-for.ts';

const MAC_HOST = 'workspaces.harborlight.test';
const CLOUD_HOST = 'riverbend-workspaces.harborlight.test';
const OWNER = 'owner@harborlight.test';
const ALICE = 'alice@harborlight.test';
const BOB = 'bob@harborlight.test';
const SALTMARSH = 'saltmarsh@harborlight.test';
const SESSION = '__Host-cw-ba.session_token';
const TUNNEL = { 'cf-ray': '8a1b2c3d4e5f-SJC', 'x-forwarded-proto': 'https' };
const GOOD = 'turnstile-pass';

interface Machine {
  host: string;
  dataDir: string;
  server: ServerHandle;
  board: string;
  mail: SignInMail[];
  /** Each form the Turnstile stub was asked about. */
  turnstile: string[];
  /** While set, a mail is accepted and never finishes sending. */
  hang: boolean;
}

describe('email and password sign-in, one user list per machine', () => {
  const dirs: string[] = [];
  let google: GoogleStub;
  let mac: Machine;
  let cloud: Machine;

  const start = async (host: string, name: string): Promise<Machine> => {
    const dataDir = mkdtempSync(join(tmpdir(), 'signin-password-'));
    dirs.push(dataDir);
    const m = { host, dataDir, mail: [], turnstile: [], hang: false } as unknown as Machine;
    m.server = createServer({
      port: 0,
      dataDir,
      proxiedTrustedHosts: [host],
      proxiedTrustedEmails: [OWNER],
      share: { config: ACCESS_SHARE_CONFIG, cfApi: mockCfApi() },
      signIn: {
        mode: 'better-auth',
        origin: `https://${host}`,
        google: {
          clientId: 'shared-client',
          clientSecret: 'stub-secret',
          endpoints: google.endpoints,
        },
        password: {
          mailer: {
            send: (mail) => {
              m.mail.push(mail);
              return m.hang ? new Promise<void>(() => {}) : Promise.resolve();
            },
          },
          turnstile: {
            siteKey: 'turnstile-site-key',
            verify: async (token, _ip, want) => {
              m.turnstile.push(want.action);
              return token === GOOD && want.hostname === host;
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
  /** Submit one of the sign-in pages' forms, as the page would. */
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
  const signIn = (m: Machine, jar: CookieJar, email: string, password: string, ts = GOOD) =>
    submit(m, jar, '/auth/sign-in/email', { email, password, next: '/' }, ts);
  const board = (m: Machine, jar: CookieJar) => send(m, jar, `/workspaces/${m.board}?format=json`);
  /** Ask for a link, and wait for the mail it sends. */
  const askForLink = async (m: Machine, email: string, path = '/auth/sign-up') => {
    const before = m.mail.length;
    const res = await submit(m, new CookieJar(), path, { email, password: 'ignored-pass-1' });
    expect(res.status).toBe(303);
    const mail = await waitFor(() => m.mail.slice(before).find((x) => x.to === email), {
      describe: `a set-password mail to ${email}`,
    });
    expect(mail.kind).toBe('set-password');
    return mail;
  };
  /** Open the mailed link, then set a password on the page it shows. */
  const setPassword = async (m: Machine, url: string, password: string, ts = GOOD) => {
    const jar = new CookieJar();
    const link = new URL(url);
    expect(link.host).toBe(m.host);
    expect(link.pathname).toBe('/auth/set-password');
    const page = await send(m, jar, `${link.pathname}${link.search}`);
    expect(page.status).toBe(200);
    expect(page.headers.get('referrer-policy')).toBe('no-referrer');
    const token = link.searchParams.get('token') ?? '';
    return submit(m, jar, '/auth/set-password', { token, password }, ts);
  };
  const failed = (res: Response) => (res.headers.get('location') ?? '').includes('error=');
  const rows = (m: Machine, email: string) => {
    const db = new Database(join(m.dataDir, 'signin.sqlite'), { readonly: true });
    try {
      return (
        db.query('SELECT COUNT(*) AS n FROM user WHERE email = ?').get(email) as { n: number }
      ).n;
    } finally {
      db.close();
    }
  };

  beforeAll(async () => {
    google = startGoogleStub();
    mac = await start(MAC_HOST, 'Harborlight board');
    cloud = await start(CLOUD_HOST, 'Riverbend board');
  });

  afterAll(async () => {
    await mac.server.stop();
    await cloud.server.stop();
    google.stop();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it("an attacker's sign-up in the owner's name makes nothing, and the owner's Google still works", async () => {
    await askForLink(cloud, OWNER);
    expect(rows(cloud, OWNER)).toBe(0);
    const jar = new CookieJar();
    await signInWithGoogle(
      (path, init) => send(cloud, jar, path, init),
      `https://${CLOUD_HOST}`,
      jar,
      google,
      { sub: 'g-owner', email: OWNER, email_verified: true, name: 'Owner' },
    );
    expect(jar.cookies.has(SESSION)).toBe(true);
    expect((await board(cloud, jar)).status).toBe(200);
  });

  it('Alice reaches the shared board once she sets a password from the mailed link', async () => {
    const mail = await askForLink(cloud, ALICE);
    expect(rows(cloud, ALICE)).toBe(0);
    const early = new CookieJar();
    expect(failed(await signIn(cloud, early, ALICE, 'ignored-pass-1'))).toBe(true);
    const set = await setPassword(cloud, mail.url, 'riverbend-first-pass');
    expect(failed(set)).toBe(false);
    const jar = new CookieJar();
    const signed = await signIn(cloud, jar, ALICE, 'riverbend-first-pass');
    expect(signed.headers.get('location')).toBe('/');
    expect(jar.cookies.has(SESSION)).toBe(true);
    const res = await board(cloud, jar);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Riverbend board');
  });

  it('a password set at Riverbend does not sign in at the Mac', async () => {
    const atMac = new CookieJar();
    expect(failed(await signIn(mac, atMac, ALICE, 'riverbend-first-pass'))).toBe(true);
    expect(atMac.cookies.has(SESSION)).toBe(false);
    expect((await board(mac, atMac)).status).toBe(401);
    // CONTROL: the same password, at the machine that holds it.
    const atCloud = new CookieJar();
    await signIn(cloud, atCloud, ALICE, 'riverbend-first-pass');
    expect(atCloud.cookies.has(SESSION)).toBe(true);
  });

  it('a link sets the password its clicker types, not one chosen when it was asked for', async () => {
    // Somebody asks in Bob's name, with a password of their own in the form.
    const mail = await askForLink(cloud, BOB);
    expect(failed(await setPassword(cloud, mail.url, 'bob-own-pass-1'))).toBe(false);
    const theirs = new CookieJar();
    expect(failed(await signIn(cloud, theirs, BOB, 'ignored-pass-1'))).toBe(true);
    const his = new CookieJar();
    await signIn(cloud, his, BOB, 'bob-own-pass-1');
    expect(his.cookies.has(SESSION)).toBe(true);
  });

  it('a member who loses the first mail can ask again', async () => {
    await askForLink(mac, BOB);
    const second = await askForLink(mac, BOB);
    expect(failed(await setPassword(mac, second.url, 'harborlight-pass-1'))).toBe(false);
    const jar = new CookieJar();
    await signIn(mac, jar, BOB, 'harborlight-pass-1');
    expect(jar.cookies.has(SESSION)).toBe(true);
  });

  it('a link works once, and resetting ends the sessions already open', async () => {
    const open = new CookieJar();
    await signIn(cloud, open, ALICE, 'riverbend-first-pass');
    expect((await board(cloud, open)).status).toBe(200);
    const mail = await askForLink(cloud, ALICE, '/auth/forgot');
    expect(failed(await setPassword(cloud, mail.url, 'riverbend-second-pass'))).toBe(false);
    expect(failed(await setPassword(cloud, mail.url, 'riverbend-third-pass'))).toBe(true);
    expect((await board(cloud, open)).status).toBe(401);
    const fresh = new CookieJar();
    await signIn(cloud, fresh, ALICE, 'riverbend-second-pass');
    expect(fresh.cookies.has(SESSION)).toBe(true);
    const stale = new CookieJar();
    expect(failed(await signIn(cloud, stale, ALICE, 'riverbend-first-pass'))).toBe(true);
  });

  it('a link does not work after it expires', async () => {
    const mail = await askForLink(cloud, ALICE, '/auth/forgot');
    // An hour passes: move every set-password link's expiry into the past.
    const db = new Database(join(cloud.dataDir, 'signin.sqlite'));
    try {
      const row = db
        .query("SELECT expiresAt FROM verification WHERE identifier LIKE 'cw-set-password:%'")
        .get() as { expiresAt: unknown } | null;
      expect(row).not.toBeNull();
      const past = typeof row?.expiresAt === 'number' ? 1 : '2020-01-01T00:00:00.000Z';
      db.query(
        "UPDATE verification SET expiresAt = ? WHERE identifier LIKE 'cw-set-password:%'",
      ).run(past);
    } finally {
      db.close();
    }
    expect(failed(await setPassword(cloud, mail.url, 'riverbend-late-pass'))).toBe(true);
    const stale = new CookieJar();
    expect(failed(await signIn(cloud, stale, ALICE, 'riverbend-late-pass'))).toBe(true);
  });

  it('a verified Google sign-in replaces an unverified password-only row', async () => {
    // A row an earlier version could leave: a password, never proved.
    const db = new Database(join(cloud.dataDir, 'signin.sqlite'));
    try {
      const at = (db.query('SELECT createdAt FROM user LIMIT 1').get() as { createdAt: unknown })
        .createdAt;
      db.query(
        'INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 0, ?, ?)',
      ).run('stale-user', 'saltmarsh', SALTMARSH, at as string, at as string);
      db.query(
        'INSERT INTO account (id, accountId, providerId, userId, password, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(
        'stale-account',
        'stale-user',
        'credential',
        'stale-user',
        'x',
        at as string,
        at as string,
      );
    } finally {
      db.close();
    }
    const jar = new CookieJar();
    await signInWithGoogle(
      (path, init) => send(cloud, jar, path, init),
      `https://${CLOUD_HOST}`,
      jar,
      google,
      { sub: 'g-saltmarsh', email: SALTMARSH, email_verified: true, name: 'Saltmarsh' },
    );
    expect(jar.cookies.has(SESSION)).toBe(true);
    expect((await board(cloud, jar)).status).toBe(200);
    expect(rows(cloud, SALTMARSH)).toBe(1);
  });

  it('answers before the mail is sent, so the wait says nothing about the address', async () => {
    cloud.hang = true;
    try {
      // With a mailer that never finishes, an answer that waited would never come.
      const res = await submit(cloud, new CookieJar(), '/auth/forgot', { email: ALICE });
      expect(res.status).toBe(303);
      await waitFor(() => cloud.mail.at(-1)?.to === ALICE || undefined, {
        describe: 'the mail, handed to the mailer after the answer',
      });
    } finally {
      cloud.hang = false;
    }
  });

  it('a failed Turnstile check is refused before the account or the mailer', async () => {
    const jar = new CookieJar();
    const mails = cloud.mail.length;
    const res = await signIn(cloud, jar, ALICE, 'riverbend-second-pass', 'turnstile-fail');
    expect(res.headers.get('location')).toContain('error=turnstile');
    expect(jar.cookies.has(SESSION)).toBe(false);
    for (const path of ['/auth/forgot', '/auth/sign-up']) {
      const r = await submit(cloud, jar, path, { email: SALTMARSH }, '');
      expect(r.headers.get('location')).toContain('error=turnstile');
    }
    const mail = await askForLink(cloud, ALICE, '/auth/forgot');
    const set = await setPassword(cloud, mail.url, 'riverbend-blocked-pass', 'turnstile-fail');
    expect(set.headers.get('location')).toContain('error=turnstile');
    expect(cloud.mail.length).toBe(mails + 1);
    // Each form asked for its own action.
    expect(cloud.turnstile.slice(-5)).toEqual([
      'sign-in',
      'forgot',
      'sign-up',
      'forgot',
      'set-password',
    ]);
    // CONTROL: the same link and the same sign-in, with a passing check.
    expect(failed(await setPassword(cloud, mail.url, 'riverbend-fourth-pass'))).toBe(false);
    await signIn(cloud, jar, ALICE, 'riverbend-fourth-pass');
    expect(jar.cookies.has(SESSION)).toBe(true);
  });

  it('refuses a form posted from another site', async () => {
    const res = await send(cloud, new CookieJar(), '/auth/sign-in/email', {
      method: 'POST',
      headers: {
        origin: 'https://saltmarsh.example.test',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ email: ALICE, password: 'x', 'cf-turnstile-response': GOOD }),
    });
    expect(res.status).toBe(403);
  });

  it('the sign-in page offers the password forms with the Turnstile widget', async () => {
    const res = await send(cloud, new CookieJar(), '/auth/sign-in?next=%2F');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('action="/auth/sign-in/email"');
    expect(html).toContain('data-sitekey="turnstile-site-key"');
    expect(html).toContain('data-action="sign-in"');
  });
});
