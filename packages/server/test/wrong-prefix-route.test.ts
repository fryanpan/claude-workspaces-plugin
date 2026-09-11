/**
 * The wrong-prefix 404 (`routes/wrong-prefix.ts`): a guess at a board route
 * with `/api` in front is told the address without it, and nothing else
 * changes — a real `/api/*` route still answers, an unknown `/api/word` is
 * still a bare 404, and a share visitor is refused before the hint exists.
 * Fixtures are invented; the repo is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { wrongPrefixOf } from '../src/routes/wrong-prefix.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import {
  type AccessHarness,
  type MintedShare,
  accessHarness,
  mintAccessShare,
} from './access-share.ts';
import { seedBoard } from './workspace-seed.ts';

describe('what a wrong prefix is read as', () => {
  it('strips /api from a full board address', () => {
    expect(wrongPrefixOf('/api/workspaces/w-1/tasks/t-1/schedule')?.path).toBe(
      '/workspaces/w-1/tasks/t-1/schedule',
    );
  });
  it('puts a bare family back under a board', () => {
    expect(wrongPrefixOf('/api/tasks/t-1/schedule')?.path).toBe(
      '/workspaces/<workspaceId>/tasks/t-1/schedule',
    );
    expect(wrongPrefixOf('/api/docs')?.path).toBe('/workspaces/<workspaceId>/docs');
  });
  it('says nothing for a real or unknown /api route, or a non-api path', () => {
    for (const p of [
      '/api/deploy',
      '/api/auth/session',
      '/api/fortnightly',
      '/workspaces/w-1/tasks',
    ]) {
      expect(wrongPrefixOf(p), p).toBeUndefined();
    }
  });
});

describe('over HTTP', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let access: AccessHarness;
  let share: MintedShare;
  let boardId: string;

  const local = (path: string, init?: RequestInit) =>
    fetch(`${base}${path}`, { ...init, headers: { host: `localhost:${handle.port}` } });
  const pub = (path: string) =>
    fetch(`${base}${path}`, { redirect: 'manual', headers: share.headers });

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'wrong-prefix-'));
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

  /**
   * `workspaces` and `tasks` were both real addresses before the cutover, so
   * over HTTP they now reach the stale-client 410 one line above this hint
   * (`routes/stale-client.ts`), which carries the same address in its own
   * body. The families that were NEVER `/api` addresses — `threads` lived
   * under a doc, `attachments` and `next` under a board — are the ones this
   * hint still answers alone, and they are what the HTTP case asserts.
   * `wrongPrefixOf` itself is unchanged, which the unit block above shows.
   */
  it('names the right address on a prefixed board route, and stays a 404', async () => {
    const r = await local('/api/attachments/a-1', { method: 'POST' });
    expect(r.status).toBe(404);
    const body = (await r.json()) as { error: string; path: string; hint: string };
    expect(body.error).toBe('not found');
    expect(body.path).toBe('/workspaces/<workspaceId>/attachments/a-1');
    expect(body.hint).toContain('take no /api prefix');
    const bare = await local('/api/threads/th-1/resolve', { method: 'POST' });
    expect(bare.status).toBe(404);
    expect(((await bare.json()) as { path: string }).path).toBe(
      '/workspaces/<workspaceId>/threads/th-1/resolve',
    );
  });

  it('leaves a real /api route and an unknown one exactly as they were', async () => {
    // Control: a process-level route above the tail still answers.
    expect((await local('/api/meeting-engines')).status).toBe(200);
    // Control: a word the board has no family for is the bare 404 it was.
    const unknown = await local('/api/fortnightly');
    expect(unknown.status).toBe(404);
    expect(await unknown.text()).toBe('not found');
  });

  it('refuses a share visitor before the hint exists, as it does the real path', async () => {
    const real = await pub(`/workspaces/${boardId}/attachments/a-1`);
    const guessed = await pub('/api/attachments/a-1');
    expect(guessed.status).toBe(real.status);
    expect(guessed.status).not.toBe(404);
    expect(await guessed.text()).not.toContain('take no /api prefix');
  });
});
