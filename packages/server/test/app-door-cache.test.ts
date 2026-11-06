/**
 * Every answer at an app's door tells Cloudflare not to keep it, through the
 * real route table, because an edge copy of an app's script is what a reader
 * cannot reload past. The last case is the control: an address that is not an
 * app's carries no such header.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { type DevServerFixture, startDevServer } from './app-dev-server-fixture.ts';

const RULE = 'cloudflare-cdn-cache-control';

describe('the cache rule on an app door', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let dev: DevServerFixture;
  let ws: string;
  let prefix: string;
  const local = () => ({ 'content-type': 'application/json', host: `localhost:${handle.port}` });
  const door = (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, { redirect: 'manual', ...init });
  const expectNoStore = async (path: string, init: RequestInit = {}) => {
    const r = await door(path, init);
    expect(r.headers.get(RULE)).toBe('no-store');
    return r;
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'app-door-cache-'));
    dev = startDevServer();
    handle = createServer({ port: 0, dataDir });
    base = `http://127.0.0.1:${handle.port}`;
    const created = await fetch(`${base}/workspaces`, {
      method: 'POST',
      headers: local(),
      body: JSON.stringify({ name: 'Harborlight' }),
    });
    ws = ((await created.json()) as { workspace: { id: string } }).workspace.id;
    const attached = await fetch(`${base}/workspaces/${ws}/apps`, {
      method: 'POST',
      headers: local(),
      body: JSON.stringify({ docId: 'harborlight-site', origin: dev.origin }),
    });
    prefix = ((await attached.json()) as { prefix: string }).prefix;
  });
  afterAll(async () => {
    await handle.stop();
    await dev.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("overrides the dev server's own rule on a script", async () => {
    const r = await expectNoStore(`${prefix}cached.js`);
    expect(r.status).toBe(200);
    expect(await r.text()).toBe('export const version = 1;');
  });

  it('is on a 304 for a script the reader already holds', async () => {
    const r = await expectNoStore(`${prefix}cached.js`, {
      headers: { 'if-none-match': '"harborlight-1"' },
    });
    expect(r.status).toBe(304);
  });

  it('is on a compressed file', async () => {
    const r = await expectNoStore(`${prefix}site.css`, {
      headers: { 'accept-encoding': 'gzip' },
    });
    expect(r.status).toBe(200);
  });

  it('is on the host page, the frame and a HEAD', async () => {
    expect((await expectNoStore(prefix)).status).toBe(200);
    expect((await expectNoStore(`${prefix}?cw-frame=1`)).status).toBe(200);
    expect((await expectNoStore(`${prefix}cached.js`, { method: 'HEAD' })).status).toBe(200);
  });

  it('is on the redirect from the bare address', async () => {
    const r = await expectNoStore(prefix.replace(/\/$/, ''));
    expect(r.status).toBe(302);
  });

  it("is on the door's error answers, its own and a gate's above it", async () => {
    expect((await expectNoStore(`/workspaces/${ws}/apps/no-such-app/`)).status).toBe(404);
    expect((await expectNoStore(`${prefix}a%2f..%2f..%2fb`)).status).toBeGreaterThanOrEqual(400);
    expect((await expectNoStore('/workspaces/w-nowhere/apps/site/')).status).toBeGreaterThanOrEqual(
      400,
    );
    const refused = await expectNoStore(`${prefix}echo`, {
      method: 'PUT',
      headers: { host: `localhost:${handle.port}`, origin: 'https://elsewhere.example' },
    });
    expect(refused.status).toBeGreaterThanOrEqual(400);
  });

  it('is not on an address outside the door', async () => {
    const r = await door(`/workspaces/${ws}/apps`);
    expect(r.headers.get(RULE)).toBeNull();
    const board = await door(`/workspaces/${ws}`, {
      headers: { host: `localhost:${handle.port}` },
    });
    expect(board.headers.get(RULE)).toBeNull();
  });

  // Last: it stops the dev server.
  it('is on the waiting page', async () => {
    await dev.stop();
    const r = await expectNoStore(prefix);
    expect(r.status).toBe(503);
    expect(r.headers.get('x-cw-app-down')).toBe('1');
  });
});
