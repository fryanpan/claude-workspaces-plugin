/**
 * `POST /api/review-queue/rank` through the real server: the plan board's
 * lead ranks one item on another board and the cross-board queue (Home's
 * order) follows it, while every other caller is refused. An item on a
 * locked board takes a rank like any other (the owner, 2026-10-23: the lead
 * has the same visibility he does).
 *
 * Fixtures are invented; the repo is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ReviewPayload } from '@claude-workspaces/core';
import type { CrossReviewQueue } from '../src/cross-review-queue.ts';
import { type ServerHandle, createServer } from '../src/server.ts';

const LEAD = { id: 'agent-team-lead', name: 'Team Lead', kind: 'agent' };
const FILER = { id: 'agent-riverbend', name: 'Riverbend Agent', kind: 'agent' };
const OTHER = 'agent-harborlight';
const ASK: ReviewPayload = { shape: 'review', headline: 'Does the timetable read right?' };

let handle: ServerHandle;
let dataDir: string;
let base: string;
let callerIs: string | null = null;

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

async function jj<T>(res: Response): Promise<T> {
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json()) as T;
}

async function tokenFor(agentId: string): Promise<string> {
  callerIs = agentId;
  const res = await fetch(`${base}/api/agents/${agentId}/token`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { token: string }).token;
}

async function board(name: string): Promise<string> {
  const { workspace } = await jj<{ workspace: { id: string } }>(
    await post('/workspaces', { name, author: FILER }),
  );
  return workspace.id;
}

async function ticketItem(ws: string, title: string): Promise<string> {
  const { task } = await jj<{ task: { id: string } }>(
    await post(`/workspaces/${ws}/tasks`, {
      title,
      body: 'Agent can publish the timetable so that sailors plan.',
      author: FILER,
    }),
  );
  const { item } = await jj<{ item: { id: string } }>(
    await post(`/workspaces/${ws}/tasks/${task.id}/review-items`, { review: ASK, author: FILER }),
  );
  return `${ws}:task-review:${task.id}:${item.id}`;
}

const queueKeys = async () =>
  (await jj<CrossReviewQueue>(await fetch(`${base}/api/review-queue`))).items.map((i) => i.key);

const rank = async (agentId: string, key: string, value: number | null, token?: string) =>
  post(
    '/api/review-queue/rank',
    { agentId, key, rank: value },
    token ? { authorization: `Bearer ${token}` } : {},
  );

let plan = '';
let harbor = '';
let river = '';
let harborKey = '';
let riverKey = '';

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'review-rank-routes-'));
  handle = createServer({
    port: 0,
    dataDir,
    spawnerAgentId: null,
    identifyAgentCaller: async () => ({ ok: true, agentId: callerIs, via: 'session' }),
  });
  base = `http://127.0.0.1:${handle.port}`;
  plan = await board('Saltmarsh plan');
  writeFileSync(join(dataDir, 'review-plan.json'), JSON.stringify({ planWorkspaceId: plan }));
  await jj(
    await fetch(`${base}/workspaces/${plan}/lead`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ leadAgentId: LEAD.id, author: LEAD }),
    }),
  );
  harbor = await board('Harborlight');
  harborKey = await ticketItem(harbor, 'Harbour timetable');
  river = await board('Riverbend');
  riverKey = await ticketItem(river, 'Ferry timetable');
});

afterAll(async () => {
  await handle.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('POST /api/review-queue/rank', () => {
  it('Home’s queue follows the plan lead’s rank, and falls back when it is cleared', async () => {
    const before = await queueKeys();
    expect(before.indexOf(riverKey)).toBeLessThan(before.indexOf(harborKey));

    const token = await tokenFor(LEAD.id);
    const res = await jj<{ key: string; rank: number }>(await rank(LEAD.id, harborKey, 1, token));
    expect(res).toEqual({ key: harborKey, rank: 1 });
    const after = await queueKeys();
    expect(after[0]).toBe(harborKey);
    expect(after.filter((k) => k !== harborKey)).toEqual(before.filter((k) => k !== harborKey));

    await jj(await rank(LEAD.id, harborKey, null, token));
    expect(await queueKeys()).toEqual(before);
  });

  it('refuses any agent but the plan lead, even holding its own valid token', async () => {
    const res = await rank(OTHER, harborKey, 1, await tokenFor(OTHER));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('not-plan-lead');
  });

  it('refuses the lead’s id without its token, or with another agent’s', async () => {
    expect((await rank(LEAD.id, harborKey, 1)).status).toBe(401);
    const res = await rank(LEAD.id, harborKey, 1, await tokenFor(OTHER));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('agent-token-mismatch');
  });

  it('refuses a rank out of range and a key that names nothing', async () => {
    const token = await tokenFor(LEAD.id);
    expect((await rank(LEAD.id, harborKey, 0, token)).status).toBe(400);
    expect((await rank(LEAD.id, `${harbor}:task-review:t-none:r-none`, 1, token)).status).toBe(404);
  });

  it('ranks an item on a locked board, and a rank set before the lock still counts', async () => {
    const token = await tokenFor(LEAD.id);
    await jj(await rank(LEAD.id, riverKey, 1, token));
    expect((await queueKeys())[0]).toBe(riverKey);
    const lock = await post('/api/share/lock', {
      workspaceId: river,
      locked: true,
      reason: 'private',
      actor: { id: 'known-owner', name: 'Owner' },
    });
    expect(lock.status, await lock.clone().text()).toBe(200);
    // River's rank 1 still beats harbor's 5 after the lock.
    await jj(await rank(LEAD.id, harborKey, 5, token));
    expect((await queueKeys())[0]).toBe(riverKey);
    await jj(await rank(LEAD.id, riverKey, 6, token));
    expect((await queueKeys())[0]).toBe(harborKey);
  });
});
