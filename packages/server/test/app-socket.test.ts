/**
 * An attached app's own websocket reaches its dev server through the board.
 *
 * Driven through the real route table against a dev server that keeps Vite's
 * rules (`app-reload-server-fixture.ts`). These sockets are the owner's, from
 * loopback; who else may open one is `app-socket-access.test.ts`, and real
 * Vite in a real browser is `packages/widget/test/app-hmr.test.ts`.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isAppSocketRequest } from '../src/routes/app-socket.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import {
  RELOAD_TOKEN,
  type ReloadServerFixture,
  startReloadServer,
} from './app-reload-server-fixture.ts';
import { type OpenedSocket, handshakeStatus, nextFrame, openSocket } from './app-socket-client.ts';
import { waitFor } from './wait-for.ts';

describe('which requests are an app socket', () => {
  const at = (method: string, upgrade: boolean) =>
    new Request('http://localhost/workspaces/w-1/apps/site/ws', {
      method,
      headers: upgrade ? { upgrade: 'WebSocket' } : {},
    });
  const SOCKET_PATH = '/workspaces/w-1/apps/site/ws';

  it('claims a GET with the header, and neither half alone', () => {
    expect(isAppSocketRequest(at('GET', true), SOCKET_PATH)).toBe(true);
    expect(isAppSocketRequest(at('GET', false), SOCKET_PATH)).toBe(false);
    expect(isAppSocketRequest(at('POST', true), SOCKET_PATH)).toBe(false);
  });

  it('leaves the bare address to the page, which redirects it', () => {
    expect(isAppSocketRequest(at('GET', true), '/workspaces/w-1/apps/site')).toBe(false);
  });
});

describe('an app socket through the board', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let dev: ReloadServerFixture;
  let ws = '';
  let app = '';
  let prefix = '';
  const opened: OpenedSocket[] = [];

  const boardOrigin = () => `http://127.0.0.1:${handle.port}`;
  const socketUrl = (search = `?token=${RELOAD_TOKEN}`) =>
    `ws://127.0.0.1:${handle.port}${prefix}${search}`;
  /** The socket the host page opens: on the board's origin, as `vite-hmr`. */
  const open = async (url = socketUrl(), headers: Record<string, string> = {}) => {
    const s = await openSocket(url, ['vite-hmr'], { origin: boardOrigin(), ...headers });
    opened.push(s);
    return s;
  };
  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'app-socket-'));
    handle = createServer({ port: 0, dataDir, requireSignInToWrite: false });
    base = boardOrigin();
    dev = startReloadServer();
    const created = await post('/workspaces', { name: 'Harborlight events' });
    ws = ((await created.json()) as { workspace: { id: string } }).workspace.id;
    const attached = await post(`/workspaces/${ws}/apps`, {
      docId: 'harborlight-site',
      origin: dev.origin,
      servesPrefix: true,
    });
    expect(attached.status).toBe(200);
    const body = (await attached.json()) as { docId: string; prefix: string };
    app = body.docId;
    prefix = body.prefix;
    dev.setBase(prefix);
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

  it('carries what the dev server says, its first frame included', async () => {
    const s = await open();
    expect(await nextFrame(s)).toBe('{"type":"connected"}');
    expect(s.ws.protocol).toBe('vite-hmr');
    dev.broadcast('{"type":"full-reload"}');
    expect(await nextFrame(s, 1)).toBe('{"type":"full-reload"}');
  });

  it("reaches the dev server at the board's prefix, with the app's token", async () => {
    const before = dev.handshakes().length;
    await open();
    const seen = dev.handshakes()[before];
    expect(seen?.path).toBe(prefix);
    expect(seen?.search).toBe(`?token=${RELOAD_TOKEN}`);
    expect(seen?.protocol).toBe('vite-hmr');
  });

  it('keeps the relay mark and the reader off the dev server', async () => {
    const before = dev.handshakes().length;
    await open(socketUrl(`?token=${RELOAD_TOKEN}&cw-via=mock-frame`), {
      cookie: 'cw_session=reader',
      authorization: 'Bearer reader',
    });
    const seen = dev.handshakes()[before];
    expect(seen?.search).toBe(`?token=${RELOAD_TOKEN}`);
    expect(Object.keys(seen?.headers ?? {})).not.toContain('cookie');
    expect(Object.keys(seen?.headers ?? {})).not.toContain('authorization');
    expect(Object.keys(seen?.headers ?? {})).not.toContain('origin');
    expect(seen?.headers.host).toBe(`127.0.0.1:${dev.port}`);
  });

  it('carries text and binary frames both ways, byte for byte', async () => {
    const s = await open();
    const sent = dev.received().length;
    s.ws.send('{"type":"custom","event":"harborlight"}');
    s.ws.send(new Uint8Array([0, 255, 7]));
    await waitFor(() => dev.received().length === sent + 2, { describe: 'both frames upstream' });
    expect(dev.received().slice(sent)).toEqual([
      '{"type":"custom","event":"harborlight"}',
      [0, 255, 7],
    ]);
    dev.broadcast(new Uint8Array([9, 0, 128]));
    expect(await nextFrame(s, 1)).toEqual([9, 0, 128]);
  });

  it("gives the reader the dev server's close code and reason", async () => {
    const s = await open();
    await nextFrame(s);
    dev.closeAll(4100, 'harborlight restarting');
    expect(await waitFor(() => s.closed())).toBe('4100 harborlight restarting');
  });

  it("gives the dev server the reader's close code, and frees its connection", async () => {
    const s = await open();
    await nextFrame(s);
    const ended = dev.closes().length;
    s.ws.close(4200);
    await waitFor(() => dev.open() === 0, { describe: 'the channel to close' });
    expect(dev.closes()[ended]).toBe('4200 ');
  });

  it('refuses a page on another origin, and an opaque frame, before dialling', async () => {
    const before = dev.handshakes().length;
    const path = `${prefix}?token=${RELOAD_TOKEN}`;
    const offered = { 'Sec-WebSocket-Protocol': 'vite-hmr' };
    expect(
      await handshakeStatus(handle.port, path, { ...offered, Origin: 'https://evil.example' }),
    ).toBe(403);
    expect(await handshakeStatus(handle.port, path, { ...offered, Origin: 'null' })).toBe(403);
    // A dev server on this machine is admitted to REST reads, and is not the
    // board: its page has no reason to open this.
    expect(
      await handshakeStatus(handle.port, path, { ...offered, Origin: 'http://localhost:3000' }),
    ).toBe(403);
    expect(dev.handshakes().length).toBe(before);
  });

  it('drops the frames of a caller that named no origin, and still carries reloads', async () => {
    // Not a browser, so it is held to what a write with no `Origin` is held to.
    const s = await openSocket(socketUrl(), ['vite-hmr']);
    opened.push(s);
    await nextFrame(s);
    const sent = dev.received().length;
    s.ws.send('from nowhere');
    // A second socket's frame arriving after it is the proof the first went nowhere.
    const writer = await open();
    writer.ws.send('from the board');
    await waitFor(() => dev.received().length > sent, { describe: 'the writable frame' });
    expect(dev.received().slice(sent)).toEqual(['from the board']);
  });

  it('answers 404 for a doc that is not an app, and for a board that does not hold it', async () => {
    const doc = await post(`/workspaces/${ws}/docs`, { docId: 'riverbend-notes', type: 'mockup' });
    const { docId } = (await doc.clone().json()) as { docId?: string };
    const status = (path: string) =>
      handshakeStatus(handle.port, path, { 'Sec-WebSocket-Protocol': 'vite-hmr' });
    expect(await status(`/workspaces/${ws}/apps/${docId ?? 'riverbend-notes'}/`)).toBe(404);
    expect(await status(`/workspaces/${ws}/apps/nothing-here/`)).toBe(404);
    expect(await status(`/workspaces/w-nothing/apps/${app}/`)).toBe(404);
  });

  it("refuses a path that could leave the app's origin", async () => {
    const status = await handshakeStatus(handle.port, `${prefix}%2F%2Fevil.example/`, {
      'Sec-WebSocket-Protocol': 'vite-hmr',
    });
    expect(status).toBe(400);
  });

  it('leaves the same address, without an upgrade, to the page route', async () => {
    const page = await fetch(`${base}${prefix}`, { redirect: 'manual' });
    expect(page.status).not.toBe(426);
    expect(page.headers.get('upgrade')).toBeNull();
  });

  // Last: it takes the dev server down and brings it back.
  it('tells a reader of a restart, fails a ping while down, and reconnects after', async () => {
    const s = await open();
    await nextFrame(s);
    await dev.stop();
    await waitFor(() => s.closed(), { describe: 'the reader to be told' });

    // What Vite's client does next: ping until a socket opens, then reload. A
    // socket that opened now would reload a page that is not there.
    const ping = () =>
      handshakeStatus(handle.port, prefix, { 'Sec-WebSocket-Protocol': 'vite-ping' });
    expect(await ping()).toBe(503);

    dev.start();
    expect(await ping()).toBe(101);
    // The app's page, reloaded: a new socket, on the same address.
    const again = await open();
    expect(await nextFrame(again)).toBe('{"type":"connected"}');
    dev.broadcast('{"type":"full-reload"}');
    expect(await nextFrame(again, 1)).toBe('{"type":"full-reload"}');
  });
});
