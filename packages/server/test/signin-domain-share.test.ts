/**
 * Domain shares under Better Auth require a verified address (plan step 4,
 * choice 3): a board shared with `@harborlight.test` admits any address there
 * that Google — or, once passwords land, an emailed link — has verified,
 * whether or not Google names a Workspace domain (`hd`) for it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { ACCESS_SHARE_CONFIG, mockCfApi } from './access-share.ts';
import {
  CookieJar,
  type GoogleProfile,
  type GoogleStub,
  signInWithGoogle,
  startGoogleStub,
} from './google-stub.ts';

const HOST = 'workspaces.saltmarsh.test';
const ORIGIN = `https://${HOST}`;
const OWNER = 'owner@saltmarsh.test';
const TUNNEL = { 'cf-ray': '8a1b2c3d4e5f-SJC', 'x-forwarded-proto': 'https' };

describe('a domain share admits a verified address at that domain', () => {
  let dataDir: string;
  let google: GoogleStub;
  let server: ServerHandle;
  let board: string;

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
  /** Sign in with Google as `profile`, then ask for the shared board. */
  const boardAs = async (profile: GoogleProfile) => {
    const jar = new CookieJar();
    await signInWithGoogle(viaTunnel, ORIGIN, jar, google, profile);
    const res = await viaTunnel(`/workspaces/${board}?format=json`, {
      headers: { cookie: jar.header() },
    });
    return { jar, res };
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'signin-domain-share-'));
    google = startGoogleStub();
    server = createServer({
      port: 0,
      dataDir,
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
    const created = await local('/workspaces', {
      method: 'POST',
      body: JSON.stringify({ name: 'Harborlight partners' }),
    });
    expect(created.status).toBe(200);
    board = ((await created.json()) as { workspace: { id: string } }).workspace.id;
    // The owner admits the domain to the board, then shares it with them.
    server.shareLinks.addToAudience(board, ['@harborlight.test'], 'Owner');
    const shared = await local('/api/share/link', {
      method: 'POST',
      body: JSON.stringify({ workspaceId: board, allowDomains: ['@harborlight.test'] }),
    });
    expect(shared.status, await shared.clone().text()).toBe(200);
  });

  afterAll(async () => {
    await server.stop();
    google.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('admits Alice at the domain, verified by Google, with no Workspace domain named', async () => {
    const { res } = await boardAs({
      sub: 'g-alice',
      email: 'alice@harborlight.test',
      email_verified: true,
      name: 'Alice',
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Harborlight partners');
  });

  it('CONTROL: admits a Workspace account at the domain too', async () => {
    const { res } = await boardAs({
      sub: 'g-harborlight-staff',
      email: 'staff@harborlight.test',
      email_verified: true,
      name: 'Alice',
      hd: 'harborlight.test',
    });
    expect(res.status).toBe(200);
  });

  it('refuses Bob at another domain: no account is made', async () => {
    const { jar, res } = await boardAs({
      sub: 'g-bob',
      email: 'bob@riverbend.test',
      email_verified: true,
      name: 'Bob',
    });
    expect(jar.cookies.has('__Host-cw-ba.session_token')).toBe(false);
    expect(res.status).toBe(401);
  });

  it('refuses an unverified address at the domain: no account is made', async () => {
    const { jar, res } = await boardAs({
      sub: 'g-unverified',
      email: 'newcomer@harborlight.test',
      email_verified: false,
      name: 'Bob',
    });
    expect(jar.cookies.has('__Host-cw-ba.session_token')).toBe(false);
    expect(res.status).toBe(401);
  });

  it('refuses a look-alike domain', async () => {
    const { res } = await boardAs({
      sub: 'g-lookalike',
      email: 'alice@harborlight.test.riverbend.test',
      email_verified: true,
      name: 'Alice',
    });
    expect(res.status).toBe(401);
  });
});
