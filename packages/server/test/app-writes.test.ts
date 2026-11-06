/**
 * An attached app can save through the board, not only read.
 *
 * `POST`, `PUT`, `PATCH` and `DELETE` under `apps/<id>/…` pass through to the
 * app's own origin with the body and the write headers the app needs, and
 * the app's status and body come back. Who may write is one rule
 * (`appWriteRefusal` in `app-proxy.ts`): a signed-in board member or the
 * owner, from a page on the board's own origin. A share-link visitor's write
 * and a write from any other origin are refused before the app sees them.
 *
 * Driven through the real server against a stand-in dev server; fixtures
 * are the fictional Harborlight events calendar.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import {
  ACCESS_SHARE_CONFIG,
  type AccessHarness,
  type MintedShare,
  accessHarness,
  mintAccessShare,
  mockCfApi,
} from './access-share.ts';
import { type DevServerFixture, startDevServer } from './app-dev-server-fixture.ts';

const MEMBER = 'reviewer@partner.example';

interface Echo {
  method: string;
  body: string;
  headers: Record<string, string>;
}

async function boardWithApp(
  base: string,
  port: number,
  name: string,
  origin: string,
): Promise<{ ws: string; prefix: string }> {
  const headers = { 'content-type': 'application/json', host: `localhost:${port}` };
  const created = await fetch(`${base}/workspaces`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name }),
  });
  const ws = ((await created.json()) as { workspace: { id: string } }).workspace.id;
  const attached = await fetch(`${base}/workspaces/${ws}/apps`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ docId: `${name.toLowerCase()}-insights`, origin }),
  });
  expect(attached.status).toBe(200);
  return { ws, prefix: ((await attached.json()) as { prefix: string }).prefix };
}

describe('the owner writing to an attached app', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let host: string;
  let dev: DevServerFixture;
  let app: { ws: string; prefix: string };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'app-writes-owner-'));
    dev = startDevServer();
    // Signing in is the write gate's question, asked above every route and
    // tested with it; this suite asks what the app route does past it.
    handle = createServer({ port: 0, dataDir, requireSignInToWrite: false });
    base = `http://127.0.0.1:${handle.port}`;
    host = `localhost:${handle.port}`;
    app = await boardWithApp(base, handle.port, 'Harborlight', dev.origin);
  });
  afterAll(async () => {
    await handle.stop();
    await dev.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const write = (
    method: string,
    path: string,
    init: { headers?: Record<string, string>; body?: string } = {},
  ) =>
    fetch(`${base}${app.prefix}${path}`, {
      method,
      headers: { host, origin: `http://${host}`, ...init.headers },
      ...(init.body !== undefined ? { body: init.body } : {}),
      redirect: 'manual',
    });

  it('passes each write method through with its body and headers, and relays the status', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const body = JSON.stringify({ event: 'Riverbend walk', method });
      const r = await write(method, 'echo?status=201', {
        headers: {
          'content-type': 'application/json',
          'idempotency-key': `key-${method}`,
          cookie: 'cw_session=secret',
          authorization: 'Bearer not-for-the-app',
        },
        body,
      });
      expect(r.status, method).toBe(201);
      const seen = (await r.json()) as Echo;
      expect(seen.method).toBe(method);
      expect(seen.body).toBe(body);
      expect(seen.headers['content-type']).toBe('application/json');
      expect(seen.headers['idempotency-key']).toBe(`key-${method}`);
      // The reader's credentials stay on this side, on a write as on a read.
      expect(seen.headers.cookie).toBeUndefined();
      expect(seen.headers.authorization).toBeUndefined();
    }
    expect(dev.writes().map((w) => w.method)).toEqual(['POST', 'PUT', 'PATCH', 'DELETE']);
  });

  it("relays the app's own error status and body", async () => {
    const r = await write('POST', 'echo?status=422', { body: 'bad row' });
    expect(r.status).toBe(422);
    expect(((await r.json()) as Echo).body).toBe('bad row');
  });

  it('refuses a write from another origin, or with none, before the app sees it', async () => {
    const before = dev.writes().length;
    for (const origin of ['https://evil.example', 'null', `https://${host}`, undefined]) {
      const r = await fetch(`${base}${app.prefix}echo`, {
        method: 'POST',
        headers: { host, ...(origin !== undefined ? { origin } : {}) },
        body: 'forged',
      });
      // A foreign page is already refused by the cross-origin write gate; a
      // request with no Origin, which that gate lets through as an agent,
      // is refused by the app route's own rule.
      expect(r.status, String(origin)).toBe(403);
    }
    expect(dev.writes().length).toBe(before);
    const bare = await fetch(`${base}${app.prefix}echo`, {
      method: 'POST',
      headers: { host },
      body: 'no origin',
    });
    expect(((await bare.json()) as { error: string }).error).toBe('app_write_cross_origin');
  });

  it('keeps the bare POST as "ask again"', async () => {
    const r = await fetch(`${base}${app.prefix.replace(/\/$/, '')}`, {
      method: 'POST',
      headers: { host },
    });
    expect(r.status).toBe(409);
    expect(((await r.json()) as { error: string }).error).toBe('app_answering');
  });
});

describe('a share-link visitor writing to an attached app', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let dev: DevServerFixture;
  let access: AccessHarness;
  let share: MintedShare;
  let app: { ws: string; prefix: string };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'app-writes-share-'));
    dev = startDevServer();
    access = await accessHarness(MEMBER);
    handle = createServer({ port: 0, dataDir, ...access.serverOptions });
    base = `http://127.0.0.1:${handle.port}`;
    app = await boardWithApp(base, handle.port, 'Harborlight', dev.origin);
    share = await mintAccessShare(base, { ...access, shareLinks: handle.shareLinks }, app.ws);
  });
  afterAll(async () => {
    await handle.stop();
    await dev.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('reads the app but is refused a write from its own page', async () => {
    const read = await fetch(`${base}${app.prefix}echo`, { headers: share.headers });
    expect(read.status).toBe(200);
    const r = await fetch(`${base}${app.prefix}echo`, {
      method: 'POST',
      headers: { ...share.headers, origin: `http://${share.host}` },
      body: 'from a share link',
    });
    expect(r.status).toBe(403);
    expect(((await r.json()) as { error: string }).error).toBe('app_write_not_member');
    expect(dev.writes()).toEqual([]);
  });
});

describe('a board member on the collaboration hostname writing to an attached app', () => {
  const COLLAB_AUD = 'aud-for-the-collab-app';
  const TUNNEL_HOST = 'workspaces.example.com';
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let dev: DevServerFixture;
  let access: AccessHarness;
  let app: { ws: string; prefix: string };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'app-writes-collab-'));
    dev = startDevServer();
    access = await accessHarness(MEMBER);
    handle = createServer({
      port: 0,
      dataDir,
      cfAccess: { ...access.serverOptions.cfAccess, audience: COLLAB_AUD },
      share: {
        config: { ...ACCESS_SHARE_CONFIG, publicHostname: 'links.example.com' },
        cfApi: mockCfApi(),
      },
      proxiedTrustedEmails: ['owner@example.com'],
      accessTunnelHosts: [TUNNEL_HOST],
    });
    base = `http://127.0.0.1:${handle.port}`;
    app = await boardWithApp(base, handle.port, 'Harborlight', dev.origin);
    handle.shareLinks.addToAudience(app.ws, ['@partner.example'], 'Bryan');
    const shared = await fetch(`${base}/api/share/link`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: `localhost:${handle.port}` },
      body: JSON.stringify({ workspaceId: app.ws, allowDomains: ['@partner.example'] }),
    });
    expect(shared.status, await shared.clone().text()).toBe(200);
  });
  afterAll(async () => {
    await handle.stop();
    await dev.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const asMember = async (origin: string) =>
    fetch(`${base}${app.prefix}echo`, {
      method: 'PUT',
      headers: {
        host: TUNNEL_HOST,
        'cf-ray': '8a1b2c3d4e5f-SJC',
        'x-forwarded-proto': 'https',
        'cf-access-jwt-assertion': await access.signJwt(COLLAB_AUD, MEMBER),
        origin,
        'content-type': 'application/json',
      },
      body: '{"saved":true}',
    });

  it("saves through the board from the board's own origin", async () => {
    const r = await asMember(`https://${TUNNEL_HOST}`);
    expect(r.status, await r.clone().text()).toBe(200);
    expect(((await r.json()) as Echo).body).toBe('{"saved":true}');
    expect(dev.writes()).toEqual([{ method: 'PUT', body: '{"saved":true}' }]);
  });

  it('is refused the same write from another origin', async () => {
    const r = await asMember('https://workspaces.example.com.evil.example');
    expect(r.status).toBe(403);
    expect(dev.writes().length).toBe(1);
  });
});
