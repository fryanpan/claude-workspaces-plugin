/**
 * Who may read an attached app: exactly who may read a mock on the same
 * board. Two visitor kinds, through the real route table:
 *
 *   - a share visitor, admitted by Cloudflare Access to one board's share
 *     hostname, whose scope is that board;
 *   - a collaborator on the collaboration hostname, whose boards are the
 *     ones whose shares name them.
 *
 * Each reads their own board's app, and is refused another board's app, a
 * write, and a path that leaves the app. A request with no Access token is
 * refused before it reaches any of it.
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
const OUTSIDER = 'someone@elsewhere.example';

/** Make a board with one app on it; answers the board id and the app prefix. */
async function boardWithApp(
  base: string,
  port: number,
  name: string,
  origin: string,
): Promise<{ ws: string; prefix: string; app: string }> {
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
    body: JSON.stringify({ docId: `${name.toLowerCase().replace(/\s+/g, '-')}-site`, origin }),
  });
  expect(attached.status).toBe(200);
  const body = (await attached.json()) as { docId: string; prefix: string };
  return { ws, prefix: body.prefix, app: body.docId };
}

describe('a share visitor and an attached app', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let dev: DevServerFixture;
  let access: AccessHarness;
  let share: MintedShare;
  let mine: { ws: string; prefix: string; app: string };
  let theirs: { ws: string; prefix: string; app: string };

  const asVisitor = (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, { ...init, headers: share.headers, redirect: 'manual' });

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'app-access-share-'));
    dev = startDevServer();
    access = await accessHarness(MEMBER);
    handle = createServer({ port: 0, dataDir, ...access.serverOptions });
    base = `http://127.0.0.1:${handle.port}`;
    mine = await boardWithApp(base, handle.port, 'Harborlight', dev.origin);
    theirs = await boardWithApp(base, handle.port, 'Riverbend', dev.origin);
    share = await mintAccessShare(base, access, mine.ws);
  });
  afterAll(async () => {
    await handle.stop();
    await dev.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("reads its own board's app: the host page, the frame and a file", async () => {
    const host = await asVisitor(mine.prefix);
    expect(host.status).toBe(200);
    expect(await host.text()).toContain('cw-frame=1');
    const frame = await asVisitor(`${mine.prefix}?cw-frame=1`);
    expect(frame.status).toBe(200);
    expect(await frame.text()).toContain('claude-feedback-widget');
    const css = await asVisitor(`${mine.prefix}site.css`);
    expect(css.status).toBe(200);
    expect(await css.text()).toBe('h1{color:#036}');
  });

  it("is refused another board's app, by its own path or by this board's", async () => {
    const direct = await asVisitor(`${theirs.prefix}site.css`);
    expect(direct.status).toBeGreaterThanOrEqual(400);
    expect(await direct.text()).not.toContain('#036');
    const borrowed = await asVisitor(`/workspaces/${mine.ws}/apps/${theirs.app}/site.css`);
    expect(borrowed.status).toBeGreaterThanOrEqual(400);
    expect(await borrowed.text()).not.toContain('#036');
  });

  it('is refused an attach and a write', async () => {
    const attach = await asVisitor(`/workspaces/${mine.ws}/apps`, {
      method: 'POST',
      body: JSON.stringify({ docId: 'visitor-site', origin: dev.origin }),
    });
    expect(attach.status).toBeGreaterThanOrEqual(400);
    const write = await asVisitor(`${mine.prefix}echo`, { method: 'POST' });
    expect(write.status).toBeGreaterThanOrEqual(400);
  });

  it('cannot leave the app by its path', async () => {
    const r = await asVisitor(`${mine.prefix}%2F%2F127.0.0.1:${handle.port}/api/deploy`);
    expect(r.status).toBe(400);
    const climbed = await asVisitor(`${mine.prefix}%2e%2e/%2e%2e/%2e%2e/api/share`);
    expect(climbed.status).toBeGreaterThanOrEqual(400);
  });

  it('is refused without an Access token', async () => {
    const r = await fetch(`${base}${mine.prefix}site.css`, { headers: { host: share.host } });
    expect(r.status).toBe(401);
    expect(await r.text()).not.toContain('#036');
  });
});

describe('a collaborator on the collaboration hostname and an attached app', () => {
  const COLLAB_AUD = 'aud-for-the-collab-app';
  const TUNNEL_HOST = 'workspaces.example.com';
  const CF_RAY = { 'cf-ray': '8a1b2c3d4e5f-SJC' };
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let dev: DevServerFixture;
  let access: AccessHarness;
  let mine: { ws: string; prefix: string; app: string };
  let theirs: { ws: string; prefix: string; app: string };

  const as = async (email: string | null, path: string) =>
    fetch(`${base}${path}`, {
      headers: {
        host: TUNNEL_HOST,
        ...CF_RAY,
        ...(email ? { 'cf-access-jwt-assertion': await access.signJwt(COLLAB_AUD, email) } : {}),
      },
      redirect: 'manual',
    });

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'app-access-collab-'));
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
    mine = await boardWithApp(base, handle.port, 'Harborlight', dev.origin);
    theirs = await boardWithApp(base, handle.port, 'Riverbend', dev.origin);
    const shared = await fetch(`${base}/api/share/link`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: `localhost:${handle.port}` },
      body: JSON.stringify({ workspaceId: mine.ws, allowDomains: ['@partner.example'] }),
    });
    expect(shared.status, await shared.clone().text()).toBe(200);
  });
  afterAll(async () => {
    await handle.stop();
    await dev.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("lets a member of the board read its app's frame with the widget", async () => {
    const r = await as(MEMBER, `${mine.prefix}?cw-frame=1`);
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain('<h1 id="title">Harborlight events</h1>');
    expect(html).toContain('claude-feedback-widget');
  });

  it("refuses the same member another board's app", async () => {
    const r = await as(MEMBER, `${theirs.prefix}site.css`);
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(await r.text()).not.toContain('#036');
  });

  it('refuses an admitted email the board was never given', async () => {
    const r = await as(OUTSIDER, `${mine.prefix}site.css`);
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(await r.text()).not.toContain('#036');
  });

  it('refuses a request with no Access token', async () => {
    const r = await as(null, `${mine.prefix}site.css`);
    expect(r.status).toBe(401);
  });
});
