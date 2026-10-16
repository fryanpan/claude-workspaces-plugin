/**
 * `POST /workspaces/:ws/agents/:name/prompts`: the UserPromptSubmit hook's
 * mark that a session got a prompt and whether a person typed it. It takes a
 * boolean, a short session id and the typed prompt's text, refuses anything
 * else, and stores nothing a board read can return.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { seedBoard } from './workspace-seed.ts';

let handle: ServerHandle;
let base: string;
let dataDir: string;
let WS = '';

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'prompt-marks-'));
  handle = createServer({ port: 0, dataDir });
  base = `http://127.0.0.1:${handle.port}`;
  WS = await seedBoard(base);
});
afterAll(async () => {
  await handle.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

const path = (agent: string) => `/workspaces/${WS}/agents/${encodeURIComponent(agent)}/prompts`;
const post = (agent: string, body: unknown) =>
  fetch(`${base}${path(agent)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

describe('POST /workspaces/:ws/agents/:name/prompts', () => {
  it('takes a typed or injected mark, and leaves no note behind', async () => {
    const ok = await post('Harborlight lead', {
      typed: true,
      sessionId: 's-1',
      cwd: '/work/harborlight',
      at: Date.now(),
    });
    expect(ok.status).toBe(202);
    expect((await post('Harborlight lead', { typed: false })).status).toBe(202);
    const notes = await fetch(`${base}/workspaces/${WS}/agents/Harborlight%20lead/notes`);
    expect(((await notes.json()) as { notes: unknown[] }).notes).toEqual([]);
  });

  it('refuses a missing or non-boolean typed, a bad session id or text, a shared name and a GET', async () => {
    expect((await post('Harborlight lead', {})).status).toBe(400);
    expect((await post('Harborlight lead', { typed: 'yes' })).status).toBe(400);
    expect((await post('Harborlight lead', 'not json')).status).toBe(400);
    expect((await post('Harborlight lead', { typed: true, sessionId: 7 })).status).toBe(400);
    expect(
      (await post('Harborlight lead', { typed: true, sessionId: 'x'.repeat(201) })).status,
    ).toBe(400);
    expect((await post('agent', { typed: true })).status).toBe(400);
    expect((await post('Harborlight lead', { typed: true, text: 7 })).status).toBe(400);
    expect((await post('Harborlight lead', { typed: true, text: 'x'.repeat(4_001) })).status).toBe(
      400,
    );
    expect((await post('Harborlight lead', { typed: true, text: 'chart the berths' })).status).toBe(
      202,
    );
    expect((await fetch(`${base}${path('Harborlight lead')}`)).status).toBe(405);
  });
});
