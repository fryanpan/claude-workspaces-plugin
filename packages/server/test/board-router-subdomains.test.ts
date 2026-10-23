/**
 * The router's project subdomains (infra/board-router-worker): a request to
 * `<project>.<one address>` reaches that project's origin and no other, an
 * unknown subdomain is a 404 that calls no origin, a cookie not set by a
 * project server for its own host never leaves the Worker, and every board
 * path on the one address routes exactly as it did before subdomains. Each
 * refusal is paired with the request that passes once the one thing it
 * lacked is present.
 */
import { describe, expect, it } from 'bun:test';
import {
  handleBoardRequest,
  keptCookies,
  parseBoardOrigins,
  parseProjectOrigins,
  projectOfHost,
  routeBoardRequest,
  routeRequest,
  withoutDomainCookies,
} from '../../../infra/board-router-worker/worker.js';

const ONE_HOST = 'workspaces.harborlight.test';
const ONE = `https://${ONE_HOST}`;
const MAC = 'mac-origin.harborlight.test';
const RIVERBEND = 'riverbend-origin.harborlight.test';
const SALTMARSH = 'saltmarsh-origin.harborlight.test';
const BOARDS = JSON.stringify({ [MAC]: ['w-mac1'], [RIVERBEND]: ['w-river'] });
const PROJECTS = JSON.stringify({ harborlight: MAC, riverbend: RIVERBEND, saltmarsh: SALTMARSH });
const ENV = { ONE_ADDRESS: ONE_HOST, BOARD_ORIGINS: BOARDS, PROJECT_ORIGINS: PROJECTS };

type Call = { request: Request; origin: string };
const recorder = (response: () => Response = () => new Response('ok')) => {
  const calls: Call[] = [];
  const upstream = async (
    request: Request,
    init: { redirect: 'manual'; cf: { resolveOverride: string } },
  ) => {
    calls.push({ request, origin: init.cf.resolveOverride });
    return response();
  };
  return { calls, upstream };
};

const send = (url: string, init: RequestInit = {}, env = ENV) => {
  const rec = recorder();
  return handleBoardRequest(new Request(url, init), env, rec.upstream).then((res) => ({
    res,
    calls: rec.calls,
  }));
};

describe('projectOfHost', () => {
  it('reads the one label in front of the one address', () => {
    expect(projectOfHost(`riverbend.${ONE_HOST}`, ONE_HOST)).toBe('riverbend');
  });

  it('names no project for the one address, a deeper name, or another host', () => {
    expect(projectOfHost(ONE_HOST, ONE_HOST)).toBeNull();
    expect(projectOfHost(`a.riverbend.${ONE_HOST}`, ONE_HOST)).toBeNull();
    expect(projectOfHost(`riverbend${ONE_HOST}`, ONE_HOST)).toBeNull();
    expect(projectOfHost('riverbend.saltmarsh.test', ONE_HOST)).toBeNull();
    expect(projectOfHost(`riverbend.${ONE_HOST}`, '')).toBeNull();
  });
});

describe('parseProjectOrigins', () => {
  it('maps every listed project to its origin', () => {
    expect([...(parseProjectOrigins(PROJECTS) ?? new Map())]).toEqual([
      ['harborlight', MAC],
      ['riverbend', RIVERBEND],
      ['saltmarsh', SALTMARSH],
    ]);
  });

  it.each([
    ['missing', undefined],
    ['not JSON', '{'],
    ['an array', '[]'],
    ['a label with a dot', JSON.stringify({ 'a.b': MAC })],
    ['an upper-case label', JSON.stringify({ Riverbend: RIVERBEND })],
    ['an origin with a port', JSON.stringify({ riverbend: `${RIVERBEND}:443` })],
    ['an origin that is not a string', JSON.stringify({ riverbend: [RIVERBEND] })],
  ])('refuses a config that is %s', (_label, raw) => {
    expect(parseProjectOrigins(raw)).toBeNull();
  });
});

describe('a project subdomain reaches that project and no other', () => {
  it("sends every path on a project's subdomain to that project's origin", async () => {
    for (const path of ['/', '/workspaces/w-anything', '/app/board.js', '/api/auth/me']) {
      const { res, calls } = await send(`https://riverbend.${ONE_HOST}${path}`);
      expect(res.status).toBe(200);
      expect(calls.map((c) => c.origin)).toEqual([RIVERBEND]);
      expect(calls[0]?.request.url).toBe(`https://riverbend.${ONE_HOST}${path}`);
    }
  });

  it('CONTROL: another subdomain reaches its own origin', async () => {
    // So the origin above came from the subdomain, not from a fixed choice.
    const { calls } = await send(`https://saltmarsh.${ONE_HOST}/`);
    expect(calls.map((c) => c.origin)).toEqual([SALTMARSH]);
  });

  it('lets the subdomain win over a board path the one address would send elsewhere', async () => {
    const { calls } = await send(`https://riverbend.${ONE_HOST}/workspaces/w-mac1`);
    expect(calls.map((c) => c.origin)).toEqual([RIVERBEND]);
    // The same path on the one address goes to the Mac.
    const control = await send(`${ONE}/workspaces/w-mac1`);
    expect(control.calls.map((c) => c.origin)).toEqual([MAC]);
  });

  it('answers 404 itself for an unknown subdomain and calls no origin', async () => {
    const { res, calls } = await send(`https://unlisted.${ONE_HOST}/`);
    expect(res.status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it('CONTROL: the same subdomain is routed once the table lists it', async () => {
    const env = { ...ENV, PROJECT_ORIGINS: JSON.stringify({ unlisted: SALTMARSH }) };
    const { res, calls } = await send(`https://unlisted.${ONE_HOST}/`, {}, env);
    expect(res.status).toBe(200);
    expect(calls.map((c) => c.origin)).toEqual([SALTMARSH]);
  });

  it('answers 404 for a deeper name, another host, or a broken project table', async () => {
    for (const url of [`https://a.riverbend.${ONE_HOST}/`, 'https://riverbend.saltmarsh.test/']) {
      const { res, calls } = await send(url);
      expect(res.status).toBe(404);
      expect(calls).toHaveLength(0);
    }
    const broken = await send(
      `https://riverbend.${ONE_HOST}/`,
      {},
      {
        ...ENV,
        PROJECT_ORIGINS: '{',
      },
    );
    expect(broken.res.status).toBe(404);
    expect(broken.calls).toHaveLength(0);
  });

  it('routes no subdomain at all when the one address is not configured', async () => {
    const { res, calls } = await send(`https://riverbend.${ONE_HOST}/`, {}, {
      BOARD_ORIGINS: BOARDS,
      PROJECT_ORIGINS: PROJECTS,
    } as typeof ENV);
    expect(res.status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it('carries the method, body and stamp through unchanged', async () => {
    const { calls } = await send(`https://riverbend.${ONE_HOST}/workspaces/w-river/tasks`, {
      method: 'POST',
      headers: { 'cf-access-jwt-assertion': 'stamp-value', 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Harborlight task' }),
    });
    expect(calls[0]?.request.method).toBe('POST');
    expect(calls[0]?.request.headers.get('cf-access-jwt-assertion')).toBe('stamp-value');
    expect(await calls[0]?.request.text()).toBe(JSON.stringify({ title: 'Harborlight task' }));
  });
});

describe('a cookie not set by a project server for its own host is stripped', () => {
  const PROJECT_COOKIES = '__Host-cw_session=s1; lf_share=l1; cw_geo=g1; cw_touch=5';

  it('keeps the host-only cookies a server and its pages set', () => {
    expect(keptCookies(PROJECT_COOKIES)).toBe(PROJECT_COOKIES);
    expect(keptCookies('cw_session=s0')).toBe('cw_session=s0');
    expect(keptCookies('__Host-anything=v')).toBe('__Host-anything=v');
  });

  it('drops every other name, the Access cookie included', () => {
    expect(keptCookies(`parent_pref=dark; ${PROJECT_COOKIES}; CF_Authorization=c; Host-cw=x`)).toBe(
      PROJECT_COOKIES,
    );
    expect(keptCookies('parent_pref=dark; CF_Authorization=c')).toBeNull();
    expect(keptCookies(null)).toBeNull();
  });

  it('a parent-domain cookie never reaches the project server', async () => {
    const { calls } = await send(`https://riverbend.${ONE_HOST}/`, {
      headers: { cookie: `parent_pref=dark; ${PROJECT_COOKIES}` },
    });
    expect(calls[0]?.request.headers.get('cookie')).toBe(PROJECT_COOKIES);
  });

  it('CONTROL: a request carrying only kept cookies arrives with them all', async () => {
    const { calls } = await send(`https://riverbend.${ONE_HOST}/`, {
      headers: { cookie: PROJECT_COOKIES },
    });
    expect(calls[0]?.request.headers.get('cookie')).toBe(PROJECT_COOKIES);
  });

  it('sends no Cookie header when every cookie was dropped', async () => {
    const { calls } = await send(`https://riverbend.${ONE_HOST}/`, {
      headers: { cookie: 'parent_pref=dark' },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.request.headers.has('cookie')).toBe(false);
  });

  it('strips cookies on the one address too', async () => {
    const { calls } = await send(`${ONE}/workspaces/w-river`, {
      headers: { cookie: `parent_pref=dark; ${PROJECT_COOKIES}` },
    });
    expect(calls[0]?.request.headers.get('cookie')).toBe(PROJECT_COOKIES);
  });

  it("drops a server's Set-Cookie that names a Domain, and keeps a host-only one", async () => {
    const rec = recorder(() => {
      const headers = new Headers();
      headers.append('set-cookie', 'lf_share=x; Path=/; Domain=workspaces.harborlight.test');
      headers.append('set-cookie', '__Host-cw_session=s; Path=/; Secure; HttpOnly');
      headers.append('set-cookie', 'cw_geo=g; path=/; domain=.harborlight.test');
      return new Response('body', { status: 201, headers });
    });
    const res = await handleBoardRequest(
      new Request(`https://riverbend.${ONE_HOST}/`),
      ENV,
      rec.upstream,
    );
    expect(res.status).toBe(201);
    expect(await res.text()).toBe('body');
    expect(res.headers.getSetCookie()).toEqual(['__Host-cw_session=s; Path=/; Secure; HttpOnly']);
  });

  it('CONTROL: a response with only host-only cookies is passed back untouched', () => {
    const response = new Response('body', {
      headers: { 'set-cookie': '__Host-cw_session=s; Path=/; Secure; HttpOnly' },
    });
    expect(withoutDomainCookies(response)).toBe(response);
  });
});

describe('every current board path on the one address routes as before', () => {
  // The board families the app and the Mac's Home ask the one address for.
  const PATHS: Array<[string, string | null]> = [
    ['/workspaces/w-river', null],
    ['/workspaces/w-river?format=json', null],
    ['/workspaces/w-river/tasks', null],
    ['/workspaces/w-river/tasks/t-1/transition', null],
    ['/workspaces/w-river/docs/d-1', null],
    ['/workspaces/w-river/docs/d-1/content', null],
    ['/workspaces/w-river/docs/d-1/threads', null],
    ['/workspaces/w-river/y', null],
    ['/workspaces/w-river/mockups/m-1', null],
    ['/workspaces/w-river/attachments/s-1', null],
    ['/workspaces/w-river/agents', null],
    ['/workspaces/w-river/voice', null],
    ['/workspaces/w-river/home-feed', null],
    ['/workspaces/w-river/home-feed/events:stream', null],
    ['/workspaces/w-mac1/activity', null],
    ['/app/board.js', `${ONE}/workspaces/w-river`],
    ['/workspaces/w-unknown', null],
  ];

  it.each(PATHS)('%s routes the same with subdomains configured', (path, referer) => {
    const url = new URL(path, ONE);
    const before = routeBoardRequest(url, referer, parseBoardOrigins(BOARDS));
    expect(routeRequest(url, referer, ENV)).toEqual(before);
    expect(routeRequest(url, referer, { BOARD_ORIGINS: BOARDS })).toEqual(before);
  });

  it('CONTROL: the table above is not all one answer', () => {
    const origins = PATHS.map(([path, referer]) => {
      const r = routeRequest(new URL(path, ONE), referer, ENV);
      return r.kind === 'forward' ? r.origin : r.kind;
    });
    expect(new Set(origins)).toEqual(new Set([RIVERBEND, MAC, 'not_found']));
  });
});
