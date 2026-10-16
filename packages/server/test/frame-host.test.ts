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
import { createFrameHost, frameGate, parseFrameOrigin } from '../src/frame-host.ts';
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
      origin: 'https://frames.harborlight.test',
      boardHosts: ['board.harborlight.test', 'frames.harborlight.test'],
    });
    const on = (host: string) => new Request('http://x/', { headers: { host } });
    expect(fh.frameOriginFor(on('board.harborlight.test'), false)).toBe(
      'https://frames.harborlight.test',
    );
    expect(fh.frameOriginFor(on('board.harborlight.test:443'), false)).toBe(
      'https://frames.harborlight.test',
    );
    expect(fh.frameOriginFor(on('board.harborlight.test'), true)).toBeNull();
    expect(fh.frameOriginFor(on('share.harborlight.test'), false)).toBeNull();
    expect(fh.frameOriginFor(on('frames.harborlight.test'), false)).toBeNull();
    expect(fh.isFrameHost(on('Frames.Harborlight.test:8443'))).toBe(true);
    // Framed by the board alone: the frame hostname itself is not an
    // ancestor, so one attachment cannot frame another and read it.
    expect(fh.frameCsp).toBe(
      `sandbox ${FRAME_HOST_SANDBOX}; frame-ancestors https://board.harborlight.test http://board.harborlight.test:*`,
    );
  });

  it('is framed by nobody when no board hostname is named', () => {
    const fh = createFrameHost({ origin: 'https://frames.harborlight.test', boardHosts: [] });
    expect(fh.frameCsp.endsWith("frame-ancestors 'none'")).toBe(true);
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
    fetch(`${base}${path}`, { method, headers: { ...FRAMES(), ...headers } });

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

  it("points the board's frame at the frame hostname, with that hostname's origin", async () => {
    const host = await fetch(`${base}/workspaces/${ws}/mockups/${mock}?v=1`, { headers: BOARD() });
    const html = await host.text();
    expect(host.status).toBe(200);
    expect(html).toContain(
      `data-src="${frameOrigin}/workspaces/${ws}/mockups/${mock}?v=1&amp;cw-frame=1"`,
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

  it('serves the frame there with an origin of its own, framed only by the board', async () => {
    const frame = await onFrames(`/workspaces/${ws}/mockups/${mock}?cw-frame=1`, {
      'sec-fetch-dest': 'iframe',
    });
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

  it('refuses a request through the tunnel when no Access verifier is configured', async () => {
    const res = await onFrames(`/workspaces/${ws}/mockups/${mock}?cw-frame=1`, {
      'sec-fetch-dest': 'iframe',
      'cf-ray': '8f0000000000-SJC',
    });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe('access_not_configured');
  });
});
