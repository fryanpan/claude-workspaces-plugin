/**
 * A websocket is authorized once, at its upgrade, so an app's socket has to be
 * refused to exactly the people its page is refused to. Each case asks the
 * page and the socket the same question through the real route table, and the
 * page's answer is the control: a refusal here is the gate, not a socket that
 * could never have opened, because the first case opens one.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
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
import {
  RELOAD_TOKEN,
  type ReloadServerFixture,
  startReloadServer,
} from './app-reload-server-fixture.ts';
import { type OpenedSocket, handshakeStatus, nextFrame, openSocket } from './app-socket-client.ts';
import { waitFor } from './wait-for.ts';

const MEMBER = 'reviewer@partner.example';
const OUTSIDER = 'someone@elsewhere.example';
const OFFER = { 'Sec-WebSocket-Protocol': 'vite-hmr' };

interface Board {
  ws: string;
  prefix: string;
  app: string;
}

describe('who may open an app socket', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let dev: ReloadServerFixture;
  let access: AccessHarness;
  let share: MintedShare;
  let mine: Board;
  let theirs: Board;
  const opened: OpenedSocket[] = [];

  const page = (path: string, headers: Record<string, string>) =>
    fetch(`${base}${path}`, { headers, redirect: 'manual' });
  const socket = (path: string, headers: Record<string, string>) =>
    handshakeStatus(handle.port, path, { ...OFFER, ...headers });
  const asVisitor = async (path: string): Promise<OpenedSocket> => {
    const s = await openSocket(
      `ws://127.0.0.1:${handle.port}${path}?token=${RELOAD_TOKEN}`,
      ['vite-hmr'],
      share.headers,
    );
    opened.push(s);
    return s;
  };
  const boardWithApp = async (name: string): Promise<Board> => {
    const headers = { 'content-type': 'application/json', host: `localhost:${handle.port}` };
    const created = await fetch(`${base}/workspaces`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name }),
    });
    const ws = ((await created.json()) as { workspace: { id: string } }).workspace.id;
    const attached = await fetch(`${base}/workspaces/${ws}/apps`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ docId: `${name.toLowerCase()}-site`, origin: dev.origin }),
    });
    expect(attached.status).toBe(200);
    const body = (await attached.json()) as { docId: string; prefix: string };
    return { ws, prefix: body.prefix, app: body.docId };
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'app-socket-access-'));
    dev = startReloadServer();
    access = await accessHarness(MEMBER);
    handle = createServer({ port: 0, dataDir, ...access.serverOptions });
    base = `http://127.0.0.1:${handle.port}`;
    mine = await boardWithApp('Harborlight');
    theirs = await boardWithApp('Riverbend');
    share = await mintAccessShare(base, { ...access, shareLinks: handle.shareLinks }, mine.ws);
  });
  afterEach(async () => {
    for (const s of opened.splice(0)) s.ws.close();
    await waitFor(() => dev.open() === 0, { describe: 'every channel to close' });
  });
  afterAll(async () => {
    await handle.stop();
    await dev.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("opens for a share visitor on their own board's app, as the page does", async () => {
    expect((await page(mine.prefix, share.headers)).status).toBe(200);
    const s = await asVisitor(mine.prefix);
    expect(await nextFrame(s)).toBe('{"type":"connected"}');
    dev.broadcast('{"type":"full-reload"}');
    expect(await nextFrame(s, 1)).toBe('{"type":"full-reload"}');
  });

  it('carries a share visitor nothing to the dev server: reading is not writing', async () => {
    const s = await asVisitor(mine.prefix);
    await nextFrame(s);
    const sent = dev.received().length;
    s.ws.send('from a share visitor');
    // The socket stays up, so the frame was dropped rather than refused.
    s.ws.send('and again');
    dev.broadcast('{"type":"still-open"}');
    expect(await nextFrame(s, 1)).toBe('{"type":"still-open"}');
    expect(dev.received().length).toBe(sent);
  });

  it('refuses a request with no Access token, as the page is', async () => {
    const before = dev.handshakes().length;
    const headers = { host: share.host };
    expect((await page(mine.prefix, headers)).status).toBeGreaterThanOrEqual(400);
    expect(await socket(mine.prefix, headers)).toBeGreaterThanOrEqual(400);
    expect(dev.handshakes().length).toBe(before);
  });

  it('refuses an address the share does not name, as the page is', async () => {
    const before = dev.handshakes().length;
    const stranger = {
      host: share.host,
      'cf-access-jwt-assertion': await access.signJwt('wrong-audience', OUTSIDER),
    };
    expect((await page(mine.prefix, stranger)).status).toBeGreaterThanOrEqual(400);
    expect(await socket(mine.prefix, stranger)).toBeGreaterThanOrEqual(400);
    expect(dev.handshakes().length).toBe(before);
  });

  it("refuses another board's app, by its own path or by this board's", async () => {
    const before = dev.handshakes().length;
    expect((await page(theirs.prefix, share.headers)).status).toBeGreaterThanOrEqual(400);
    expect(await socket(theirs.prefix, share.headers)).toBeGreaterThanOrEqual(400);
    const borrowed = `/workspaces/${mine.ws}/apps/${theirs.app}/`;
    expect((await page(borrowed, share.headers)).status).toBeGreaterThanOrEqual(400);
    expect(await socket(borrowed, share.headers)).toBeGreaterThanOrEqual(400);
    expect(dev.handshakes().length).toBe(before);
  });

  it('hangs up on a share that is revoked, and on the dev server too', async () => {
    const second = await mintAccessShare(
      base,
      { ...access, shareLinks: handle.shareLinks },
      mine.ws,
    );
    const s = await openSocket(
      `ws://127.0.0.1:${handle.port}${mine.prefix}?token=${RELOAD_TOKEN}`,
      ['vite-hmr'],
      second.headers,
    );
    opened.push(s);
    await nextFrame(s);
    expect(dev.open()).toBe(1);
    const del = await fetch(`${base}/api/share/${second.shareId}`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    await waitFor(() => s.closed(), { describe: 'the socket to be closed' });
    await waitFor(() => dev.open() === 0, { describe: 'the dev server connection to end' });
  });

  it('drops the frames of a browser that proved nobody where sign-in is required', async () => {
    const boardOrigin = `http://127.0.0.1:${handle.port}`;
    const s = await openSocket(
      `ws://127.0.0.1:${handle.port}${mine.prefix}?token=${RELOAD_TOKEN}`,
      ['vite-hmr'],
      { origin: boardOrigin },
    );
    opened.push(s);
    await nextFrame(s);
    const sent = dev.received().length;
    s.ws.send('from nobody');
    dev.broadcast('{"type":"still-open"}');
    expect(await nextFrame(s, 1)).toBe('{"type":"still-open"}');
    expect(dev.received().length).toBe(sent);
  });
});

describe('a board member on the collaboration hostname, in an app socket', () => {
  const COLLAB_AUD = 'aud-for-the-collab-app';
  const TUNNEL_HOST = 'workspaces.example.com';
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let dev: ReloadServerFixture;
  let access: AccessHarness;
  let prefix: string;
  const local = () => ({ 'content-type': 'application/json', host: `localhost:${handle.port}` });

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'app-socket-member-'));
    dev = startReloadServer();
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
    const created = await fetch(`${base}/workspaces`, {
      method: 'POST',
      headers: local(),
      body: JSON.stringify({ name: 'Harborlight' }),
    });
    const ws = ((await created.json()) as { workspace: { id: string } }).workspace.id;
    const attached = await fetch(`${base}/workspaces/${ws}/apps`, {
      method: 'POST',
      headers: local(),
      body: JSON.stringify({ docId: 'harborlight-site', origin: dev.origin }),
    });
    prefix = ((await attached.json()) as { prefix: string }).prefix;
    handle.shareLinks.addToAudience(ws, ['@partner.example'], 'Bryan');
    const shared = await fetch(`${base}/api/share/link`, {
      method: 'POST',
      headers: local(),
      body: JSON.stringify({ workspaceId: ws, allowDomains: ['@partner.example'] }),
    });
    expect(shared.status, await shared.clone().text()).toBe(200);
  });
  afterAll(async () => {
    await handle.stop();
    await dev.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('reaches the dev server, where a read-only visitor does not', async () => {
    const s = await openSocket(
      `ws://127.0.0.1:${handle.port}${prefix}?token=${RELOAD_TOKEN}`,
      ['vite-hmr'],
      {
        host: TUNNEL_HOST,
        origin: `https://${TUNNEL_HOST}`,
        'cf-ray': '8a1b2c3d4e5f-SJC',
        'x-forwarded-proto': 'https',
        'cf-access-jwt-assertion': await access.signJwt(COLLAB_AUD, MEMBER),
      },
    );
    await nextFrame(s);
    s.ws.send('from a member');
    await waitFor(() => dev.received().includes('from a member'), {
      describe: "the member's frame at the dev server",
    });
    s.ws.close();
  });
});
