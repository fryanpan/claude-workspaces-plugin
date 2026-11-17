/**
 * The stall pass reads threads without bringing a doc back into memory.
 *
 * It runs every ten minutes over every task body, every unfinished goal and
 * every board doc. Before this suite it loaded each one that had threads,
 * done tasks included, so a doc the idle sweep released after its thirty
 * minutes came back within ten and the resident count never fell. A cold doc
 * is now read from its `.ydoc` into a throwaway copy that is dropped once its
 * threads are taken, and a done task's body is not read at all.
 *
 * Two halves: the pass leaves the resident count where it found it, and a
 * cold row still gets the verdict a resident one would.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { STALL_EVENT } from '../src/stall-nudge.ts';
import { taskBodyDocId } from '../src/task-projection.ts';
import {
  type Frame,
  LEAD,
  QUIET_MS,
  listenFrames,
  settle,
  waitForFrames,
} from './doc-activity-stall-harness.ts';

const ALICE = { id: 'u-alice', name: 'Alice', kind: 'known', color: '#000' } as const;

function evictAll(h: ServerHandle): void {
  for (const meta of h.docStore.list()) h.docStore.evictDoc(meta.docId);
}

describe('one stall pass over cold docs loads none of them', () => {
  let dataDir: string;
  let handle: ServerHandle;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'stall-no-hydrate-'));
    handle = createServer({ port: 0, dataDir, requireSignInToWrite: false });
  });
  afterEach(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  /** N task bodies, each with a thread: half done, half still open. One
   *  done body's thread is resolved, the rest stay open; plus one board doc
   *  with an open thread. Returns every doc id the pass reads. */
  async function board(n: number): Promise<string[]> {
    const ws = handle.tasks.createWorkspace('Riverbend board').id;
    const docs: string[] = [];
    for (let i = 0; i < n; i++) {
      const created = handle.tasks.createTask(ws, {
        title: `Saltmarsh index ${i}`,
        body: `Agent can rebuild Saltmarsh index ${i} so that search stays fresh.`,
      });
      if (!created.ok) throw new Error('task not created');
      const bodyId = taskBodyDocId(created.task.id);
      const thread = await handle.docStore.createThreadByFind(
        bodyId,
        { find: `Saltmarsh index ${i}` },
        ALICE,
        'Which index?',
      );
      expect(thread.ok).toBe(true);
      if (i === 0 && thread.ok) handle.docStore.resolve(bodyId, thread.thread.id, ALICE);
      if (i % 2 === 0) {
        const done = handle.tasks.transition(created.task.id, 'done', {
          actor: { id: ALICE.id, name: ALICE.name, kind: 'person' },
        });
        expect(done.ok).toBe(true);
      }
      docs.push(bodyId);
    }
    handle.docStore.getOrCreate('harborlight-plan', { type: 'markdown', title: 'Plan' });
    expect(handle.docStore.setDocContent('harborlight-plan', '# Plan\n\nHarborlight\n').ok).toBe(
      true,
    );
    handle.tasks.attachDoc(ws, 'harborlight-plan');
    const docThread = await handle.docStore.createThreadByFind(
      'harborlight-plan',
      { find: 'Harborlight' },
      ALICE,
      'Ready?',
    );
    expect(docThread.ok).toBe(true);
    docs.push('harborlight-plan');
    return docs;
  }

  it('the timed pass and the untimed pass leave the resident count unchanged', async () => {
    const docs = await board(8);
    evictAll(handle);
    const before = handle.docStore.stats().residentDocs;
    expect(docs.every((id) => handle.docStore.peek(id) === undefined)).toBe(true);

    await handle.nudgeStallsTimed();
    handle.nudgeStalls();

    expect(docs.filter((id) => handle.docStore.peek(id) !== undefined)).toEqual([]);
    expect(handle.docStore.stats().residentDocs).toBe(before);
  });

  it('control: a hydrating threads read over the same docs does load them', async () => {
    const docs = await board(2);
    evictAll(handle);
    for (const id of docs) handle.docStore.listThreads(id);
    expect(docs.filter((id) => handle.docStore.peek(id) === undefined)).toEqual([]);
  });
});

describe('a cold row gets the verdict a resident one would', () => {
  let dataDir: string;
  let handle: ServerHandle;
  let base: string;

  const post = async (path: string, body: unknown): Promise<Record<string, unknown>> => {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(res.ok, `${res.status} ${await res.clone().text()}`).toBe(true);
    return (await res.json()) as Record<string, unknown>;
  };

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'stall-cold-verdict-'));
    handle = createServer({
      port: 0,
      dataDir,
      stallNudgeQuietMs: QUIET_MS,
      requireSignInToWrite: false,
    });
    base = `http://127.0.0.1:${handle.port}`;
  });
  afterEach(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function inProgressRow(ws: string, title: string): Promise<string> {
    const { task } = (await post(`/workspaces/${ws}/tasks`, {
      title,
      body: `Agent can ${title.toLowerCase()} so that the queue keeps moving.`,
      assignee: LEAD.name,
      assigneeId: LEAD.id,
      assigneeKind: 'agent',
      author: LEAD,
    })) as { task: { id: string } };
    for (const to of ['todo', 'in-progress']) {
      await post(`/workspaces/${ws}/tasks/${task.id}/transition`, {
        to,
        author: LEAD,
        workspaceId: ws,
      });
    }
    return task.id;
  }

  const namedRows = (frame: Frame | undefined): string[] =>
    ((frame?.data?.rows ?? []) as Array<{ id: string }>).map((r) => r.id);

  it("an ask on a cold row's own body still excuses it, and the body stays cold", async () => {
    const { workspace } = (await post('/workspaces', {
      name: 'Harborlight board',
      leadAgentId: LEAD.id,
    })) as { workspace: { id: string } };
    const ws = workspace.id;
    await post(`/workspaces/${ws}/agents`, { agentId: LEAD.id, runtime: 'claude-code-local' });
    const lead = listenFrames(
      await fetch(`${base}/workspaces/${ws}/events:stream?agentId=${encodeURIComponent(LEAD.id)}`, {
        headers: { accept: 'text/event-stream' },
      }),
    );

    const asked = await inProgressRow(ws, 'Rank Riverbend results');
    const askedBody = taskBodyDocId(asked);
    await post(`/workspaces/${ws}/docs/${encodeURIComponent(askedBody)}/threads`, {
      text: 'Does the ranking read the way you wanted?',
      author: LEAD,
      anchor: { kind: 'subject' },
      review: { shape: 'question', headline: 'Does the ranking read the way you wanted?' },
    });
    // The positive control: a row with nothing on it, named by the same pass.
    const free = await inProgressRow(ws, 'Cache the Saltmarsh facets');
    await settle(2 * QUIET_MS + 50);

    evictAll(handle);
    expect(handle.docStore.peek(askedBody)).toBeUndefined();
    handle.nudgeStalls();
    const got = await waitForFrames(lead.frames, STALL_EVENT, 1);

    expect(got).toHaveLength(1);
    expect(namedRows(got[0])).toEqual([free]);
    expect(handle.docStore.peek(askedBody)).toBeUndefined();
    await lead.stop();
  });
});
