/**
 * A person's destructive action asks for a sign-in from the last ten minutes
 * (`src/fresh-signin.ts`), through the real server.
 *
 * Every counted route is driven twice by the owner through the tunnel — once
 * with an Access token minted twenty minutes ago, once with one minted now —
 * so a server that refused everything, or nothing, fails here. A stale refusal
 * is also checked to have changed nothing. Instant actions and agents are
 * driven with the same stale token, or with none, and must never be asked.
 *
 * Fixtures are synthetic; the repo is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type JSONWebKeySet, type JWK, SignJWT, exportJWK, generateKeyPair } from 'jose';
import { resetOwnerIdentities } from '../src/actor-identity.ts';
import { mintSession, sessionKey, signSession } from '../src/auth/session.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { loadCookieKey } from '../src/share/link-session.ts';
import { ACCESS_SHARE_CONFIG, mockCfApi } from './access-share.ts';

const TEAM_DOMAIN = 'test.cloudflareaccess.com';
const KID = 'fresh-signin-kid';
const OWNER_AUD = 'aud-for-the-owner-app';
const SHARE_AUD = 'aud-for-the-share-app';
const OWNER_HOST = 'workspaces.example.test';
const SHARE_HOST = 'share.example.test';
const OWNER_EMAIL = 'owner@example.test';
const MEMBER = 'keeper@harborlight.example';
const CF_RAY = { 'cf-ray': '8a1b2c3d4e5f-SJC' };
const STALE = 20 * 60;

let jwks: JSONWebKeySet;
/** An Access token for the owner, minted `ageSeconds` ago; `iat: null` omits it. */
let ownerToken: (ageSeconds: number | null, opts?: { forged?: boolean }) => Promise<string>;
let memberToken: () => Promise<string>;

beforeAll(async () => {
  const real = await generateKeyPair('RS256');
  const forger = await generateKeyPair('RS256');
  const publicJwk = (await exportJWK(real.publicKey)) as JWK;
  Object.assign(publicJwk, { kid: KID, alg: 'RS256', use: 'sig' });
  jwks = { keys: [publicJwk] };
  const sign = (aud: string, email: string, ageSeconds: number | null, key = real.privateKey) => {
    const now = Math.floor(Date.now() / 1000);
    const jwt = new SignJWT({ email })
      .setProtectedHeader({ alg: 'RS256', kid: KID })
      .setIssuer(`https://${TEAM_DOMAIN}`)
      .setAudience(aud)
      .setExpirationTime(now + 3600)
      .setSubject('cf-access-fresh-signin');
    if (ageSeconds !== null) jwt.setIssuedAt(now - ageSeconds);
    return jwt.sign(key);
  };
  ownerToken = (age, opts = {}) =>
    sign(OWNER_AUD, OWNER_EMAIL, age, opts.forged ? forger.privateKey : real.privateKey);
  memberToken = () => sign(SHARE_AUD, MEMBER, 0);
});

describe('a fresh sign-in before a destructive action', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let board: string;
  let n = 0;

  const local = (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      redirect: 'manual',
      ...init,
      headers: { 'content-type': 'application/json', ...(init.headers as Record<string, string>) },
    });
  const post = (path: string, body: unknown, method = 'POST') =>
    local(path, { method, body: JSON.stringify(body) });

  /** The owner through the tunnel, with a token minted `age` seconds ago. */
  const asOwner = async (
    path: string,
    method: string,
    body: unknown,
    age: number | null,
    opts: { forged?: boolean } = {},
  ) =>
    fetch(`${base}${path}`, {
      method,
      redirect: 'manual',
      headers: {
        host: OWNER_HOST,
        ...CF_RAY,
        // From the board's own page, which the owner-only access writes ask for.
        origin: `https://${OWNER_HOST}`,
        'sec-fetch-site': 'same-origin',
        'x-forwarded-proto': 'https',
        'content-type': 'application/json',
        'cf-access-jwt-assertion': await ownerToken(age, opts),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  const isConfirmRequired = async (res: Response) => {
    if (res.status !== 403) return false;
    const body = (await res.clone().json()) as { error?: string; window?: number };
    return body.error === 'confirm-required' && body.window === 600;
  };

  /** A fresh markdown doc filed on the board. */
  const makeDoc = async (): Promise<string> => {
    const docId = `fresh-doc-${++n}`;
    const file = join(dataDir, `${docId}.md`);
    writeFileSync(file, '# Riverbend launch notes\n\nBody.\n');
    const res = await post(`/workspaces/${board}/docs`, {
      docId,
      type: 'markdown',
      sourceUrl: file,
    });
    expect(res.status).toBe(200);
    expect((await post(`/workspaces/${board}/docs:attach`, { docId })).status).toBe(200);
    return docId;
  };
  const docExists = async (docId: string) =>
    (await local(`/workspaces/${board}/docs/${docId}?format=json`)).status === 200;

  /** A folder attachment set filed on the board. */
  const makeSet = async (): Promise<string> => {
    const folder = mkdtempSync(join(tmpdir(), 'fresh-set-'));
    writeFileSync(join(folder, 'README.md'), '# Saltmarsh\n');
    const res = await post('/workspaces', { folderPath: folder, hubWorkspaceId: board });
    expect(res.status).toBe(200);
    return ((await res.json()) as { workspaceId: string }).workspaceId;
  };
  const makeBoard = async (): Promise<string> => {
    const res = await post('/workspaces', { name: `Harborlight ${++n}` });
    return ((await res.json()) as { workspace: { id: string } }).workspace.id;
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'fresh-signin-'));
    handle = createServer({
      port: 0,
      dataDir,
      cfAccess: { teamDomain: TEAM_DOMAIN, audience: OWNER_AUD, jwks },
      shareLinkHosts: [SHARE_HOST],
      shareLinkAudience: SHARE_AUD,
      proxiedTrustedHosts: [OWNER_HOST],
      proxiedTrustedEmails: [OWNER_EMAIL],
      ownerEmail: OWNER_EMAIL,
      share: { config: ACCESS_SHARE_CONFIG, cfApi: mockCfApi() },
      requireSignInToWrite: false,
    });
    base = `http://127.0.0.1:${handle.port}`;
    board = await makeBoard();
    // A member, through a link, whose role the owner can raise. Only the
    // owner, signed in, lets a new address into the audience.
    const let_in = await asOwner(`/workspaces/${board}/audience`, 'POST', { add: [MEMBER] }, 0);
    expect(let_in.status).toBe(200);
    const link = (await (await post('/api/share/workspace', { workspaceId: board })).json()) as {
      link: { linkId: string };
    };
    const redeemed = await fetch(`${base}/s/${link.link.linkId}`, {
      redirect: 'manual',
      headers: { host: SHARE_HOST, ...CF_RAY, 'cf-access-jwt-assertion': await memberToken() },
    });
    expect(redeemed.status).toBe(302);
  });

  afterAll(async () => {
    await handle.stop();
    resetOwnerIdentities();
    rmSync(dataDir, { recursive: true, force: true });
  });

  describe('each counted route refuses a stale sign-in and changes nothing, then accepts a fresh one', () => {
    it('archiving a doc', async () => {
      const docId = await makeDoc();
      const path = `/workspaces/${board}/docs/${docId}/archive`;
      expect(await isConfirmRequired(await asOwner(path, 'POST', {}, STALE))).toBe(true);
      expect(await docExists(docId)).toBe(true);
      expect((await asOwner(path, 'POST', {}, 5)).status).toBe(200);
      expect(await docExists(docId)).toBe(false);
    });

    it('hard-deleting a doc', async () => {
      const docId = await makeDoc();
      const path = `/workspaces/${board}/docs/${docId}`;
      expect(await isConfirmRequired(await asOwner(path, 'DELETE', undefined, STALE))).toBe(true);
      expect(await docExists(docId)).toBe(true);
      expect((await asOwner(path, 'DELETE', undefined, 5)).status).toBe(200);
      expect(await docExists(docId)).toBe(false);
    });

    it('archiving an attachment set, and deleting one with or without purge', async () => {
      for (const path of [
        (s: string) => [`/workspaces/${board}/attachments/${s}/archive`, 'POST'],
        (s: string) => [`/workspaces/${board}/attachments/${s}`, 'DELETE'],
        (s: string) => [`/workspaces/${board}/attachments/${s}?purge=true`, 'DELETE'],
      ]) {
        const setId = await makeSet();
        const [p, method] = path(setId) as [string, string];
        expect(await isConfirmRequired(await asOwner(p, method, undefined, STALE))).toBe(true);
        const fresh = await asOwner(p, method, undefined, 5);
        expect(await isConfirmRequired(fresh)).toBe(false);
        expect(fresh.status).toBe(200);
      }
    });

    it('retiring a workspace, and un-retiring it stays instant', async () => {
      const ws = await makeBoard();
      const path = `/workspaces/${ws}/retired`;
      expect(await isConfirmRequired(await asOwner(path, 'PUT', { retired: true }, STALE))).toBe(
        true,
      );
      expect((await asOwner(path, 'PUT', { retired: true }, 5)).status).toBe(200);
      expect((await asOwner(path, 'PUT', { retired: false }, STALE)).status).toBe(200);
    });

    it('deleting a workspace', async () => {
      const ws = await makeBoard();
      expect(
        await isConfirmRequired(await asOwner(`/workspaces/${ws}`, 'DELETE', undefined, STALE)),
      ).toBe(true);
      expect((await local(`/workspaces/${ws}?format=json`)).status).toBe(200);
      expect((await asOwner(`/workspaces/${ws}`, 'DELETE', undefined, 5)).status).toBe(200);
      expect((await local(`/workspaces/${ws}?format=json`)).status).toBe(404);
    });

    it('raising a member to owner, while lowering one stays instant', async () => {
      const path = `/workspaces/${board}/members/${encodeURIComponent(MEMBER)}/role`;
      expect(await isConfirmRequired(await asOwner(path, 'POST', { role: 'owner' }, STALE))).toBe(
        true,
      );
      const roles = async () =>
        (
          (await (await local(`/workspaces/${board}/members`)).json()) as {
            members: Array<{ email: string; role?: string }>;
          }
        ).members.find((m) => m.email === MEMBER)?.role;
      expect(await roles()).toBe('member');
      expect((await asOwner(path, 'POST', { role: 'owner' }, 5)).status).toBe(200);
      expect(await roles()).toBe('owner');
      expect((await asOwner(path, 'POST', { role: 'member' }, STALE)).status).toBe(200);
      expect(await roles()).toBe('member');
    });

    it("letting an address into a board's audience, while taking one out stays instant", async () => {
      const path = `/workspaces/${board}/audience`;
      const match = '@riverbend.example';
      const audience = async () =>
        (
          (await (await local(`/workspaces/${board}/members`)).json()) as {
            audience?: Array<{ match: string }>;
          }
        ).audience?.map((a) => a.match) ?? [];
      expect(await isConfirmRequired(await asOwner(path, 'POST', { add: [match] }, STALE))).toBe(
        true,
      );
      expect(await audience()).not.toContain(match);
      expect((await asOwner(path, 'POST', { add: [match] }, 5)).status).toBe(200);
      expect(await audience()).toContain(match);
      const out = await asOwner(path, 'POST', { remove: [match] }, STALE);
      expect(out.status).toBe(200);
      expect(await audience()).not.toContain(match);
    });

    it('a new share link, a share, and switching sharing on — switching it off is never asked', async () => {
      for (const [path, body] of [
        ['/api/share/workspace', { workspaceId: board }],
        ['/api/share/link', { workspaceId: board }],
        ['/api/share/enabled', { enabled: true }],
      ] as const) {
        expect(await isConfirmRequired(await asOwner(path, 'POST', body, STALE))).toBe(true);
        const fresh = await asOwner(path, 'POST', body, 5);
        expect(await isConfirmRequired(fresh)).toBe(false);
      }
      // A page cannot change sharing at all (browser_cannot_operate); the point
      // here is only that the narrowing is not the refusal that asks.
      const off = await asOwner('/api/share/enabled', 'POST', { enabled: false }, STALE);
      expect(await isConfirmRequired(off)).toBe(false);
    });
  });

  describe('what never asks', () => {
    it('task and goal archives, a doc unarchive and removing a member, all with a stale sign-in', async () => {
      const task = (await (
        await post(`/workspaces/${board}/tasks`, {
          title: 'Sweep the Riverbend index',
          body: 'Agent can sweep the index so that search stays fresh.',
          author: { id: 'a-sweeper', name: 'Sweeper', kind: 'agent' },
        })
      ).json()) as { task: { id: string } };
      const archived = await asOwner(
        `/workspaces/${board}/tasks/${task.task.id}/archive`,
        'POST',
        {},
        STALE,
      );
      expect(archived.status).toBe(200);

      const docId = await makeDoc();
      const parked = await post(`/workspaces/${board}/docs/${docId}/archive`, {});
      expect(parked.status).toBe(200);
      const parkedId = ((await parked.json()) as { docId: string }).docId;
      const back = await asOwner(
        `/workspaces/${board}/docs/${parkedId}/unarchive`,
        'POST',
        {},
        STALE,
      );
      expect(back.status).toBe(200);

      const removed = await asOwner(
        `/workspaces/${board}/members/${encodeURIComponent(MEMBER)}`,
        'DELETE',
        undefined,
        STALE,
      );
      expect(await isConfirmRequired(removed)).toBe(false);
    });

    it('an agent on loopback with no person proof is never asked', async () => {
      const docId = await makeDoc();
      expect((await local(`/workspaces/${board}/docs/${docId}`, { method: 'DELETE' })).status).toBe(
        200,
      );
      const ws = await makeBoard();
      const agent = { id: 'a-sweeper', name: 'Sweeper', kind: 'agent' };
      expect(
        (await post(`/workspaces/${ws}/retired`, { retired: true, author: agent }, 'PUT')).status,
      ).toBe(200);
    });
  });

  describe('an iat is believed only off a verified token', () => {
    it('a forged token claiming a sign-in just now is refused outright and changes nothing', async () => {
      const docId = await makeDoc();
      const res = await asOwner(`/workspaces/${board}/docs/${docId}/archive`, 'POST', {}, 0, {
        forged: true,
      });
      expect(res.status).toBe(401);
      expect(await docExists(docId)).toBe(true);
    });

    it('a verified token with no iat, or one far in the future, is not fresh', async () => {
      const docId = await makeDoc();
      const path = `/workspaces/${board}/docs/${docId}/archive`;
      expect(await isConfirmRequired(await asOwner(path, 'POST', {}, null))).toBe(true);
      expect(await isConfirmRequired(await asOwner(path, 'POST', {}, -3600))).toBe(true);
      expect(await docExists(docId)).toBe(true);
    });
  });

  describe("the board's own session cookie", () => {
    const cookieFor = (claims: Parameters<typeof signSession>[0]) =>
      `cw_session=${signSession(claims, sessionKey(loadCookieKey(dataDir)))}`;
    /** An identity the roster holds, by way of one Access request. */
    const ownerId = async () => {
      const res = await asOwner('/api/auth/session', 'GET', undefined, 0);
      return ((await res.json()) as { user: { id: string } }).user.id;
    };
    const lock = (cookie: string, locked: boolean) =>
      local('/api/share/lock', {
        method: 'POST',
        headers: { cookie },
        body: JSON.stringify({ workspaceId: board, locked, reason: 'test' }),
      });

    it('a session from before sign-in times were kept is asked; one signed in just now is not', async () => {
      const id = await ownerId();
      const old = cookieFor({ ...mintSession(id), signedInAt: null });
      const signedInLongAgo = cookieFor({
        ...mintSession(id),
        signedInAt: Date.now() - STALE * 1000,
      });
      const fresh = cookieFor(mintSession(id));
      // Locking narrows access and never asks; unlocking widens it.
      expect((await lock(old, true)).status).toBe(200);
      expect(await isConfirmRequired(await lock(old, false))).toBe(true);
      expect(await isConfirmRequired(await lock(signedInLongAgo, false))).toBe(true);
      expect((await lock(fresh, false)).status).toBe(200);
    });
  });
  describe('"Sign in again"', () => {
    it("drops an Access person's token for this host and sends them back to the page", async () => {
      const res = await asOwner(
        '/api/auth/reauth?next=%2Fworkspaces%2Fw-1%2Fdocs%2Fd-1',
        'GET',
        undefined,
        STALE,
      );
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/workspaces/w-1/docs/d-1');
      expect(res.headers.get('set-cookie')).toMatch(/^CF_Authorization=; Path=\/; Max-Age=0/);
    });

    it('never redirects off this origin', async () => {
      const res = await asOwner('/api/auth/reauth?next=%2F%2Fevil.example', 'GET', undefined, 0);
      expect(res.headers.get('location')).toBe('/');
    });
  });
});
