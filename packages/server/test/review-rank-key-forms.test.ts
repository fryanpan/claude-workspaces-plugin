/**
 * `POST /api/review-queue/rank` takes an item by any of the three names a
 * lead is handed for it, and says why when the item is not on the queue.
 *
 * The three names: the queue key a `workspace.new_asks` line carries
 * (`<workspaceId>:task-review:<taskId>:<itemId>`), the board-relative key
 * Home's `?item=` link carries (`task-review:<taskId>:<itemId>`), and the
 * bare review-item id. The route matched only the first, so a lead holding
 * either of the others was told `not-found` about an item sitting open on
 * Home.
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
const ASK: ReviewPayload = { shape: 'review', headline: 'Does the timetable read right?' };
const HELD: ReviewPayload = { shape: 'review', headline: 'HOLD this one' };

let handle: ServerHandle;
let dataDir: string;
let base: string;
let token = '';

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

async function board(name: string): Promise<string> {
  const { workspace } = await jj<{ workspace: { id: string } }>(
    await post('/workspaces', { name, author: FILER }),
  );
  return workspace.id;
}

async function ticketItem(ws: string, title: string, review: ReviewPayload) {
  const { task } = await jj<{ task: { id: string } }>(
    await post(`/workspaces/${ws}/tasks`, {
      title,
      body: 'Agent can publish the timetable so that sailors plan.',
      author: FILER,
    }),
  );
  const { item } = await jj<{ item: { id: string } }>(
    await post(`/workspaces/${ws}/tasks/${task.id}/review-items`, { review, author: FILER }),
  );
  return { taskId: task.id, itemId: item.id, key: `${ws}:task-review:${task.id}:${item.id}` };
}

const rank = (key: string, value: number | null) =>
  post(
    '/api/review-queue/rank',
    { agentId: LEAD.id, key, rank: value },
    { authorization: `Bearer ${token}` },
  );

const queueKeys = async () =>
  (await jj<CrossReviewQueue>(await fetch(`${base}/api/review-queue`))).items.map((i) => i.key);

let harbor = '';
let open = { taskId: '', itemId: '', key: '' };

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'review-rank-key-forms-'));
  let callerIs: string | null = null;
  handle = createServer({
    port: 0,
    dataDir,
    spawnerAgentId: null,
    identifyAgentCaller: async () => ({ ok: true, agentId: callerIs, via: 'session' }),
    // The judge passes every item but the one written to be held, so the
    // open items are judged ok exactly as the reported one was.
    reviewJudge: async (input) =>
      JSON.stringify(input).includes('HOLD')
        ? { ok: false, reason: 'No stakes.' }
        : { ok: true, reason: 'The stakes are stated.' },
    keepMovingCadenceMs: 0,
  });
  base = `http://127.0.0.1:${handle.port}`;
  const plan = await board('Saltmarsh plan');
  writeFileSync(join(dataDir, 'review-plan.json'), JSON.stringify({ planWorkspaceId: plan }));
  await jj(
    await fetch(`${base}/workspaces/${plan}/lead`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ leadAgentId: LEAD.id, author: LEAD }),
    }),
  );
  harbor = await board('Harborlight');
  open = await ticketItem(harbor, 'Harbour timetable', ASK);
  callerIs = LEAD.id;
  const res = await fetch(`${base}/api/agents/${LEAD.id}/token`);
  token = ((await res.json()) as { token: string }).token;
});

afterAll(async () => {
  await handle.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('the rank route takes every name a lead is handed for an item', () => {
  it('the feed key, the Home key and the bare id all rank the same item', async () => {
    expect(await queueKeys()).toContain(open.key);
    const forms = [
      open.key,
      `task-review:${open.taskId}:${open.itemId}`,
      encodeURIComponent(`task-review:${open.taskId}:${open.itemId}`),
      open.itemId,
    ];
    for (const [i, form] of forms.entries()) {
      const res = await rank(form, i + 1);
      expect(res.status, `${form}: ${await res.clone().text()}`).toBe(200);
      // The answer names the queue key, whichever name was sent.
      expect(((await res.json()) as { key: string }).key).toBe(open.key);
    }
    await jj(await rank(open.itemId, null));
  });

  it('an item the judge held says it is held, not that it does not exist', async () => {
    const held = await ticketItem(harbor, 'Tide table', HELD);
    expect(await queueKeys()).not.toContain(held.key);
    for (const form of [held.key, held.itemId]) {
      const res = await rank(form, 1);
      expect(res.status).toBe(404);
      expect(((await res.json()) as { error: string }).error).toBe('held');
    }
  });

  it('an item on a done task says its task is done', async () => {
    const closed = await ticketItem(harbor, 'Ferry fares', ASK);
    await jj(
      await post(`/workspaces/${harbor}/tasks/${closed.taskId}/transition`, {
        to: 'done',
        author: FILER,
        workspaceId: harbor,
      }),
    );
    const res = await rank(`task-review:${closed.taskId}:${closed.itemId}`, 1);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe('task-done');
  });

  it('a held item named under another board is not-found, not held', async () => {
    const held = await ticketItem(harbor, 'Slipway hours', HELD);
    const res = await rank(`w-elsewhere:task-review:${held.taskId}:${held.itemId}`, 1);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe('not-found');
  });

  it('a name that matches nothing is still not-found', async () => {
    for (const form of ['r-none', 'task-review:t-none:r-none', `${harbor}:task-review:t-x:r-x`]) {
      const res = await rank(form, 1);
      expect(res.status).toBe(404);
      expect(((await res.json()) as { error: string }).error).toBe('not-found');
    }
  });
});
