/**
 * `GET /workspaces/<id>/keep-moving` (`routes/workspace-keep-moving.ts`):
 * the one read of the board's verdicts, owner-side only. The verdicts
 * themselves are tested in keep-moving-verdict.test.ts; this drives the
 * route over HTTP on a real server, once locally and once as a share
 * visitor. Fixtures are invented.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { shareScopeAllows } from '../src/middleware/host-guard.ts';
import { handleWorkspaceKeepMoving } from '../src/routes/workspace-keep-moving.ts';
import type {
  WorkspaceRouteRequest,
  WorkspaceRoutesContext,
} from '../src/routes/workspace-routes-context.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import {
  type AccessHarness,
  type MintedShare,
  accessHarness,
  mintAccessShare,
} from './access-share.ts';
import { seedBoard } from './workspace-seed.ts';

describe('the keep-moving route', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let access: AccessHarness;
  let share: MintedShare;
  let boardId: string;

  const local = (path: string) =>
    fetch(`${base}${path}`, { headers: { host: `localhost:${handle.port}` } });
  const pub = (path: string) =>
    fetch(`${base}${path}`, { redirect: 'manual', headers: share.headers });

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'keep-moving-route-'));
    access = await accessHarness();
    handle = createServer({ port: 0, dataDir, ...access.serverOptions });
    base = `http://127.0.0.1:${handle.port}`;
    boardId = await seedBoard(base, { name: 'Harbour plan' });
    share = await mintAccessShare(base, access, boardId);
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('answers a board that has no verdict yet with an empty history', async () => {
    const res = await local(`/workspaces/${boardId}/keep-moving`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ workspaceId: boardId, latest: null, history: [] });
  });

  it('refuses a board that does not exist', async () => {
    const res = await local('/workspaces/w-nope/keep-moving');
    expect(res.status).toBe(404);
  });

  it('is not a share member route, on the table and over the wire', async () => {
    // The lines name row ids on the owner's board; a visitor gets nothing.
    expect(
      shareScopeAllows('/workspaces/ws-1/keep-moving', 'GET', { workspaceId: 'ws-1' }, () => [
        'ws-1',
      ]),
    ).toBe(false);
    const theirs = await pub(`/workspaces/${boardId}/keep-moving`);
    expect(theirs.status).toBe(403);
    // Positive control: the same visitor reaches the board they were given.
    expect((await pub(`/workspaces/${boardId}/manifest.webmanifest`)).status).toBe(200);
  });

  it('refuses a visitor on its own, should the table ever admit the path', () => {
    // The handler's own check, behind the table's — reachable only directly.
    const j = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    const ctx = {
      j,
      keepMovingVerdicts: { latest: () => undefined, history: () => [] },
    } as unknown as WorkspaceRoutesContext;
    const rq = (visitor: WorkspaceRouteRequest['visitor']): WorkspaceRouteRequest =>
      ({
        req: new Request('http://x/workspaces/ws-1/keep-moving'),
        pathname: '/workspaces/ws-1/keep-moving',
        scope: { workspaceId: 'ws-1', rest: 'keep-moving', board: {} },
        visitor,
      }) as unknown as WorkspaceRouteRequest;
    expect(handleWorkspaceKeepMoving(ctx, rq({ workspaceId: 'ws-1' }))?.status).toBe(403);
    expect(handleWorkspaceKeepMoving(ctx, rq(null))?.status).toBe(200);
  });
});
