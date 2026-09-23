/**
 * `resolveWorkspaceScope` driven directly, for the path shapes a route cannot
 * produce. The same middleware over the real routes, collection by
 * collection, is `workspace-scope.test.ts`; its header says why both exist.
 *
 * All fixtures are synthetic.
 */
import { describe, expect, it } from 'bun:test';
import { resolveWorkspaceScope } from '../src/middleware/workspace-scope.ts';

describe('resolveWorkspaceScope', () => {
  const j = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const deps = {
    workspaceRecord: (id: string) => (id === 'w-here' ? { id } : undefined),
    workspacesOfMember: (_collection: string, memberId: string) =>
      memberId === 'g-here' ? ['w-here'] : memberId === 'g-elsewhere' ? ['w-other'] : [],
    j,
  };
  const ask = (pathname: string, method = 'GET') =>
    resolveWorkspaceScope(deps, { pathname, method, url: new URL(`http://x${pathname}`) });

  it('passes a path that is not a board’s at all', () => {
    for (const p of ['/', '/signin', '/workspaces']) {
      expect(ask(p).kind, p).toBe('pass');
    }
  });

  it('passes the board’s own address, because that path fronts two stores', () => {
    // `/workspaces/<id>` is a board id OR an attachment set's, dispatched by
    // whichever store knows it. An existence check here would have to ask
    // both — and asking the doc store means scanning every doc per request.
    expect(ask('/workspaces/w-nope').kind).toBe('pass');
    expect(ask('/workspaces/w-nope', 'DELETE').kind).toBe('pass');
  });

  it('passes the board’s HTML pages once the board is real', () => {
    // The list is shared with the thing that serves them — see
    // workspace-path.ts. `/docs/d-1` is not here: a member address is checked
    // for a page too, and `d-1` is on no board (the case below).
    for (const p of ['', '/home', '/tasks', '/library', '/activity']) {
      expect(ask(`/workspaces/w-here${p}`).kind, p).toBe('pass');
    }
  });

  it('CHECKS an HTML page rather than passing it, and refuses it as a page', () => {
    // The page surface used to skip this resolver, so any board id in front
    // of anybody's doc id served the shell with a 200. It is checked now; what
    // stays page-shaped is the ANSWER — a browser gets HTML, not a JSON body.
    const pageDeps = { ...deps, notFoundPage: () => new Response('<!doctype html>not found') };
    const askPage = (pathname: string) =>
      resolveWorkspaceScope(pageDeps, {
        pathname,
        method: 'GET',
        url: new URL(`http://x${pathname}`),
      });
    for (const p of ['/home', '/tasks', '/docs/d-1', '/attachments/r-1']) {
      const r = askPage(`/workspaces/w-nope${p}`);
      expect(r.kind, p).toBe('refused');
      if (r.kind !== 'refused') throw new Error('unreachable');
      expect(r.response.headers.get('content-type') ?? '', p).not.toContain('application/json');
    }
    // A member of a board that DOES exist, filed somewhere else, is refused
    // the same way — the board being real is not the question.
    const foreign = askPage('/workspaces/w-here/docs/d-1');
    expect(foreign.kind).toBe('refused');
  });

  it('claims the same addresses once ?format=json asks for data', async () => {
    const asked = resolveWorkspaceScope(deps, {
      pathname: '/workspaces/w-nope/home',
      method: 'GET',
      url: new URL('http://x/workspaces/w-nope/home?format=json'),
    });
    expect(asked.kind).toBe('refused');
    if (asked.kind !== 'refused') throw new Error('unreachable');
    expect(asked.response.status).toBe(404);
  });

  it('refuses a board nothing knows, and hands the scope back for one it does', () => {
    expect(ask('/workspaces/w-nope/settings').kind).toBe('refused');
    const ok = ask('/workspaces/w-here/settings');
    expect(ok.kind).toBe('scope');
    if (ok.kind !== 'scope') throw new Error('unreachable');
    expect(ok.scope).toEqual({ workspaceId: 'w-here', rest: 'settings', board: { id: 'w-here' } });
  });

  it('refuses a goal band filed on ANOTHER board', () => {
    expect(ask('/workspaces/w-here/goals/g-here/archive', 'POST').kind).toBe('scope');
    expect(ask('/workspaces/w-here/goals/g-elsewhere/archive', 'POST').kind).toBe('refused');
    expect(ask('/workspaces/w-here/goals/g-unknown/archive', 'POST').kind).toBe('refused');
  });

  it('does not read a goal VERB as a row id', () => {
    // `goals/add`, `goals/rename` and `goals/reorder` put a custom verb
    // exactly where an id goes. A rule keyed on "the segment after the
    // collection" would look `rename` up as a band and refuse every one of
    // them; a row is addressed only when something follows its id.
    for (const verb of ['add', 'rename', 'reorder']) {
      expect(ask(`/workspaces/w-here/goals/${verb}`, 'POST').kind, verb).toBe('scope');
    }
  });

  it('answers a malformed escape rather than throwing on it', () => {
    // A URIError thrown inside a route match closes the connection with no
    // response at all — neither an allow nor a deny, chosen by the caller.
    // A verdict here IS the assertion: it cannot be reached if the call threw.
    expect(ask('/workspaces/w-here/goals/%E0%A4%A/archive', 'POST').kind).toBe('refused');
  });
});
