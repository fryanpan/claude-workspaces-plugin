/**
 * What the attachment-set routes the MCP calls refuse, and with which
 * answer. These routes are declared in `routes/attachments-contract.ts`: a
 * diff review's create, and the refresh of a set that does not exist. Each
 * case drives the real server, so a refusal that moves or changes its error
 * word fails here rather than reaching an agent as a different answer.
 *
 * All fixtures are synthetic.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { seedBoard } from './workspace-seed.ts';

let handle: ServerHandle;
let dataDir: string;
let base = '';
let ws = '';

async function answer(r: Response): Promise<{ status: number; error: unknown }> {
  return { status: r.status, error: ((await r.json()) as { error?: unknown }).error };
}

const post = (path: string, body: unknown) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then(answer);

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'attachment-refusals-'));
  handle = createServer({ port: 0, dataDir, requireSignInToWrite: false });
  base = `http://127.0.0.1:${handle.port}`;
  ws = await seedBoard(base, { name: 'Riverbend' });
});

afterAll(() => {
  handle.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('POST /workspaces/:ws/attachments refuses a diff review', () => {
  it('with no repository', async () => {
    const r = await post(`/workspaces/${ws}/attachments`, { base: 'main' });
    expect(r.status).toBe(400);
    expect(String(r.error)).toStartWith('repo is required.');
  });

  it('pinned to a target with no base', async () => {
    expect(await post(`/workspaces/${ws}/attachments`, { repo: dataDir, target: 'HEAD' })).toEqual({
      status: 400,
      error: 'target requires base',
    });
  });

  it('named by an id that is not one', async () => {
    const r = await post(`/workspaces/${ws}/attachments`, { repo: dataDir, reviewId: '../up' });
    expect(r).toEqual({ status: 400, error: 'bad reviewId' });
  });
});

describe('a set that does not exist', () => {
  const set = () => `/workspaces/${ws}/attachments/no-such-set`;

  it('is not refreshed', async () => {
    const r = await post(`${set()}/refresh`, {});
    expect(r.status).toBe(404);
  });
});
