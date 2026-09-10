/**
 * The refetch that makes the closed-row trim lossless.
 *
 * The board's ydoc carries a closed row without its body, its notes, its
 * review items, its original words or the prose on its transitions — that is
 * what takes a board's sync from megabytes to hundreds of kilobytes. It is
 * only safe because the panel can ask for the rest, so what these drive is
 * that the ask ANSWERS: the same projected row, whole, for a row the board
 * itself sent out short.
 *
 * The negative half matters as much: a row belonging to another board is not
 * readable through this board's address. Both directions are asserted, since
 * a route that answered everything would pass a test that only ever asked for
 * a row it owned.
 *
 * All fixtures are synthetic — invented names in the jordan@partner.example
 * register. The repo is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleTaskDetail } from '../src/routes/task-detail.ts';
import type { TaskRouteRequest, TaskRoutesContext } from '../src/routes/task-routes-context.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { workspaceDocId } from '../src/task-projection.ts';
import { DETAIL_FRESH_MS } from '../src/task-row-slim.ts';
import { seedBoard } from './workspace-seed.ts';

const PERSON = { id: 'known-bryan', name: 'Bryan', kind: 'known', color: '#2e7dd7' };
const BODY = 'Bryan can reopen a closed row so that the whole ticket is still there.';

describe('GET /workspaces/:ws/tasks/:taskId/detail', () => {
  let dataDir: string;
  let handle: ServerHandle;
  let base: string;
  let ws = '';
  let otherWs = '';
  let taskId = '';

  const local = (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: {
        host: `localhost:${handle.port}`,
        ...((init.headers as Record<string, string>) ?? {}),
      },
    });
  const post = (path: string, body: unknown) =>
    local(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const detail = async (
    board: string,
    id: string,
  ): Promise<{ status: number; task?: Record<string, unknown> }> => {
    const r = await local(`/workspaces/${board}/tasks/${id}/detail`);
    if (!r.ok) return { status: r.status };
    const body = (await r.json()) as { task: Record<string, unknown> };
    return { status: r.status, task: body.task };
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'task-detail-route-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
    ws = await seedBoard(base, { name: 'harbor-relay' });
    otherWs = await seedBoard(base, { name: 'tide-table' });
    const created = await post(`/workspaces/${ws}/tasks`, {
      author: PERSON,
      title: 'Bryan can read a closed row',
      body: BODY,
    });
    taskId = ((await created.json()) as { task: { id: string } }).task.id;
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('answers with the projected row, body included', async () => {
    const { status, task } = await detail(ws, taskId);
    expect(status).toBe(200);
    expect(task?.id).toBe(taskId);
    expect(task?.body).toBe(BODY);
    // The whole row, not a body endpoint: the four other trimmed fields have
    // their keys projected on the same object when the row carries them, and
    // the trail is the un-narrowed one.
    expect(Array.isArray(task?.transitions)).toBe(true);
    expect(task?.bodyDocId).toBe(`task:${taskId}`);
  });

  it('never carries the trim marker — this is the whole row by definition', async () => {
    // `detailTrimmed` is what the client keys its refetch on. An answer
    // carrying it would make the panel ask again forever.
    expect((await detail(ws, taskId)).task?.detailTrimmed).toBeUndefined();
  });

  it('refuses a row that belongs to another board', async () => {
    // Through the whole stack. The refusal here is the workspace-scope
    // middleware's — it resolves the board above every handler and answers
    // 404 for a row filed elsewhere, which is why the body reads
    // `not-found` rather than the handler's own words. The handler's OWN
    // check is driven directly below, because a test that only came this way
    // would keep passing with that check deleted.
    const res = await local(`/workspaces/${otherWs}/tasks/${taskId}/detail`);
    expect(res.status).toBe(404);
  });

  it('refuses it in the handler too, with the middleware out of the way', async () => {
    // Defence in depth, and the only way to exercise it is to call the
    // handler with a scope naming a board the row is not on — exactly the
    // state a future route chain could hand it.
    const ctx = {
      taskStore: handle.tasks,
      taskProjection: handle.projection,
      j: (status: number, body: unknown) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
    } as unknown as TaskRoutesContext;
    const call = (board: string) =>
      handleTaskDetail(ctx, {
        req: new Request(`http://localhost/workspaces/${board}/tasks/${taskId}/detail`),
        pathname: `/workspaces/${board}/tasks/${taskId}/detail`,
        scope: { workspaceId: board },
      } as unknown as TaskRouteRequest);
    // Positive control: the same call for the row's OWN board answers.
    expect((await call(ws))?.status).toBe(200);
    expect((await call(otherWs))?.status).toBe(404);
  });

  it('refuses an id that is not a task', async () => {
    expect((await detail(ws, 't-missing')).status).toBe(404);
  });

  /** The row as the BOARD receives it — out of the ws doc's tasks map, which
   *  is what sync-step-2 encodes. */
  const projectedRow = (id: string): Record<string, unknown> => {
    const doc = handle.docStore.get(workspaceDocId(ws));
    if (!doc) throw new Error('ws doc was not created');
    return doc.ydoc.getMap('tasks').get(id) as Record<string, unknown>;
  };

  it('is what a reader needs, because the board itself sends closed rows short', async () => {
    // The wiring half: `slimClosedRow` is unit-tested next door, but nothing
    // there says the PROJECTION applies it. Drive a real row all the way to
    // done, age it past the fresh window, and read the map the socket encodes.
    await post(`/workspaces/${ws}/tasks/${taskId}/transition`, { author: PERSON, to: 'done' });
    const stored = handle.tasks.getTask(taskId);
    if (!stored) throw new Error('task went missing');
    // Positive control on the fixture: a row still inside the fresh window
    // rides out whole, so the assertion below would pass either way without
    // this backdate actually taking effect.
    handle.projection.refresh(ws);
    expect(projectedRow(taskId).body).toBe(BODY);
    stored.updatedAt = Date.now() - DETAIL_FRESH_MS * 2;
    handle.projection.refresh(ws);

    const onTheWire = projectedRow(taskId);
    expect(onTheWire.detailTrimmed).toBe(true);
    expect(onTheWire.body).toBeUndefined();
    expect(onTheWire.title).toBe('Bryan can read a closed row');

    // …and the route hands the reader back exactly what the wire dropped.
    const { task } = await detail(ws, taskId);
    expect(task?.body).toBe(BODY);
  });
});
