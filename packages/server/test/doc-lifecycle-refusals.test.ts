/**
 * What the doc-lifecycle routes refuse, and with which answer. These are the
 * routes `routes/doc-lifecycle-contract.ts` declares for the MCP: a doc's
 * create, its rewrite, its archive and unarchive, and an app's attach. The
 * happy paths have suites of their own; this file drives each route's
 * refusals through the real server, so a refusal that moves or changes its
 * error word fails here rather than reaching an agent as a different answer.
 *
 * All fixtures are synthetic.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { seedBoard } from './workspace-seed.ts';

let handle: ServerHandle;
let dataDir: string;
let base = '';
let ws = '';

/** POST `body` as an agent would; `headers` adds to the agent's own. */
async function post(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; error: unknown }> {
  const r = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const parsed = (await r.json()) as { error?: unknown };
  return { status: r.status, error: parsed.error };
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'doc-refusals-'));
  handle = createServer({ port: 0, dataDir, requireSignInToWrite: false });
  base = `http://127.0.0.1:${handle.port}`;
  ws = await seedBoard(base, { name: 'Harborlight' });
});

afterAll(() => {
  handle.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('POST /workspaces/:ws/docs refuses', () => {
  it('a page, since a bind names a host path', async () => {
    const r = await post(
      `/workspaces/${ws}/docs`,
      { docId: 'riverbend' },
      { origin: 'http://127.0.0.1:9' },
    );
    expect(r.status).toBe(403);
  });

  it('a docId that is not one', async () => {
    expect(await post(`/workspaces/${ws}/docs`, { docId: '../up' })).toEqual({
      status: 400,
      error: 'bad docId',
    });
  });

  it('an app or a diff, which have routes of their own', async () => {
    const app = await post(`/workspaces/${ws}/docs`, { docId: 'riverbend-app', type: 'app' });
    expect(app).toEqual({ status: 400, error: 'use POST /workspaces/{workspaceId}/apps' });
    const diff = await post(`/workspaces/${ws}/docs`, { docId: 'riverbend-diff', type: 'diff' });
    expect(diff).toEqual({ status: 400, error: 'use POST /workspaces/{workspaceId}/attachments' });
  });

  it('a markdown doc with no file behind it', async () => {
    expect(await post(`/workspaces/${ws}/docs`, { docId: 'riverbend-md' })).toEqual({
      status: 400,
      error: 'sourceUrl required',
    });
  });
});

describe('POST /workspaces/:ws/docs/:docId/content refuses', () => {
  it('an empty rewrite, and leaves the doc as it was', async () => {
    const file = join(dataDir, 'saltmarsh.md');
    writeFileSync(file, '# Saltmarsh\n\nKept.\n');
    const made = await post(`/workspaces/${ws}/docs`, { docId: 'saltmarsh', sourceUrl: file });
    expect(made.status).toBe(200);
    expect(await post(`/workspaces/${ws}/docs/saltmarsh/content`, { markdown: '' })).toEqual({
      status: 400,
      error: 'markdown is required',
    });
    const after = await fetch(`${base}/workspaces/${ws}/docs/saltmarsh/content`);
    expect(((await after.json()) as { plainText: string }).plainText).toContain('Kept.');
  });
});

describe('archiving a doc that does not exist', () => {
  it('answers not found, both ways', async () => {
    const archived = await post(`/workspaces/${ws}/docs/no-such-doc/archive`, { reason: 'gone' });
    expect(archived.status).toBe(404);
    const back = await post(`/workspaces/${ws}/docs/no-such-doc/unarchive`, {});
    expect(back.status).toBe(404);
  });
});

describe('POST /workspaces/:ws/apps refuses', () => {
  const origin = 'http://127.0.0.1:8798';

  it('a page, since a bind names a host path', async () => {
    const r = await post(
      `/workspaces/${ws}/apps`,
      { docId: 'riverbend-dev', origin },
      { 'sec-fetch-site': 'same-origin' },
    );
    expect(r.status).toBe(403);
  });

  it('a docId that is not one', async () => {
    expect(await post(`/workspaces/${ws}/apps`, { docId: '', origin })).toEqual({
      status: 400,
      error: 'bad docId',
    });
  });

  it('a servesPrefix that is not true or false', async () => {
    const r = await post(`/workspaces/${ws}/apps`, {
      docId: 'riverbend-dev',
      origin,
      servesPrefix: 'yes',
    });
    expect(r).toEqual({ status: 400, error: 'bad servesPrefix' });
  });
});
