/**
 * Opening a board, and the reads its page makes, leave cold docs cold.
 *
 * After the stall pass and the Home queue stopped loading docs, prod still
 * went from ~2,400 to 5,000-6,000 resident docs in the five minutes after
 * somebody opened a board. The loaders, found by the `loaded=` field of the
 * `[doc-store] mem` line (doc-load-sites.ts):
 *
 *   - the board projection, which re-armed every task body whenever the
 *     board doc came back into memory, loading each one, and then read each
 *     row's comment count through `get`, which loads and binds;
 *   - the review sizer, which counted a linked doc's words through
 *     `getDocStatus`, a full load;
 *   - `links:titles`, which read each linked doc's asks through
 *     `listThreads`, a load.
 *
 * Each case releases every doc, drives the real path, asserts the docs it
 * read are still out of memory, and asserts the answer is the one the same
 * read gives over resident docs. The control shows the count sees a load.
 *
 * Fixtures are invented; the repo is public.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ReviewPayload, User } from '@claude-workspaces/core';
import { type ServerHandle, createServer } from '../src/server.ts';
import { taskBodyDocId, workspaceDocId } from '../src/task-projection.ts';
import { waitFor } from './wait-for.ts';

const AGENT: User = {
  id: 'agent-harborlight',
  name: 'Harborlight Agent',
  kind: 'agent' as unknown as User['kind'],
  color: '#000',
};
const PERSON: User = { id: 'known-riverbend', name: 'Riverbend', kind: 'known', color: '#000' };
const ASK: ReviewPayload = {
  shape: 'review',
  headline: 'Is the Saltmarsh timetable right?',
  detail: 'The ferry stop moved.',
};
/** Docs on the board, each with a thread; the first holds a declared ask. */
const DOCS = ['harborlight-tides', 'riverbend-ferry', 'saltmarsh-moorings', 'harborlight-buoys'];

interface Fixture {
  ws: string;
  /** Task ids, and the comments each one's discussion holds. */
  comments: Map<string, number>;
}

let dataDir: string;
let handle: ServerHandle;
let base: string;
let fx: Fixture;

async function seed(): Promise<Fixture> {
  const first = createServer({ port: 0, dataDir, spawnerAgentId: null });
  const t = first.tasks;
  const ws = t.createWorkspace('Harborlight board').id;
  const comments = new Map<string, number>();
  for (let i = 0; i < 6; i++) {
    const made = t.createTask(ws, {
      title: `chart tide ${i}`,
      body: `Agent can chart tide ${i} so that sailors plan.`,
    });
    if (!made.ok) throw new Error('task not created');
    const id = made.task.id;
    // Two comments on the even tasks, none on the odd ones.
    if (i % 2 === 0) {
      const body = taskBodyDocId(id);
      const made2 = await first.docStore.createThreadByFind(
        body,
        { find: `tide ${i}` },
        AGENT,
        'Which gauge?',
      );
      if (!made2.ok) throw new Error(made2.error);
      await first.docStore.postComment(body, made2.thread.id, PERSON, 'The buoy.');
    }
    comments.set(id, i % 2 === 0 ? 2 : 0);
  }
  for (const [i, docId] of DOCS.entries()) {
    first.docStore.getOrCreate(docId, { type: 'markdown', title: docId });
    const text = `# ${docId}\n\nSaltmarsh plan ${i} with enough words to count for a size.\n`;
    expect(first.docStore.setDocContent(docId, text).ok).toBe(true);
    expect(t.attachDoc(ws, docId).ok).toBe(true);
    const made = await first.docStore.createThreadByFind(
      docId,
      { find: `Saltmarsh plan ${i}` },
      AGENT,
      'Ready?',
      i === 0 ? { review: ASK } : undefined,
    );
    if (!made.ok) throw new Error(made.error);
  }
  // A ticket item whose detail links two of the board's docs: the sizer
  // counts their words.
  const [firstTask] = [...comments.keys()];
  const item = t.addReviewItem(
    firstTask as string,
    {
      shape: 'review',
      headline: 'Read both plans',
      detail: `See /workspaces/${ws}/docs/${DOCS[1]} and /workspaces/${ws}/docs/${DOCS[2]}`,
    },
    { actor: AGENT },
  );
  if (!item.ok) throw new Error('review item not added');
  first.docStore.flush();
  await first.stop();
  return { ws, comments };
}

function evictAll(h: ServerHandle): void {
  for (const meta of h.docStore.list()) h.docStore.evictDoc(meta.docId);
}

const resident = (h: ServerHandle) => h.docStore.stats().residentDocs;
const bodies = () => [...fx.comments.keys()].map(taskBodyDocId);
const inMemory = (ids: string[]) => ids.filter((id) => handle.docStore.peek(id) !== undefined);

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'board-cold-'));
  fx = await seed();
  handle = createServer({ port: 0, dataDir, spawnerAgentId: null });
  base = `http://127.0.0.1:${handle.port}`;
});
afterEach(async () => {
  await handle.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('the board reads its cold docs without loading them', () => {
  it('control: a hydrating read over the same docs moves the resident count', () => {
    evictAll(handle);
    const before = resident(handle);
    // Only the bodies with a thread: a cold doc whose index row says it has
    // none answers empty without loading.
    const threaded = [...fx.comments].filter(([, n]) => n > 0).map(([id]) => taskBodyDocId(id));
    for (const id of [...threaded, ...DOCS]) handle.docStore.listThreads(id);
    expect(resident(handle)).toBe(before + threaded.length + DOCS.length);
  });

  it('a task moving on a cold board loads the board doc and no task body, and counts comments the same', () => {
    evictAll(handle);
    const before = resident(handle);
    const moved = handle.tasks.transition([...fx.comments.keys()][1] as string, 'in-progress', {
      actor: AGENT,
    });
    expect(moved.ok).toBe(true);
    expect(inMemory(bodies())).toEqual([]);
    // The board doc itself is the one doc the projection has to write.
    expect(resident(handle)).toBe(before + 1);
    const rows = handle.docStore.peek(workspaceDocId(fx.ws))?.ydoc.getMap('tasks');
    for (const [id, n] of fx.comments) {
      const row = rows?.get(id) as { commentCount?: number } | undefined;
      expect(row?.commentCount ?? 0).toBe(n);
    }
  });

  it('a body loaded after the board went cold still writes its edits back to the row', async () => {
    evictAll(handle);
    const [id] = [...fx.comments.keys()];
    expect(handle.tasks.transition(id as string, 'in-progress', { actor: AGENT }).ok).toBe(true);
    expect(handle.docStore.peek(taskBodyDocId(id as string))).toBeUndefined();
    // An editor opens the cold body and rewrites it.
    expect(
      handle.docStore.setDocContent(taskBodyDocId(id as string), 'Agent can moor at Riverbend.').ok,
    ).toBe(true);
    await waitFor(() =>
      handle.tasks.getTask(id as string)?.body?.includes('moor at Riverbend') ? true : null,
    );
  });

  it("a board's review items size their linked docs without loading them", async () => {
    const read = async () => {
      const res = await fetch(`${base}/workspaces/${fx.ws}/review-items?user=Riverbend`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        items: Array<{ ask?: string; minutes: number; size: string }>;
      };
      return body.items;
    };
    // Warm read first, every linked doc resident, for the answer to match.
    for (const id of DOCS) handle.docStore.getForRead(id);
    const warm = await read();
    expect(warm.some((r) => r.ask === 'Read both plans')).toBe(true);
    // The sizer remembers a count for ten minutes; a fresh server forgets it.
    await handle.stop();
    handle = createServer({ port: 0, dataDir, spawnerAgentId: null });
    base = `http://127.0.0.1:${handle.port}`;
    evictAll(handle);
    const cold = await read();
    expect(inMemory(DOCS)).toEqual([]);
    expect(cold).toEqual(warm);
  });

  it('links:titles reads the needs-review mark of each doc without loading it', async () => {
    const urls = DOCS.map((id) => `${base}/workspaces/${fx.ws}/docs/${id}`);
    const titles = async () => {
      const res = await fetch(`${base}/workspaces/${fx.ws}/links:titles`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', host: `localhost:${handle.port}` },
        body: JSON.stringify({ urls }),
      });
      expect(res.status).toBe(200);
      return (await res.json()) as { needsReview: Record<string, boolean> };
    };
    evictAll(handle);
    const cold = await titles();
    expect(inMemory(DOCS)).toEqual([]);
    // The declared ask on the first doc is still seen, and so are the two
    // docs the ticket item links.
    expect(cold.needsReview).toEqual({
      [urls[0] as string]: true,
      [urls[1] as string]: true,
      [urls[2] as string]: true,
    });
    for (const id of DOCS) handle.docStore.getForRead(id);
    expect(await titles()).toEqual(cold);
  });
});
