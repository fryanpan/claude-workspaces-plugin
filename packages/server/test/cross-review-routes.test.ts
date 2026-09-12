/**
 * The cross-board queue and the answer ledger, through the real server: items
 * filed on two boards come back in one order, and answering one through a
 * board's own route — a ticket item, and a declared doc thread — records
 * where it stood.
 *
 * Fixtures are invented; the repo is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ReviewPayload, Thread } from '@claude-workspaces/core';
import type { CrossReviewQueue } from '../src/cross-review-queue.ts';
import type { BoardWait } from '../src/review-answer-ledger.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { waitFor } from './wait-for.ts';

const AGENT = { id: 'agent-tides', name: 'Tides Agent', kind: 'agent' };
const PERSON = { id: 'known-owner', name: 'Owner', kind: 'known', color: '#2e7dd7' };
const CHOICE: ReviewPayload = {
  shape: 'decision',
  headline: 'Which tide table goes on the front page?',
  detail: 'The harbour gauge is closer; the buoy is steadier.',
  options: [
    { id: 'gauge', label: 'Harbour gauge' },
    { id: 'buoy', label: 'Offshore buoy' },
  ],
};

let handle: ServerHandle;
let dataDir: string;
let base: string;

const post = (path: string, body: unknown) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
async function jj<T>(res: Response): Promise<T> {
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json()) as T;
}

async function board(name: string): Promise<string> {
  const { workspace } = await jj<{ workspace: { id: string } }>(
    await post('/workspaces', { name, author: AGENT }),
  );
  return workspace.id;
}

async function ticketItem(ws: string, title: string): Promise<{ taskId: string; itemId: string }> {
  const { task } = await jj<{ task: { id: string } }>(
    await post(`/workspaces/${ws}/tasks`, {
      title,
      body: 'Agent can publish tides so that sailors plan.',
      author: AGENT,
    }),
  );
  const { item } = await jj<{ item: { id: string } }>(
    await post(`/workspaces/${ws}/tasks/${task.id}/review-items`, {
      review: CHOICE,
      author: AGENT,
    }),
  );
  return { taskId: task.id, itemId: item.id };
}

const queue = async () => jj<CrossReviewQueue>(await fetch(`${base}/api/review-queue`));
const wait = async () =>
  (await jj<{ boards: BoardWait[] }>(await fetch(`${base}/api/review-wait`))).boards;

beforeAll(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'cross-review-routes-'));
  handle = createServer({ port: 0, dataDir, spawnerAgentId: null });
  base = `http://127.0.0.1:${handle.port}`;
});
afterAll(async () => {
  await handle.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('the cross-board review queue', () => {
  let river = '';
  let harbor = '';
  let riverItem = { taskId: '', itemId: '' };
  let harborItem = { taskId: '', itemId: '' };

  it('lists every board’s items, the most recently active project first', async () => {
    harbor = await board('Harborlight');
    harborItem = await ticketItem(harbor, 'Harbour tide table');
    river = await board('Riverbend');
    riverItem = await ticketItem(river, 'River level table');
    const q = await queue();
    const mine = q.items.filter((i) => i.workspaceId === river || i.workspaceId === harbor);
    expect(mine.map((i) => [i.project, i.taskId])).toEqual([
      ['Riverbend', riverItem.taskId],
      ['Harborlight', harborItem.taskId],
    ]);
    expect(mine.every((i) => i.size === 'easy' && i.minutes === 1)).toBe(true);
  });

  it('records an out-of-order ticket answer with what was still open above it', async () => {
    await jj(
      await post(
        `/workspaces/${harbor}/tasks/${harborItem.taskId}/review-items/${harborItem.itemId}/answer`,
        {
          text: 'Harbour gauge.',
          answeredWith: 'gauge',
          author: PERSON,
        },
      ),
    );
    const boards = await waitFor(async () => {
      const b = await wait();
      return b.some((x) => x.workspaceId === harbor) ? b : undefined;
    });
    const row = boards.find((x) => x.workspaceId === harbor);
    expect(row).toMatchObject({ name: 'Harborlight', answered: 1, inOrder: 0 });
  });

  it('records a declared doc-thread answer too, in order at the top', async () => {
    const file = join(dataDir, 'tide-notes.md');
    writeFileSync(file, '# Tide notes\n\nthe buoy reading lags by ten minutes\n');
    await jj(
      await post(`/workspaces/${river}/docs`, {
        docId: 'tide-notes',
        type: 'markdown',
        sourceUrl: file,
      }),
    );
    const { thread } = await jj<{ thread: Thread }>(
      await post(`/workspaces/${river}/docs/tide-notes/threads/by_find`, {
        author: AGENT,
        text: 'The lag needs a call.',
        find: 'buoy reading',
        review: CHOICE,
      }),
    );
    // Clear the ticket item first, so the doc thread is the top of the queue.
    await jj(
      await post(
        `/workspaces/${river}/tasks/${riverItem.taskId}/review-items/${riverItem.itemId}/answer`,
        {
          text: 'Offshore buoy.',
          answeredWith: 'buoy',
          author: PERSON,
        },
      ),
    );
    await waitFor(async () =>
      (await wait()).some((x) => x.workspaceId === river && x.answered === 1) ? true : undefined,
    );
    const commentId = thread.comments[0]?.id;
    await jj(
      await post(`/workspaces/${river}/docs/tide-notes/threads/${thread.id}/answer`, {
        text: 'Show the gauge.',
        commentId,
        optionId: 'gauge',
        author: PERSON,
      }),
    );
    const boards = await waitFor(async () => {
      const b = await wait();
      return b.some((x) => x.workspaceId === river && x.answered === 2) ? b : undefined;
    });
    expect(boards.find((x) => x.workspaceId === river)).toMatchObject({
      answered: 2,
      inOrder: 1,
    });
  });

  it('refuses a since that is not epoch milliseconds', async () => {
    expect((await fetch(`${base}/api/review-wait?since=yesterday`)).status).toBe(400);
    expect((await fetch(`${base}/api/review-wait?since=-5`)).status).toBe(400);
  });
});
