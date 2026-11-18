/**
 * Home decodes a cold doc's `.ydoc` once while it is unchanged, not on every
 * load.
 *
 * `/` reads the threads of every live row on every board. Each read decoded
 * the row's whole `.ydoc` and threw it away, so every Home paid one decode
 * per threaded doc on the server — about 90% of `/`'s server time on a
 * synthetic 60-board, 2,400-doc corpus, and it grew with each doc's history.
 * The decoded threads are now kept (`cold-threads-cache.ts`) and forgotten
 * by the write that changes the doc's state. Every case counts decodes and
 * resident docs, never time; and every case boots a second server on the
 * first one's data, which is the state an idle sweep or a deploy leaves.
 *
 * Fixtures are invented; the repo is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { User } from '@claude-workspaces/core';
import type { CrossReviewQueue } from '../src/cross-review-queue.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { taskBodyDocId } from '../src/task-projection.ts';
import { waitFor } from './wait-for.ts';

const AGENT: User = {
  id: 'agent-harborlight',
  name: 'Harborlight Agent',
  kind: 'agent' as unknown as User['kind'],
  color: '#000',
};
const TITLES = ['chart the Saltmarsh tides', 'check the Harborlight buoy', 'map Riverbend'];

let dataDir: string;
let taskDocs: string[] = [];

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'home-cold-threads-'));
  const first = createServer({ port: 0, dataDir, spawnerAgentId: null, homeWarmMs: null });
  const ws = first.tasks.createWorkspace('Harborlight board').id;
  for (const title of TITLES) {
    const made = first.tasks.createTask(ws, { title, body: `Agent can ${title} so boats plan.` });
    if (!made.ok) throw new Error('task not created');
    const docId = taskBodyDocId(made.task.id);
    const t = await first.docStore.createThreadByFind(docId, { find: title }, AGENT, 'Alice?');
    if (!t.ok) throw new Error(`thread on ${docId}`);
    taskDocs.push(docId);
  }
  await first.stop();
});

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
  taskDocs = [];
});

const boot = (homeWarmMs: number | null) =>
  createServer({ port: 0, dataDir, spawnerAgentId: null, homeWarmMs });
const decodes = (h: ServerHandle) => h.docStore.stats().coldThreads.decodes;
const home = async (h: ServerHandle) => {
  const res = await fetch(`http://127.0.0.1:${h.port}/`);
  expect(res.status).toBe(200);
  await res.text();
};
const queue = async (h: ServerHandle): Promise<CrossReviewQueue> =>
  (await (await fetch(`http://127.0.0.1:${h.port}/api/review-queue`)).json()) as CrossReviewQueue;
const evictAll = (h: ServerHandle) => {
  for (const meta of h.docStore.list()) h.docStore.evictDoc(meta.docId);
};

describe("Home's cold threads", () => {
  it('a second Home decodes nothing, and loads nothing', async () => {
    const h = boot(null);
    try {
      evictAll(h);
      const resident = h.docStore.stats().residentDocs;
      const before = decodes(h);
      await home(h);
      const first = decodes(h) - before;
      // Control: the first Home does decode every threaded row it reads.
      expect(first).toBeGreaterThanOrEqual(taskDocs.length);
      await home(h);
      await home(h);
      expect(decodes(h) - before).toBe(first);
      expect(h.docStore.stats().residentDocs).toBe(resident);
      for (const id of taskDocs) expect(h.docStore.peek(id)).toBeUndefined();
    } finally {
      await h.stop();
    }
  });

  it('a doc whose threads changed is decoded again, and Home shows the change', async () => {
    const h = boot(null);
    try {
      evictAll(h);
      await home(h);
      const target = taskDocs[1] as string;
      const made = await h.docStore.createThreadByFind(
        target,
        { find: 'Harborlight buoy' },
        AGENT,
        'Bob, is the Harborlight buoy back?',
      );
      expect(made.ok).toBe(true);
      // The idle sweep's eviction is the write that puts the thread on disk.
      expect(h.docStore.evictDoc(target)).toBe(true);
      const before = decodes(h);
      const q = await queue(h);
      expect(decodes(h) - before).toBe(1);
      const texts = h.docStore.peekThreads(target).flatMap((t) => t.comments.map((c) => c.text));
      expect(texts).toContain('Bob, is the Harborlight buoy back?');
      expect(h.docStore.peek(target)).toBeUndefined();
      // And the answer is the one a read over the resident docs gives.
      for (const id of taskDocs) h.docStore.listThreads(id);
      expect(await queue(h)).toEqual(q);
    } finally {
      await h.stop();
    }
  });

  it('the boot warm decodes ahead, so the first Home after a deploy decodes nothing', async () => {
    const h = boot(0);
    try {
      await waitFor(() => decodes(h) >= taskDocs.length);
      const before = decodes(h);
      await home(h);
      expect(decodes(h)).toBe(before);
      for (const id of taskDocs) expect(h.docStore.peek(id)).toBeUndefined();
    } finally {
      await h.stop();
    }
  });
});
