/**
 * The cross-board review queue reads its cold docs' threads without loading
 * them.
 *
 * The queue reads every thread on every live board in one pass: `/`, the
 * review page's `/api/review-queue`, the home feed, and the answer ledger
 * after every answer. It used to load every cold doc it read ahead of that
 * pass, which kept ~2,000 docs resident for good on prod: Home is read far
 * more often than the thirty-minute residency window lets a doc go. Each case
 * here releases every doc, reads, and asserts the resident count did not
 * move, and that the answer is the one a read over resident docs gives. The
 * control shows the count does see a hydrating read.
 *
 * Fixtures are invented; the repo is public.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ReviewPayload, User } from '@claude-workspaces/core';
import type { CrossReviewQueue } from '../src/cross-review-queue.ts';
import type { AnswerRecord } from '../src/review-answer-ledger.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { taskBodyDocId } from '../src/task-projection.ts';
import { signedInPerson } from './signed-in-person.ts';
import { waitFor } from './wait-for.ts';

const AGENT: User = {
  id: 'agent-harborlight',
  name: 'Harborlight Agent',
  kind: 'agent' as unknown as User['kind'],
  color: '#000',
};
const PERSON = { id: 'known-riverbend', name: 'Riverbend', kind: 'known', color: '#000' } as const;
const CHOICE: ReviewPayload = {
  shape: 'decision',
  headline: 'Which Saltmarsh gauge goes on the front page?',
  detail: 'The harbour gauge is closer; the buoy is steadier.',
  options: [
    { id: 'gauge', label: 'Harbour gauge' },
    { id: 'buoy', label: 'Offshore buoy' },
  ],
};

interface Fixture {
  live: string;
  itemTask: string;
  itemId: string;
  /** The board doc's thread, whose newest word is an agent's direct ask. */
  askThread: string;
  /** Every doc the fixture put a thread on, by what reads it. */
  threaded: {
    openTask: string;
    resolvedTask: string;
    archivedTask: string;
    boardDoc: string;
    goal: string;
    retiredTask: string;
  };
}

let dataDir: string;
let handle: ServerHandle | null = null;
let base: string;

async function thread(h: ServerHandle, docId: string, find: string, text: string) {
  const made = await h.docStore.createThreadByFind(docId, { find }, AGENT, text);
  if (!made.ok) throw new Error(`thread on ${docId}: ${made.error}`);
  return made.thread;
}

/**
 * One live board and one retired one, written by a first server and read by
 * a second, with a thread on every kind of doc the queue or the landing page
 * reads: an open task, a task whose only thread is resolved (the roster reads
 * it), an archived task and a task on the retired board (which only the
 * landing page's activity reading dates, from their index rows), a board doc,
 * and a goal.
 */
async function seed(): Promise<Fixture> {
  const first = createServer({ port: 0, dataDir, spawnerAgentId: null });
  const t = first.tasks;
  const live = t.createWorkspace('Harborlight board').id;
  const retired = t.createWorkspace('Riverbend board').id;
  const task = (ws: string, title: string) => {
    const made = t.createTask(ws, { title, body: `Agent can ${title} so that sailors plan.` });
    if (!made.ok) throw new Error('task not created');
    return made.task.id;
  };
  const openTask = task(live, 'publish the Saltmarsh tides');
  const resolvedTask = task(live, 'check the Harborlight buoy');
  const archivedTask = task(live, 'retire the Riverbend gauge');
  const itemTask = task(live, 'choose the Saltmarsh gauge');
  const retiredTask = task(retired, 'map the Riverbend shoals');

  await thread(first, taskBodyDocId(openTask), 'Saltmarsh tides', 'Riverbend, which table?');
  const done = await thread(first, taskBodyDocId(resolvedTask), 'Harborlight buoy', 'Checked.');
  await first.docStore.postComment(taskBodyDocId(resolvedTask), done.id, PERSON, 'Thanks.');
  first.docStore.resolve(taskBodyDocId(resolvedTask), done.id, PERSON);
  await thread(first, taskBodyDocId(archivedTask), 'Riverbend gauge', 'Is it gone?');
  await thread(first, taskBodyDocId(retiredTask), 'Riverbend shoals', 'Charted?');
  const boardDoc = 'harborlight-notes';
  first.docStore.getOrCreate(boardDoc, { type: 'markdown', title: 'Harborlight notes' });
  expect(first.docStore.setDocContent(boardDoc, '# Notes\n\nSaltmarsh plan\n').ok).toBe(true);
  t.attachDoc(live, boardDoc);
  const ask = await thread(first, boardDoc, 'Saltmarsh plan', 'Riverbend, ready to publish?');

  const band = t.addGoal(live, { title: 'Harborlight tides' }, { actor: AGENT });
  if (!band.ok) throw new Error('goal not added');
  const goal = taskBodyDocId(band.goal.id);
  expect(first.docStore.setDocContent(goal, 'Ten Saltmarsh boats plan by the tides.\n').ok).toBe(
    true,
  );
  await thread(first, goal, 'Saltmarsh boats', 'Does ten count the ferries?');

  const item = t.addReviewItem(itemTask, CHOICE, { actor: AGENT });
  if (!item.ok) throw new Error('review item not added');
  expect(t.archiveTask(archivedTask, { actor: AGENT }).ok).toBe(true);
  expect(t.setWorkspaceRetired(retired, true, { actor: AGENT }).ok).toBe(true);
  await first.stop();
  return {
    live,
    itemTask,
    itemId: item.item.id,
    askThread: ask.id,
    threaded: {
      openTask: taskBodyDocId(openTask),
      resolvedTask: taskBodyDocId(resolvedTask),
      archivedTask: taskBodyDocId(archivedTask),
      boardDoc,
      goal,
      retiredTask: taskBodyDocId(retiredTask),
    },
  };
}

function evictAll(h: ServerHandle): void {
  for (const meta of h.docStore.list()) h.docStore.evictDoc(meta.docId);
}

const queue = async (): Promise<CrossReviewQueue> => {
  const res = await fetch(`${base}/api/review-queue`);
  expect(res.status).toBe(200);
  return (await res.json()) as CrossReviewQueue;
};

describe('the cross-board queue reads its docs without loading them', () => {
  let fx: Fixture;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'cross-review-cold-'));
    fx = await seed();
    handle = createServer({ port: 0, dataDir, spawnerAgentId: null });
    base = `http://127.0.0.1:${handle.port}`;
  });
  afterEach(async () => {
    await handle?.stop();
    handle = null;
    rmSync(dataDir, { recursive: true, force: true });
  });

  const resident = (h: ServerHandle) => h.docStore.stats().residentDocs;
  const queueDocs = () => [
    fx.threaded.openTask,
    fx.threaded.resolvedTask,
    fx.threaded.boardDoc,
    fx.threaded.goal,
  ];
  /** Every doc the fixture threaded that is in memory now. */
  const loaded = (h: ServerHandle) =>
    Object.values(fx.threaded).filter((id) => h.docStore.peek(id) !== undefined);

  it('control: a hydrating threads read over the same docs moves the resident count', () => {
    const h = handle as ServerHandle;
    evictAll(h);
    const before = resident(h);
    for (const id of queueDocs()) h.docStore.listThreads(id);
    expect(resident(h)).toBe(before + queueDocs().length);
  });

  it('/api/review-queue loads nothing, and answers what a read over resident docs answers', async () => {
    const h = handle as ServerHandle;
    evictAll(h);
    const before = resident(h);
    const cold = await queue();
    expect(loaded(h)).toEqual([]);
    expect(resident(h)).toBe(before);
    const asks = cold.items.map((i) => ('ask' in i ? i.ask : ''));
    expect(asks).toContain(CHOICE.headline);
    expect(asks).toContain('Riverbend, ready to publish?');
    expect(asks).toContain('Riverbend, which table?');
    // The same state with every doc the queue reads in memory: the same answer.
    for (const id of queueDocs()) h.docStore.listThreads(id);
    expect(queueDocs().every((id) => h.docStore.peek(id) !== undefined)).toBe(true);
    expect(await queue()).toEqual(cold);
  });

  it("a board's own review items load nothing either", async () => {
    const h = handle as ServerHandle;
    evictAll(h);
    const before = resident(h);
    const res = await fetch(`${base}/workspaces/${fx.live}/review-items?user=Riverbend`);
    expect(res.status).toBe(200);
    expect(loaded(h)).toEqual([]);
    expect(resident(h)).toBe(before);
  });

  it('/ loads nothing, and still counts what waits', async () => {
    const h = handle as ServerHandle;
    evictAll(h);
    const before = resident(h);
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Harborlight board, 3 waiting');
    expect(loaded(h)).toEqual([]);
    expect(resident(h)).toBe(before);
  });

  it('the answer ledger leaves the board doc unloaded, and still records the answer', async () => {
    const h = handle as ServerHandle;
    // Riverbend answers from her own signed-in page, as a person's answer must.
    const riverbend = signedInPerson(h, dataDir, base, {
      email: 'riverbend@harborlight.example',
      name: 'Riverbend',
    });
    evictAll(h);
    const res = await fetch(
      `${base}/workspaces/${fx.live}/tasks/${fx.itemTask}/review-items/${fx.itemId}/answer`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...riverbend.headers },
        body: JSON.stringify({
          text: 'Harbour gauge',
          answeredWith: 'gauge',
          author: riverbend.user,
        }),
      },
    );
    expect(res.status).toBe(200);
    const answers = await waitFor(async () => {
      const wait = await fetch(`${base}/api/review-wait?since=0`);
      const body = (await wait.json()) as { answers: AnswerRecord[] };
      return body.answers.length > 0 ? body.answers : null;
    });
    expect(answers.map((a) => a.key)).toEqual([`task-review:${fx.itemTask}:${fx.itemId}`]);
    // The board's projection, rebuilt from cold by the answer's task event,
    // re-creates every task and goal body itself; that is its cost, not the
    // ledger's. The board doc is read only by the queue, so it stays out.
    expect(h.docStore.peek(fx.threaded.boardDoc)).toBeUndefined();
  });

  it('a reply that retires an ask loads only the doc it was posted on, and is recorded', async () => {
    const h = handle as ServerHandle;
    evictAll(h);
    await h.docStore.postComment(fx.threaded.boardDoc, fx.askThread, PERSON, 'Yes, publish.');
    const answers = await waitFor(async () => {
      const wait = await fetch(`${base}/api/review-wait?since=0`);
      const body = (await wait.json()) as { answers: AnswerRecord[] };
      return body.answers.length > 0 ? body.answers : null;
    });
    expect(answers.map((a) => a.key)).toEqual([
      `doc-thread:${fx.threaded.boardDoc}:${fx.askThread}`,
    ]);
    // The reply itself brought the board doc in; the board walk the
    // comment-posted handler does, and the ledger read after it, brought
    // nothing else.
    expect(loaded(h)).toEqual([fx.threaded.boardDoc]);
  });
});
