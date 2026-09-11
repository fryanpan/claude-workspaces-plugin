/**
 * The task address a person pastes, and what the server does with it.
 *
 * `/workspaces/<ws>/tasks/<taskId>` is the API PREFIX — every route there
 * carries a verb after the id — so the bare path was a 404 with an
 * `application/octet-stream` body, which Chrome renders as
 * `ERR_INVALID_RESPONSE`. Agents write the path form because that is what a
 * resource address looks like everywhere else in this server, and a person
 * then opens it.
 *
 * Four behaviours, asserted over the real routes because the interesting half
 * is the CHAIN: the redirect has to run below every task route (so it shadows
 * none of them) and below the shell (so it claims no page), while the
 * not-found answers have to be reached at all — one of them is decided in the
 * scope middleware, several hundred lines above the other.
 *
 * The fifth is that this widened nothing. A share visitor is refused the bare
 * task path by `shareScopeAllows`, which never had `tasks/<id>` in its table,
 * and the case below is that the refusal is unchanged rather than turned into
 * a redirect the visitor can follow.
 *
 * All fixtures are synthetic.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleTaskPageRoutes } from '../src/routes/task-page.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { type AccessHarness, accessHarness, mintAccessShare } from './access-share.ts';
import { seedBoard } from './workspace-seed.ts';

const PERSON = { id: 'person:reviewer', name: 'Reviewer', kind: 'person' };

describe('handleTaskPageRoutes, driven directly', () => {
  const ask = (pathname: string, search = '', method = 'GET') =>
    handleTaskPageRoutes({ method, pathname, url: new URL(`http://x${pathname}${search}`) });

  it('declines every path that is not a task address', () => {
    for (const p of ['/', '/workspaces', '/workspaces/w-1', '/workspaces/w-1/tasks']) {
      expect(ask(p), p).toBeUndefined();
    }
  });

  it('declines a method a browser never uses for a link', () => {
    // A POST to the bare path is nobody's route and stays a plain 404: this
    // module answers the address a person opened, not every call to it.
    expect(ask('/workspaces/w-1/tasks/t-1', '', 'POST')).toBeUndefined();
  });

  it('encodes the ids it puts back into the redirect', () => {
    // A board id or a task id carrying a slash or a space must not be able to
    // change the path the redirect names.
    const r = ask('/workspaces/w%2Fodd/tasks/t%20one');
    expect(r?.status).toBe(302);
    expect(r?.headers.get('location')).toBe('/workspaces/w%2Fodd?task=t+one');
  });
});

describe('the task address over HTTP', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let board: string;
  let taskId: string;

  const local = (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      redirect: 'manual',
      ...init,
      headers: {
        host: `localhost:${handle.port}`,
        ...((init.headers as Record<string, string>) ?? {}),
      },
    });

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'task-page-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://127.0.0.1:${handle.port}`;
    board = await seedBoard(base, { host: `localhost:${handle.port}` });
    const filed = await local(`/workspaces/${board}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Bryan can open a task link so that the row is on screen',
        author: PERSON,
      }),
    });
    expect(filed.status).toBe(200);
    taskId = ((await filed.json()) as { task: { id: string } }).task.id;
  });

  afterEach(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('sends the bare task path to the board with that task open', async () => {
    const r = await local(`/workspaces/${board}/tasks/${taskId}`);
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe(
      `/workspaces/${encodeURIComponent(board)}?task=${encodeURIComponent(taskId)}`,
    );
  });

  it('keeps a query string the link was carrying', async () => {
    const r = await local(`/workspaces/${board}/tasks/${taskId}?from=doc&tab=activity`);
    expect(r.status).toBe(302);
    const location = r.headers.get('location') ?? '';
    const target = new URL(location, base);
    expect(target.pathname).toBe(`/workspaces/${encodeURIComponent(board)}`);
    expect(target.searchParams.get('from')).toBe('doc');
    expect(target.searchParams.get('tab')).toBe('activity');
    expect(target.searchParams.get('task')).toBe(taskId);
  });

  it('answers a task this board does not have with a readable page', async () => {
    const r = await local(`/workspaces/${board}/tasks/t-absent`);
    expect(r.status).toBe(404);
    expect(r.headers.get('content-type') ?? '').toContain('text/html');
    const body = await r.text();
    // The board link is the point of the page: the reader is one tap from
    // where they were going, rather than back at the server root.
    expect(body).toContain(`href="/workspaces/${encodeURIComponent(board)}"`);
  });

  it('offers no board link when the BOARD is what is missing', async () => {
    // The escape route is only an escape route if it goes somewhere. A board
    // id that names nothing gets the board's own not-found page, not an
    // invitation to open a board that is not there.
    const r = await local('/workspaces/w-none/tasks/t-anything');
    expect(r.status).toBe(404);
    expect(r.headers.get('content-type') ?? '').toContain('text/html');
    const body = await r.text();
    expect(body).not.toContain('href="/workspaces/w-none"');
    expect(body).toContain('Workspace not found');
  });

  it('answers an unknown verb under a real task with a readable page', async () => {
    const r = await local(`/workspaces/${board}/tasks/${taskId}/detials`);
    expect(r.status).toBe(404);
    expect(r.headers.get('content-type') ?? '').toContain('text/html');
    expect(await r.text()).toContain(`href="/workspaces/${encodeURIComponent(board)}"`);
  });

  it('answers a sub-path of a task that is not there as JSON, deliberately', async () => {
    // THE BOUNDARY, pinned rather than left to be rediscovered. A verb under
    // a task the board does not hold is refused by the scope middleware,
    // above this module, and refused as JSON — because the SAME shape is how
    // every API client asks for `/detail` on a row that has been archived,
    // and handing it a page would break the caller that reads `error`. It is
    // a readable 404 either way: `application/json` with a body, never the
    // `application/octet-stream` a browser renders as ERR_INVALID_RESPONSE.
    // Docs and mockups have answered this shape the same way all along.
    const r = await local(`/workspaces/${board}/tasks/t-absent/detials`);
    expect(r.status).toBe(404);
    expect(r.headers.get('content-type') ?? '').toContain('application/json');
    expect(await r.json()).toEqual({ error: 'not-found' });
  });

  it('POSITIVE CONTROL: the API verbs under the same prefix still answer', async () => {
    // The redirect sits below every task route. Without this, "the bare path
    // redirects" is also what shadowing `/detail` would look like.
    const detail = await local(`/workspaces/${board}/tasks/${taskId}/detail`);
    expect(detail.status).toBe(200);
    expect(detail.headers.get('content-type') ?? '').toContain('application/json');
    const links = await local(`/workspaces/${board}/tasks/${taskId}/links`);
    expect(links.status).toBe(200);
    const retitled = await local(`/workspaces/${board}/tasks/${taskId}/title`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Bryan can open a task link and land on it', author: PERSON }),
    });
    expect(retitled.status).toBe(200);
  });

  it('leaves a JSON caller the answer it always had', async () => {
    // `?format=json` is an API client with a typo, not a person: it keeps the
    // bare 404 rather than being handed a page it cannot parse.
    const r = await local(`/workspaces/${board}/tasks/${taskId}/detials?format=json`);
    expect(r.status).toBe(404);
    expect(r.headers.get('content-type') ?? '').not.toContain('text/html');
  });

  it('never redirects a JSON caller off the task onto the board', async () => {
    // The redirect is for a person. An API client that followed it would be
    // handed the whole board where it asked for one task — a wrong answer
    // with a 200 on it, which is worse than the 404 it had before.
    const r = await local(`/workspaces/${board}/tasks/${taskId}?format=json`);
    expect(r.status).toBe(404);
    expect(r.headers.get('location')).toBeNull();
  });
});

describe('a share visitor is refused the task address, exactly as before', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let access: AccessHarness;
  let board: string;
  let taskId: string;
  let share: { host: string; headers: Record<string, string> };

  const local = (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      redirect: 'manual',
      ...init,
      headers: {
        host: `localhost:${handle.port}`,
        ...((init.headers as Record<string, string>) ?? {}),
      },
    });

  const visitor = (path: string) =>
    fetch(`${base}${path}`, { redirect: 'manual', headers: share.headers });

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'task-page-share-'));
    access = await accessHarness();
    handle = createServer({ port: 0, dataDir, ...access.serverOptions });
    base = `http://127.0.0.1:${handle.port}`;
    board = await seedBoard(base, { host: `localhost:${handle.port}` });
    const filed = await local(`/workspaces/${board}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'A row a visitor can see on the board', author: PERSON }),
    });
    expect(filed.status).toBe(200);
    taskId = ((await filed.json()) as { task: { id: string } }).task.id;
    share = await mintAccessShare(base, access, board);
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('refuses the bare task path, and never issues the redirect', async () => {
    const r = await visitor(`/workspaces/${board}/tasks/${taskId}`);
    expect(r.status).toBe(403);
    expect(r.headers.get('location')).toBeNull();
  });

  it('POSITIVE CONTROL: the same visitor reaches the board page and the row’s detail', async () => {
    // Without this, "403 on the task path" would also be what a visitor whose
    // share had expired looks like — and the redirect's TARGET has to be
    // somewhere they could already go for the scope to be unchanged.
    expect((await visitor(`/workspaces/${board}`)).status).toBe(200);
    expect((await visitor(`/workspaces/${board}/tasks/${taskId}/detail`)).status).toBe(200);
  });
});
