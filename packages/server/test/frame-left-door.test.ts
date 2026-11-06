/**
 * A frame that left its app door (`frame-host.ts`): a framed navigation to an
 * address outside every door gets a fixed page that reports its address to the
 * page holding the frame. Nothing else changes: not a top-level visit, not a
 * fetch, not the board's own frames, and no answer is ever a redirect.
 *
 * Fixtures are fictional. The walk in a browser is
 * `packages/widget/test/app-frame-path.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  frameGate,
  frameLeftResponse,
  leftBoardDoor,
  repeatedDoorRedirect,
} from '../src/frame-host.ts';
import { type ServerHandle, createServer } from '../src/server.ts';

const iframe = (site: string) => ({ 'sec-fetch-dest': 'iframe', 'sec-fetch-site': site });
const on = (path: string, headers: Record<string, string>, method = 'GET') =>
  new Request(`http://board.test${path}`, { method, headers });

describe('which requests left the door', () => {
  it('on the frame hostname: a frame outside both families, same-origin or not', () => {
    for (const path of ['/insights', '/', '/api/threads?x=1']) {
      for (const site of ['same-origin', 'cross-site']) {
        const u = new URL(`http://frames.test${path}`);
        const v = frameGate(on(path, iframe(site)), u.pathname, u.searchParams);
        expect(v).toEqual({ ok: false, status: 404, left: true });
      }
    }
  });

  it('on the frame hostname: anything else keeps its plain refusal', () => {
    const none = new URLSearchParams();
    const dests: (string | null)[] = ['document', 'empty', 'script', null];
    for (const dest of dests) {
      const headers: Record<string, string> = dest ? { 'sec-fetch-dest': dest } : {};
      expect(frameGate(on('/insights', headers), '/insights', none)).toEqual({
        ok: false,
        status: 404,
      });
    }
    expect(frameGate(on('/insights', iframe('cross-site'), 'POST'), '/insights', none)).toEqual({
      ok: false,
      status: 405,
    });
  });

  it('on the frame hostname: a frame at a door that lost its frame flag', () => {
    const door = '/workspaces/w-1/apps/d-1/insights';
    const none = new URLSearchParams();
    expect(frameGate(on(door, iframe('same-origin')), door, none)).toEqual({
      ok: false,
      status: 404,
      left: true,
    });
    const flagged = new URLSearchParams('cw-frame=1');
    expect(frameGate(on(door, iframe('same-origin')), door, flagged)).toEqual({ ok: true });
    // A mock's address is one page, and its refusal stays plain.
    const mock = '/workspaces/w-1/mockups/d-1';
    expect(frameGate(on(mock, iframe('same-origin')), mock, none)).toEqual({
      ok: false,
      status: 404,
    });
  });

  it("on the board's hostname: a frame some other origin navigated, outside /workspaces/", () => {
    expect(leftBoardDoor(on('/insights', iframe('cross-site')), '/insights')).toBe(true);
    expect(leftBoardDoor(on('/', iframe('none')), '/')).toBe(true);
    expect(leftBoardDoor(on('/insights', { 'sec-fetch-dest': 'iframe' }), '/insights')).toBe(true);
    const door = '/workspaces/w-1/apps/d-1/x';
    expect(leftBoardDoor(on(door, iframe('cross-site')), door)).toBe(true);
  });

  it("on the board's hostname: nothing else, the board's own frames included", () => {
    const refused: [Request, string][] = [
      [on('/insights', iframe('same-origin')), '/insights'],
      [
        on('/workspaces/w-1/apps/d-1/x?cw-frame=1', iframe('cross-site')),
        '/workspaces/w-1/apps/d-1/x',
      ],
      [on('/workspaces/w-1/mockups/d-1', iframe('cross-site')), '/workspaces/w-1/mockups/d-1'],
      [on('/s/link-1', iframe('cross-site')), '/s/link-1'],
      [on('/insights', { 'sec-fetch-dest': 'document' }), '/insights'],
      [on('/insights', { 'sec-fetch-dest': 'empty' }), '/insights'],
      [on('/insights', {}), '/insights'],
      [on('/insights', iframe('cross-site'), 'POST'), '/insights'],
    ];
    for (const [r, path] of refused) expect(leftBoardDoor(r, path)).toBe(false);
  });
});

describe('the page such a frame gets', () => {
  it('is fixed bytes, a 404 and no redirect, in a sandbox with its own script alone', async () => {
    const r = frameLeftResponse("'self'");
    expect(r.status).toBe(404);
    expect(r.headers.get('location')).toBeNull();
    expect(r.headers.get('set-cookie')).toBeNull();
    const csp = r.headers.get('content-security-policy') ?? '';
    expect(csp).toStartWith("sandbox allow-scripts; default-src 'none'; script-src 'sha256-");
    expect(csp).not.toContain('allow-same-origin');
    expect(csp).toEndWith("frame-ancestors 'self'");
    // The hash is the page's own script, as a browser would compute it.
    const body = await r.text();
    const script = /<script>(.*)<\/script>/.exec(body)?.[1] ?? '';
    const hash = new Bun.CryptoHasher('sha256').update(script).digest('base64');
    expect(csp).toContain(`'sha256-${hash}'`);
  });
});

describe('a door repeated in its own path', () => {
  const PREFIX = '/workspaces/w-1/apps/d-1/';
  const to = (method: string, tail: string, search = '') =>
    repeatedDoorRedirect(method, tail, PREFIX, search)?.headers.get('location') ?? null;

  it('goes to the path after the repeat, query unchanged, under the same door', () => {
    expect(to('GET', 'workspaces/w-1/apps/d-1/insights', '?tab=a&cw-frame=1')).toBe(
      `${PREFIX}insights?tab=a&cw-frame=1`,
    );
    expect(to('HEAD', 'workspaces/w-1/apps/d-1//insights')).toBe(`${PREFIX}insights`);
    expect(to('GET', 'workspaces/w-1/apps/d-1///evil.test/')).toBe(`${PREFIX}evil.test/`);
  });

  it('leaves everything else: a real path, another door, a write', () => {
    expect(to('GET', 'insights')).toBeNull();
    expect(to('GET', '/insights')).toBeNull();
    expect(to('GET', 'workspaces/w-1/apps/d-2/insights')).toBeNull();
    expect(to('POST', 'workspaces/w-1/apps/d-1/insights')).toBeNull();
  });
});

describe('through a real server', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let frameHost = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'frame-left-'));
    const probe = createServer({ port: 0, dataDir });
    const port = probe.port;
    await probe.stop();
    frameHost = `frames.localhost:${port}`;
    handle = createServer({
      port,
      dataDir,
      frameOrigin: `http://${frameHost}`,
      frameBoardHosts: ['harborlight.board.test'],
    });
    base = `http://127.0.0.1:${port}`;
  });
  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const get = (path: string, headers: Record<string, string>) =>
    fetch(`${base}${path}`, { headers, redirect: 'manual' });

  it("answers a frame on the board's hostname with the page, framed by itself alone", async () => {
    for (const path of ['/insights?cw-frame=1', '/insights', '/?cw-frame=1']) {
      const r = await get(path, iframe('cross-site'));
      expect(r.status).toBe(404);
      expect(await r.text()).toContain("cw:'frame-left'");
      expect(r.headers.get('content-security-policy')).toEndWith("frame-ancestors 'self'");
    }
  });

  it('answers a frame on the frame hostname, framed by the board alone', async () => {
    const r = await get('/insights?cw-frame=1', { ...iframe('same-origin'), host: frameHost });
    expect(r.status).toBe(404);
    expect(await r.text()).toContain("cw:'frame-left'");
    const csp = r.headers.get('content-security-policy') ?? '';
    expect(csp).toContain('frame-ancestors https://harborlight.board.test');
    expect(csp).not.toContain("'self'");
  });

  it('leaves a top-level visit and a script on the same addresses as they were', async () => {
    const top = await get('/insights?cw-frame=1', { 'sec-fetch-dest': 'document' });
    expect([top.status, await top.text()]).toEqual([404, 'not found']);
    const script = await get('/insights', { 'sec-fetch-dest': 'empty' });
    expect([script.status, await script.text()]).toEqual([404, 'not found']);
    const curl = await get('/insights', { host: frameHost });
    expect([curl.status, await curl.text()]).toEqual([404, 'Not found\n']);
  });

  it("still refuses a host it does not know, before the frame's page", async () => {
    const r = await get('/insights', { ...iframe('cross-site'), host: 'nobody.harborlight.test' });
    expect(r.status).toBe(403);
    expect(((await r.json()) as { error: string }).error).toBe('unknown_host');
  });
});
