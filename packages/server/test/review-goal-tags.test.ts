/**
 * The plan lead's goal tag through the real server: `POST
 * /api/review-queue/rank` with a `goal` files an ask under one of the plan
 * board's goals (or urgent, not-this-week, drop), the queue carries it, and
 * Home groups by it. Only the plan lead may tag, a tag must name something the
 * plan has. An item on a locked board takes a tag like any other (the owner,
 * 2026-10-23: the lead has the same visibility he does), and so does a shared
 * board's: the lead holds the key already, the write answers with no more
 * than it was sent, and the tag is read only on the owner's Home.
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
const PERSON = { id: 'alice', name: 'Alice', kind: 'human' };
const OTHER = 'agent-harborlight';
const ASK: ReviewPayload = { shape: 'review', headline: 'Does the timetable read right?' };

let handle: ServerHandle;
let dataDir: string;
let base: string;
let callerIs: string | null = null;

const send = (method: string, path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
const post = (path: string, body: unknown, headers?: Record<string, string>) =>
  send('POST', path, body, headers);

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

async function ticketItem(ws: string, title: string, headline: string): Promise<string> {
  const { task } = await jj<{ task: { id: string } }>(
    await post(`/workspaces/${ws}/tasks`, {
      title,
      body: 'Agent can publish the timetable so that sailors plan.',
      author: FILER,
    }),
  );
  const { item } = await jj<{ item: { id: string } }>(
    await post(`/workspaces/${ws}/tasks/${task.id}/review-items`, {
      review: { ...ASK, headline },
      author: FILER,
    }),
  );
  return `${ws}:task-review:${task.id}:${item.id}`;
}

const queue = async () =>
  (await jj<CrossReviewQueue>(await fetch(`${base}/api/review-queue`))).items;
const tagOf = async (key: string) => (await queue()).find((i) => i.key === key)?.goalTag;
const landing = async () => (await fetch(`${base}/`)).text();
const headings = (html: string) =>
  [...html.matchAll(/<details class="goal-sec[^"]*"(?: open)?><summary>(.*?)<\/summary>/g)].map(
    (m) => (m[1] ?? '').replace(/<[^>]+>/g, '').trim(),
  );

const tag = async (agentId: string, key: string, body: Record<string, unknown>, token?: string) =>
  post(
    '/api/review-queue/rank',
    { agentId, key, ...body },
    token ? { authorization: `Bearer ${token}` } : {},
  );

let plan = '';
let harbor = '';
let river = '';
let tideGoal = '';
let harborKey = '';
let riverKey = '';
let saltKey = '';

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'review-goal-tags-'));
  handle = createServer({
    port: 0,
    dataDir,
    spawnerAgentId: null,
    identifyAgentCaller: async () => ({ ok: true, agentId: callerIs, via: 'session' }),
    // A share hostname, so a board can be shared; no visitor ever arrives.
    cfAccess: {
      teamDomain: 'test.cloudflareaccess.com',
      audience: 'aud-owner',
      jwks: { keys: [] },
    },
    shareLinkHosts: ['share.example.test'],
    shareLinkAudience: 'aud-share',
  });
  base = `http://127.0.0.1:${handle.port}`;
  plan = await board('Saltmarsh plan');
  writeFileSync(join(dataDir, 'review-plan.json'), JSON.stringify({ planWorkspaceId: plan }));
  await jj(await send('PUT', `/workspaces/${plan}/lead`, { leadAgentId: LEAD.id, author: LEAD }));
  const { created } = await jj<{ created: Array<{ id: string }> }>(
    await send('PUT', `/workspaces/${plan}/goals`, {
      goals: [{ title: 'Tide tables out' }, { title: 'Ferry wrap-up' }],
      author: PERSON,
    }),
  );
  tideGoal = created[0]?.id ?? '';
  harbor = await board('Harborlight');
  harborKey = await ticketItem(harbor, 'Harbour timetable', 'Is the harbour table right?');
  river = await board('Riverbend');
  riverKey = await ticketItem(river, 'Ferry timetable', 'Is the ferry table right?');
  const salt = await board('Saltmarsh');
  saltKey = await ticketItem(salt, 'Marsh walk', 'Is the marsh walk worth it?');
});

afterAll(async () => {
  await handle.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('the plan lead’s goal tag', () => {
  it('groups Home by goal once the lead tags, and Home is unchanged before', async () => {
    const before = await landing();
    expect(before).toContain('class="qgrp"');
    expect(headings(before)).toEqual([]);

    const token = await tokenFor(LEAD.id);
    expect(await jj<unknown>(await tag(LEAD.id, harborKey, { goal: tideGoal }, token))).toEqual({
      key: harborKey,
      goal: tideGoal,
    });
    expect(
      await jj<unknown>(await tag(LEAD.id, riverKey, { rank: 1, goal: 'urgent' }, token)),
    ).toEqual({
      key: riverKey,
      rank: 1,
      goal: 'urgent',
    });
    await jj(await tag(LEAD.id, saltKey, { goal: 'not-this-week' }, token));
    expect(await tagOf(harborKey)).toBe(tideGoal);

    const html = await landing();
    expect(html).not.toContain('class="qgrp"');
    expect(headings(html)).toEqual(['Urgent 1', 'Tide tables out 1', 'Not this week 1']);
    expect(html).toContain('<label for="goal-view-top">Top 10</label>');
    // A tag leaves the rank alone, and the other way round.
    expect((await queue()).find((i) => i.key === riverKey)?.leadRank).toBe(1);
    await jj(await tag(LEAD.id, riverKey, { rank: null }, token));
    expect(await tagOf(riverKey)).toBe('urgent');
  });

  it('refuses any agent but the plan lead, and leaves the tag as it was', async () => {
    const res = await tag(OTHER, harborKey, { goal: 'drop' }, await tokenFor(OTHER));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('not-plan-lead');
    expect(await tagOf(harborKey)).toBe(tideGoal);
  });

  it('refuses a goal the plan does not have, and a call with nothing to set', async () => {
    const token = await tokenFor(LEAD.id);
    const res = await tag(LEAD.id, harborKey, { goal: 'g-nowhere' }, token);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('bad-goal');
    expect((await tag(LEAD.id, harborKey, { goal: 7 }, token)).status).toBe(400);
    expect((await tag(LEAD.id, harborKey, {}, token)).status).toBe(400);
    expect(await tagOf(harborKey)).toBe(tideGoal);
  });

  it('tags an item on a locked board, and a tag set before the lock still counts', async () => {
    const token = await tokenFor(LEAD.id);
    expect(await tagOf(riverKey)).toBe('urgent');
    const lock = await post('/api/share/lock', {
      workspaceId: river,
      locked: true,
      reason: 'private',
      actor: { id: 'known-owner', name: 'Owner' },
    });
    expect(lock.status, await lock.clone().text()).toBe(200);
    expect(await tagOf(riverKey)).toBe('urgent');
    expect(headings(await landing())).toContain('Urgent 1');
    expect((await tag(LEAD.id, riverKey, { goal: 'drop' }, token)).status).toBe(200);
    expect(await tagOf(riverKey)).toBe('drop');
  });

  it('ranks and tags an item on a shared board, and Home applies both', async () => {
    const shared = await post('/api/share/workspace', { workspaceId: harbor });
    expect(shared.status, await shared.clone().text()).toBe(200);
    const token = await tokenFor(LEAD.id);
    expect(
      await jj<unknown>(await tag(LEAD.id, harborKey, { rank: 2, goal: tideGoal }, token)),
    ).toEqual({ key: harborKey, rank: 2, goal: tideGoal });
    const row = (await queue()).find((i) => i.key === harborKey);
    expect(row?.leadRank).toBe(2);
    expect(row?.goalTag).toBe(tideGoal);
    expect(headings(await landing())).toContain('Tide tables out 1');
  });

  it('clears a tag with null', async () => {
    const token = await tokenFor(LEAD.id);
    await jj(await tag(LEAD.id, harborKey, { goal: null }, token));
    expect(await tagOf(harborKey)).toBeUndefined();
  });
});
