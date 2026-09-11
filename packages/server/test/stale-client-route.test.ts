/**
 * The stale-client answer (`routes/stale-client.ts`): a pre-cutover address
 * is told the CLIENT is behind, while a board that really is missing keeps
 * answering missing on a current-shape route.
 *
 * The pairing is the point and is why both live in one test. The failure this
 * fixes was not that the old address 404s — it is that the 404 it gives is
 * the same 404 a deleted board gives, so the two must be asserted against
 * each other or the fix cannot be shown to have worked. Fixtures are
 * invented; the repo is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleStaleClient, staleClientOf } from '../src/routes/stale-client.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import {
  type AccessHarness,
  type MintedShare,
  accessHarness,
  mintAccessShare,
} from './access-share.ts';
import { seedBoard } from './workspace-seed.ts';

describe('which addresses read as a stale client', () => {
  it('claims the old board surface and the families that moved under it', () => {
    for (const p of [
      '/api/workspaces',
      '/api/workspaces/w-1/tasks',
      '/api/workspaces/w-1/next?includeBlocked=true',
      '/api/docs/d-1/content',
      '/api/tasks/t-1/transition',
      '/api/goals/g-1',
      '/api/reviews/r-1/refresh',
      '/api/agent-notes',
    ]) {
      expect(staleClientOf(p, '0.1.189')?.reason, p).toBe('stale-client');
    }
  });

  it('claims nothing else — a live route, an invented word, a canonical path', () => {
    for (const p of ['/api/deploy', '/api/share/enabled', '/api/fortnightly', '/workspaces/w-1']) {
      expect(staleClientOf(p, '0.1.189'), p).toBeUndefined();
    }
  });

  it('names the cause, the remedy and the current address in one sentence', () => {
    const v = staleClientOf('/api/workspaces/w-1/tasks', '0.1.189');
    expect(v?.message).toContain('older');
    expect(v?.message).toContain('The board is not missing');
    expect(v?.message).toContain('claude plugin update');
    expect(v?.message).toContain('restart the session');
    expect(v?.message).toContain('0.1.189');
    expect(v?.path).toBe('/workspaces/w-1/tasks');
  });

  it('offers no address for a family that was renamed as well as moved', () => {
    const v = staleClientOf('/api/agent-notes', '0.1.189');
    expect(v?.path).toBeUndefined();
    expect(v?.message).not.toContain('current address');
  });

  it('still says update-then-restart when the version cannot be read', () => {
    // A manifest this server cannot read means "we do not know what current
    // is" — it must not suppress the verdict, only the version claim.
    const res = handleStaleClient('/api/workspaces/w-1/tasks', () => null);
    expect(res?.status).toBe(410);
    const v = staleClientOf('/api/workspaces/w-1/tasks', null);
    expect(v?.serverVersion).toBeUndefined();
    expect(v?.message).toContain('restart the session');
  });
});

describe('a stale shape and a missing board, over HTTP', () => {
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
    dataDir = mkdtempSync(join(tmpdir(), 'stale-client-'));
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

  it('reads a pre-cutover board call as a stale client, not as a missing board', async () => {
    const r = await local(`/api/workspaces/${boardId}/tasks`);
    expect(r.status).toBe(410);
    const body = (await r.json()) as {
      error: string;
      reason: string;
      path: string;
      serverVersion: string;
      message: string;
    };
    expect(body.error).toBe('gone');
    expect(body.reason).toBe('stale-client');
    expect(body.path).toBe(`/workspaces/${boardId}/tasks`);
    expect(body.serverVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(body.message).toContain('The board is not missing');
    expect(body.message).toContain('claude plugin update');
  });

  it('reads a board that really is missing as missing, on the current shape', async () => {
    // Same verb, current address, a board id nothing ever created. This is
    // the case the stale answer must NOT swallow.
    const r = await local('/workspaces/w-missing/tasks?format=json');
    expect(r.status).toBe(404);
    expect(r.status).not.toBe(410);
    const text = await r.text();
    expect(text).toContain('workspace not found');
    expect(text).not.toContain('stale-client');
  });

  it('leaves a live /api route and an invented one exactly as they were', async () => {
    // Control: a process-level route above the tail still answers.
    expect((await local('/api/meeting-engines')).status).toBe(200);
    // Control: a word that was never an address is the bare 404 it was.
    const unknown = await local('/api/fortnightly');
    expect(unknown.status).toBe(404);
    expect(await unknown.text()).toBe('not found');
  });

  it('refuses a share visitor before the verdict exists, as it does the real path', async () => {
    const real = await pub(`/workspaces/${boardId}/tasks/t-1/transition`);
    const stale = await pub(`/api/workspaces/${boardId}/tasks/t-1/transition`);
    expect(stale.status).toBe(real.status);
    expect(stale.status).not.toBe(410);
    expect(await stale.text()).not.toContain('stale-client');
  });
});
