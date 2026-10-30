/**
 * The frame-only hostname: what it answers, for whom, and what the board's
 * host page does with it.
 *
 * Two halves. The gate and the origin parsing are pure and driven directly.
 * Then a real server with the frame hostname configured: the board's host
 * page points its frame there, the frame comes back with a real origin and
 * is framed only by the board, and every other request on that hostname is
 * refused before a route runs. The browser half — that a page in that frame
 * cannot read the board's cookies or storage — is
 * `packages/widget/test/frame-host.test.ts`.
 *
 * Fixtures are fictional — a harbour's tide table.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFrameHost, frameGate, parseFrameOrigin, sameSiteHosts } from '../src/frame-host.ts';
import { FRAME_COOKIE, checkFrameTicket } from '../src/frame-ticket.ts';
import { FRAME_HOST_SANDBOX, MOCK_FRAME_CSP } from '../src/mockup-frame.ts';
import { type ServerHandle, createServer } from '../src/server.ts';

const req = (path: string, init: { method?: string; headers?: Record<string, string> } = {}) =>
  new Request(`http://frames.harborlight.test${path}`, init);
const verdict = (path: string, dest: string | null, method = 'GET') => {
  const url = new URL(`http://frames.harborlight.test${path}`);
  const headers: Record<string, string> = dest === null ? {} : { 'sec-fetch-dest': dest };
  return frameGate(req(path, { method, headers }), url.pathname, url.searchParams);
};

describe('the frame hostname setting', () => {
  it('takes a bare http(s) origin and nothing else', () => {
    expect(parseFrameOrigin('https://frames.harborlight.test')).toBe(
      'https://frames.harborlight.test',
    );
    expect(parseFrameOrigin(' https://frames.harborlight.test/ ')).toBe(
      'https://frames.harborlight.test',
    );
    for (const bad of [
      undefined,
      '',
      'frames.harborlight.test',
      'https://frames.harborlight.test/f',
      'https://frames.harborlight.test?x=1',
      'https://who@frames.harborlight.test',
      'javascript:alert(1)',
      'file:///tmp',
    ]) {
      expect(parseFrameOrigin(bad)).toBeNull();
    }
  });

  it('frames on it only for a board hostname, never for a visitor or on itself', () => {
    const fh = createFrameHost({
      origin: 'https://harborlight.frames.test',
      boardHosts: ['harborlight.board.test', 'harborlight.frames.test'],
      keys: () => ({ ticket: 'k', cookie: 'c' }),
    });
    const on = (host: string) => new Request('http://x/', { headers: { host } });
    const target = fh.frameFor(on('harborlight.board.test'), false, 'w-harbor');
    expect(target?.origin).toBe('https://harborlight.frames.test');
    // The ticket opens this board on this frame hostname, and nothing else.
    expect(checkFrameTicket('k', target?.ticket, 'harborlight.frames.test', 'w-harbor').ok).toBe(
      true,
    );
    expect(checkFrameTicket('k', target?.ticket, 'riverbend.frames.test', 'w-harbor')).toEqual({
      ok: false,
      reason: 'other_frame_host',
    });
    // The host page's app voice verdict rides in the ticket, off by default.
    expect(
      checkFrameTicket('k', target?.ticket, 'harborlight.frames.test', 'w-harbor'),
    ).toMatchObject({ ok: true, appVoice: false });
    const voiced = fh.frameFor(on('harborlight.board.test'), false, 'w-harbor', true);
    expect(
      checkFrameTicket('k', voiced?.ticket, 'harborlight.frames.test', 'w-harbor'),
    ).toMatchObject({ ok: true, appVoice: true });
    expect(fh.frameFor(on('harborlight.board.test'), true, 'w-harbor', true)).toBeNull();
    expect(fh.frameFor(on('harborlight.board.test:443'), false, 'w-harbor')?.origin).toBe(
      'https://harborlight.frames.test',
    );
    expect(fh.frameFor(on('harborlight.board.test'), true, 'w-harbor')).toBeNull();
    expect(fh.frameFor(on('share.board.test'), false, 'w-harbor')).toBeNull();
    expect(fh.frameFor(on('harborlight.frames.test'), false, 'w-harbor')).toBeNull();
    expect(fh.isFrameHost(on('Harborlight.Frames.test:8443'))).toBe(true);
    // Framed by the board alone: the frame hostname itself is not an
    // ancestor, so one attachment cannot frame another and read it.
    expect(fh.frameCsp).toBe(
      `sandbox ${FRAME_HOST_SANDBOX}; frame-ancestors https://harborlight.board.test http://harborlight.board.test:*`,
    );
    expect(fh.sameSiteBoardHosts).toEqual([]);
  });

  it('is framed by nobody when no board hostname is named', () => {
    const fh = createFrameHost({
      origin: 'https://harborlight.frames.test',
      boardHosts: [],
      keys: () => ({ ticket: 'k', cookie: 'c' }),
    });
    expect(fh.frameCsp.endsWith("frame-ancestors 'none'")).toBe(true);
  });

  it('names a board hostname the frame hostname shares a domain with', () => {
    expect(sameSiteHosts('frames.board.test', ['harborlight.board.test', '127.0.0.1'])).toEqual([
      'harborlight.board.test',
    ]);
    expect(sameSiteHosts('harborlight.frames.test:8443', ['harborlight.board.test'])).toEqual([]);
    expect(sameSiteHosts('frames.localhost', ['127.0.0.1', 'localhost'])).toEqual([]);
  });
});

describe('what the frame hostname answers', () => {
  const MOCK = '/workspaces/w-harbor/mockups/d-tides';
  const APP = '/workspaces/w-harbor/apps/d-door';

  it("answers a mock's frame only as a frame", () => {
    expect(verdict(`${MOCK}?cw-frame=1`, 'iframe')).toEqual({ ok: true });
    expect(verdict(`${MOCK}?cw-frame=1`, null)).toEqual({ ok: true });
    for (const dest of ['document', 'empty', 'script', 'serviceworker']) {
      expect(verdict(`${MOCK}?cw-frame=1`, dest)).toEqual({ ok: false, status: 404 });
    }
    // The host page is the board's; it is never served here.
    expect(verdict(MOCK, 'iframe')).toEqual({ ok: false, status: 404 });
    expect(verdict(MOCK, null)).toEqual({ ok: false, status: 404 });
  });

  it("answers an app door's page as a frame and its files as subresources", () => {
    expect(verdict(`${APP}/?cw-frame=1`, 'iframe')).toEqual({ ok: true });
    for (const dest of ['script', 'style', 'image', 'font', 'worker']) {
      expect(verdict(`${APP}/assets/tides.js`, dest)).toEqual({ ok: true });
    }
    // A script's own fetch, a top-level visit, a frame without the flag, and
    // a service worker that would sit under every attachment on the origin.
    for (const dest of ['empty', 'document', 'iframe', 'serviceworker', 'object', 'embed']) {
      expect(verdict(`${APP}/assets/tides.js`, dest)).toEqual({ ok: false, status: 404 });
    }
    expect(verdict(`${APP}/?cw-frame=1`, 'document')).toEqual({ ok: false, status: 404 });
  });

  it("answers an app's files only to a page on this same frame hostname", () => {
    const asked = (site: string) => {
      const path = `${APP}/assets/tides.js`;
      const r = req(path, { headers: { 'sec-fetch-dest': 'script', 'sec-fetch-site': site } });
      return frameGate(r, path, new URLSearchParams());
    };
    expect(asked('same-origin')).toEqual({ ok: true });
    // Another project's frame hostname is the same site under the frame domain.
    for (const site of ['same-site', 'cross-site', 'none']) {
      expect(asked(site)).toEqual({ ok: false, status: 404 });
    }
  });

  it("answers the widget's own scripts as scripts only", () => {
    expect(verdict('/widget/mic.js', 'script')).toEqual({ ok: true });
    expect(verdict('/widget/mic.js', null)).toEqual({ ok: true });
    for (const dest of ['empty', 'document', 'iframe', 'serviceworker', 'worker']) {
      expect(verdict('/widget/mic.js', dest)).toEqual({ ok: false, status: 404 });
    }
    expect(verdict('/widget/sub/mic.js', 'script')).toEqual({ ok: false, status: 404 });
    expect(verdict('/widget/mic.css', 'style')).toEqual({ ok: false, status: 404 });
  });

  it('answers nothing else, writes nothing, and opens no socket', () => {
    for (const path of [
      '/',
      '/api/docs',
      '/workspaces/w-harbor',
      '/workspaces/w-harbor/docs/d-tides/threads',
      '/widget.iife.js',
      '/widget/../api/docs',
      '/app/index.html',
    ]) {
      expect(verdict(path, null)).toEqual({ ok: false, status: 404 });
    }
    expect(verdict(`${APP}/api/berths`, null, 'POST')).toEqual({ ok: false, status: 405 });
    const upgrade = req(`${APP}/`, { headers: { upgrade: 'websocket' } });
    expect(frameGate(upgrade, `${APP}/`, new URLSearchParams())).toEqual({
      ok: false,
      status: 404,
    });
  });
});

describe('a server with the frame hostname configured', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base = '';
  let frameOrigin = '';
  let ws = '';
  let mock = '';
  const AGENT = { id: 'agent-cartographer', name: 'Cartographer', kind: 'agent' };
  const BOARD = () => ({ host: `127.0.0.1:${handle.port}` });
  const FRAMES = () => ({ host: `frames.localhost:${handle.port}` });

  const post = async (path: string, body: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...BOARD() },
      body: JSON.stringify(body),
    });
    expect(res.ok, `${path} ${res.status}`).toBe(true);
    return res.json() as Promise<Record<string, unknown>>;
  };
  const onFrames = (path: string, headers: Record<string, string> = {}, method = 'GET') =>
    // `manual`: the ticket's redirect is the answer under test, as a frame sees it.
    fetch(`${base}${path}`, { method, headers: { ...FRAMES(), ...headers }, redirect: 'manual' });

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'frame-host-'));
    // Port 0 picks one, and the frame origin names the port, so the server
    // is made once to learn a free port and then again on it.
    const probe = createServer({ port: 0, dataDir });
    const port = probe.port;
    await probe.stop();
    frameOrigin = `http://frames.localhost:${port}`;
    handle = createServer({ port, dataDir, frameOrigin, frameBoardHosts: ['127.0.0.1'] });
    base = `http://127.0.0.1:${handle.port}`;
    ws = (
      (await post('/workspaces', { name: 'Tide table', author: AGENT })) as {
        workspace: { id: string };
      }
    ).workspace.id;
    const file = join(dataDir, 'tides.html');
    writeFileSync(
      file,
      '<!doctype html><html><head><title>Tides</title></head><body><h1>Saltmarsh tides</h1></body></html>',
    );
    mock = (
      (await post(`/workspaces/${ws}/docs`, {
        docId: 'tides',
        type: 'mockup',
        sourceUrl: file,
      })) as {
        docId: string;
      }
    ).docId;
    await post(`/workspaces/${ws}/docs:attach`, { docId: mock });
  });
  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  /** A host page's frame address, as the board hands it to the reader. */
  const frameSrc = async (): Promise<URL> => {
    const html = await (
      await fetch(`${base}/workspaces/${ws}/mockups/${mock}?v=1`, { headers: BOARD() })
    ).text();
    const src = /data-src="([^"]+)"/.exec(html)?.[1]?.replace(/&amp;/g, '&') ?? '';
    return new URL(src);
  };
  /** The frame's address traded for the cookie, as a browser's frame does. */
  const redeem = async () => {
    const src = await frameSrc();
    const res = await onFrames(`${src.pathname}${src.search}`, { 'sec-fetch-dest': 'iframe' });
    return { res, cookie: (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '' };
  };
  const FRAME = () => `/workspaces/${ws}/mockups/${mock}?cw-frame=1`;

  it("points the board's frame at the frame hostname, with a ticket for this board", async () => {
    const host = await fetch(`${base}/workspaces/${ws}/mockups/${mock}?v=1`, { headers: BOARD() });
    const html = await host.text();
    expect(host.status).toBe(200);
    expect(html).toContain(
      `data-src="${frameOrigin}/workspaces/${ws}/mockups/${mock}?v=1&amp;cw-frame=1&amp;cw-ft=`,
    );
    expect(html).toContain(`sandbox="${FRAME_HOST_SANDBOX}"`);
  });

  it('keeps the opaque same-host frame on a hostname that is not a board hostname', async () => {
    const host = await fetch(`${base}/workspaces/${ws}/mockups/${mock}`, {
      headers: { host: `localhost:${handle.port}` },
    });
    const html = await host.text();
    expect(html).toContain('data-src="?cw-frame=1"');
    expect(html).not.toContain('allow-same-origin');
  });

  it('trades the ticket for a partitioned cookie and drops it from the address', async () => {
    const { res } = await redeem();
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`/workspaces/${ws}/mockups/${mock}?v=1&cw-frame=1`);
    const set = res.headers.get('set-cookie') ?? '';
    expect(set.startsWith(`${FRAME_COOKIE}=`)).toBe(true);
    for (const attr of [
      `Path=/workspaces/${ws}/`,
      'HttpOnly',
      'Secure',
      'SameSite=None',
      'Partitioned',
    ]) {
      expect(set).toContain(attr);
    }
    expect(set.toLowerCase()).not.toContain('domain=');
  });

  it('serves the frame there with an origin of its own, framed only by the board', async () => {
    const { cookie } = await redeem();
    const frame = await onFrames(FRAME(), { 'sec-fetch-dest': 'iframe', cookie });
    expect(frame.status).toBe(200);
    const csp = frame.headers.get('content-security-policy') ?? '';
    expect(csp).toContain('allow-same-origin');
    expect(csp).toContain('frame-ancestors https://127.0.0.1 http://127.0.0.1:*');
    expect(csp).not.toContain('frames.localhost');
    expect(await frame.text()).toContain('Saltmarsh tides');
    // The same frame on the board's hostname is the opaque one, unchanged.
    const opaque = await fetch(`${base}/workspaces/${ws}/mockups/${mock}?cw-frame=1`, {
      headers: BOARD(),
    });
    expect(opaque.headers.get('content-security-policy')).toBe(MOCK_FRAME_CSP);
  });

  it('refuses a browser with no ticket, a forged one, and a cookie for another board', async () => {
    const bare = await onFrames(FRAME(), { 'sec-fetch-dest': 'iframe' });
    expect(bare.status).toBe(403);
    expect(((await bare.json()) as { error: string }).error).toBe('frame_ticket_required');
    const src = await frameSrc();
    const forged = new URLSearchParams(src.search);
    forged.set('cw-ft', `${forged.get('cw-ft')?.slice(0, -2)}xx`);
    const bad = await onFrames(`${src.pathname}?${forged}`, { 'sec-fetch-dest': 'iframe' });
    expect(bad.status).toBe(404);
    const { cookie } = await redeem();
    const other = await onFrames('/workspaces/w-riverbend/mockups/d-berths?cw-frame=1', {
      'sec-fetch-dest': 'iframe',
      cookie,
    });
    expect(other.status).toBe(403);
  });

  it('refuses a cookie value sent back as a ticket, so a cookie cannot renew itself', async () => {
    const { cookie } = await redeem();
    const value = cookie.slice(`${FRAME_COOKIE}=`.length);
    // CONTROL: the same value, sent as the cookie, holds the frame.
    expect((await onFrames(FRAME(), { 'sec-fetch-dest': 'iframe', cookie })).status).toBe(200);
    const res = await onFrames(`${FRAME()}&cw-ft=${encodeURIComponent(value)}`, {
      'sec-fetch-dest': 'iframe',
    });
    expect(res.status).toBe(404);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('drops a ticket from the redirect when its name is percent-encoded', async () => {
    const src = await frameSrc();
    const encoded = src.search.replace('cw-ft=', 'cw%2Dft=');
    expect(encoded).toContain('cw%2Dft=');
    const res = await onFrames(`${src.pathname}${encoded}`, { 'sec-fetch-dest': 'iframe' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`/workspaces/${ws}/mockups/${mock}?v=1&cw-frame=1`);
  });

  it('refuses the host page, the API, the board and a write on the frame hostname', async () => {
    const refusals = await Promise.all([
      onFrames(`/workspaces/${ws}/mockups/${mock}`),
      onFrames(`/workspaces/${ws}/mockups/${mock}?cw-frame=1`, { 'sec-fetch-dest': 'document' }),
      onFrames(`/workspaces/${ws}/mockups/${mock}?cw-frame=1`, { 'sec-fetch-dest': 'empty' }),
      onFrames('/api/docs'),
      onFrames(`/workspaces/${ws}`),
      onFrames(`/workspaces/${ws}/docs/${mock}/threads`),
      onFrames('/widget/mock-host.js', { 'sec-fetch-dest': 'empty' }),
    ]);
    expect(refusals.map((r) => r.status)).toEqual([404, 404, 404, 404, 404, 404, 404]);
    const write = await onFrames(
      `/workspaces/${ws}/docs/${mock}/threads`,
      { 'content-type': 'application/json' },
      'POST',
    );
    expect(write.status).toBe(405);
  });

  it('admits a ticket through the tunnel with no Access cookie, and nothing else', async () => {
    const tunnel = { 'sec-fetch-dest': 'iframe', 'cf-ray': '8f0000000000-SJC' };
    const { cookie } = await redeem();
    const held = await onFrames(FRAME(), { ...tunnel, cookie });
    expect(held.status).toBe(200);
    const res = await onFrames(FRAME(), tunnel);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe('access_not_configured');
  });

  it('refuses a held ticket through the tunnel while external access is off', async () => {
    const offDir = mkdtempSync(join(tmpdir(), 'frame-host-off-'));
    const off = createServer({
      port: 0,
      dataDir: offDir,
      frameOrigin,
      frameBoardHosts: ['127.0.0.1'],
      sharingEnvLocked: true,
    });
    try {
      const at = `http://127.0.0.1:${off.port}`;
      const make = async (path: string, body: unknown) =>
        (await (
          await fetch(`${at}${path}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          })
        ).json()) as Record<string, unknown>;
      const board = (
        (await make('/workspaces', { name: 'Tide table', author: AGENT })) as {
          workspace: { id: string };
        }
      ).workspace.id;
      const file = join(offDir, 'tides.html');
      writeFileSync(file, '<!doctype html><html><body><h1>Saltmarsh tides</h1></body></html>');
      const doc = String(
        (
          await make(`/workspaces/${board}/docs`, {
            docId: 'tides',
            type: 'mockup',
            sourceUrl: file,
          })
        ).docId,
      );
      await make(`/workspaces/${board}/docs:attach`, { docId: doc });
      const html = await (await fetch(`${at}/workspaces/${board}/mockups/${doc}`)).text();
      const src = new URL(/data-src="([^"]+)"/.exec(html)?.[1]?.replace(/&amp;/g, '&') ?? '');
      const framesOff = { host: `frames.localhost:${off.port}`, 'sec-fetch-dest': 'iframe' };
      const traded = await fetch(`${at}${src.pathname}${src.search}`, {
        headers: framesOff,
        redirect: 'manual',
      });
      expect(traded.status).toBe(303);
      const cookie = (traded.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
      const frame = `${at}/workspaces/${board}/mockups/${doc}?cw-frame=1`;
      // CONTROL: the box's own browser holds its frame with the cookie.
      expect((await fetch(frame, { headers: { ...framesOff, cookie } })).status).toBe(200);
      const tunnelled = await fetch(frame, {
        headers: { ...framesOff, cookie, 'cf-ray': '8f0000000000-SJC' },
      });
      expect(tunnelled.status).toBe(403);
      expect(((await tunnelled.json()) as { error: string }).error).toBe('sharing_disabled');
    } finally {
      await off.stop();
      rmSync(offDir, { recursive: true, force: true });
    }
  });
});
