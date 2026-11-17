/**
 * An agent marks a person's comment in progress, then done, and the thread
 * stays open until a person resolves it.
 *
 * Drives `POST …/threads/:threadId/progress` against a real server on port 0
 * and reads the thread back through the same REST payload `list_threads`
 * returns. All fixtures synthetic.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { User } from '@claude-workspaces/core';
import { type ServerHandle, createServer } from '../src/server.ts';
import { signedInPerson } from './signed-in-person.ts';
import { seedBoard } from './workspace-seed.ts';

const AGENT = { id: 'agent-harborlight', name: 'Harborlight site', kind: 'agent' };
let PERSON: User = { id: 'known-alice', name: 'Alice', kind: 'known', color: '#cb4d56' };
const signIns = new Map<string, Record<string, string>>();

type ThreadPayload = {
  id: string;
  status: string;
  progress?: { state: string; by: { id: string; name: string }; at: number };
};

describe('thread progress route', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let WS: string;
  let docId: string;

  const post = (path: string, body: unknown): Promise<Response> =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...signIns.get((body as { author?: User } | undefined)?.author?.id ?? ''),
      },
      body: JSON.stringify(body),
    });
  const jj = async <T>(res: Response): Promise<T> => {
    expect(res.ok, `${res.status} ${await res.clone().text()}`).toBe(true);
    return res.json() as Promise<T>;
  };
  const thread = async (id: string): Promise<ThreadPayload> =>
    (
      await jj<{ thread: ThreadPayload }>(
        await fetch(`${base}/workspaces/${WS}/docs/${docId}/threads/${id}`),
      )
    ).thread;
  const mark = (id: string, state: unknown, author: unknown = AGENT) =>
    post(`/workspaces/${WS}/docs/${docId}/threads/${id}/progress`, { state, author });

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'thread-progress-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://127.0.0.1:${handle.port}`;
    WS = await seedBoard(base);
    const signed = signedInPerson(handle, dataDir, base, { name: 'Alice' });
    PERSON = signed.user;
    signIns.set(PERSON.id, signed.headers);
    const file = join(dataDir, 'berths.md');
    writeFileSync(file, '# Harborlight berths\n\nRiverbend opens at nine.\n');
    docId = (
      await jj<{ docId: string }>(
        await post(`/workspaces/${WS}/docs`, {
          docId: 'berths',
          type: 'markdown',
          sourceUrl: file,
        }),
      )
    ).docId;
  });

  afterEach(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function personComment(): Promise<string> {
    const r = await jj<{ thread: { id: string } }>(
      await post(`/workspaces/${WS}/docs/${docId}/threads/by_find`, {
        find: 'Riverbend opens at nine.',
        text: 'Should say 9:00.',
        author: PERSON,
      }),
    );
    return r.thread.id;
  }

  it('working then done, and the thread stays open with the agent named', async () => {
    const id = await personComment();
    expect((await thread(id)).progress).toBeUndefined();
    await jj(await mark(id, 'working'));
    let t = await thread(id);
    expect(t.progress?.state).toBe('working');
    expect(t.progress?.by.name).toBe('Harborlight site');
    await jj(await mark(id, 'done'));
    t = await thread(id);
    expect(t.progress?.state).toBe('done');
    expect(t.status).toBe('open');
  });

  it('the route answers with the thread carrying the mark', async () => {
    const id = await personComment();
    const r = await jj<{ thread: ThreadPayload }>(await mark(id, 'done'));
    expect(r.thread.progress?.state).toBe('done');
  });

  it("a person's reply on a done thread sends it back", async () => {
    const id = await personComment();
    await jj(await mark(id, 'done'));
    await jj(
      await post(`/workspaces/${WS}/docs/${docId}/threads/${id}/comments`, {
        text: 'Not quite, the hour is wrong.',
        author: PERSON,
      }),
    );
    expect((await thread(id)).progress).toBeUndefined();
  });

  it("an agent's own reply leaves the mark where it is", async () => {
    const id = await personComment();
    await jj(await mark(id, 'done'));
    await jj(
      await post(`/workspaces/${WS}/docs/${docId}/threads/${id}/comments`, {
        text: 'Changed it to 9:00.',
        author: AGENT,
      }),
    );
    expect((await thread(id)).progress?.state).toBe('done');
  });

  it('resolving clears the mark, so a reopened thread is not still done', async () => {
    const id = await personComment();
    await jj(await mark(id, 'done'));
    await jj(
      await post(`/workspaces/${WS}/docs/${docId}/threads/${id}/resolve`, { author: PERSON }),
    );
    await jj(
      await post(`/workspaces/${WS}/docs/${docId}/threads/${id}/reopen`, { author: PERSON }),
    );
    expect((await thread(id)).progress).toBeUndefined();
  });

  it('open clears the mark', async () => {
    const id = await personComment();
    await jj(await mark(id, 'working'));
    await jj(await mark(id, 'open'));
    expect((await thread(id)).progress).toBeUndefined();
  });

  it('refuses a state it does not know, an unknown thread, and a resolved thread', async () => {
    const id = await personComment();
    expect((await mark(id, 'finished')).status).toBe(400);
    expect((await mark(id, undefined)).status).toBe(400);
    expect((await mark('no-such-thread', 'done')).status).toBe(404);
    await jj(
      await post(`/workspaces/${WS}/docs/${docId}/threads/${id}/resolve`, { author: PERSON }),
    );
    expect((await mark(id, 'working')).status).toBe(409);
    expect((await thread(id)).progress).toBeUndefined();
  });

  it('refuses a request with no author', async () => {
    const id = await personComment();
    const res = await post(`/workspaces/${WS}/docs/${docId}/threads/${id}/progress`, {
      state: 'done',
    });
    expect(res.status).toBe(400);
  });
});
