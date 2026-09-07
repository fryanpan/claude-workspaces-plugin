/**
 * An archived goal, as an agent READS it back and tries to reorder around it
 * (`summarizeGoals` in `task-queue.ts`, `reorderGoals` in `task-goals.ts`).
 *
 * A retired peer reported that an archived goal still came back from
 * `get_workspace` as a live band — `status: "todo"`, `reorderable: true`, no
 * archived marker — and that `reorder_goals` then demanded it in the
 * permutation. Reproduced here with a control: the first test is the
 * pre-fix shape, kept as the assertion of what an archived band must NOT
 * look like, beside the live band that must. Fixtures are invented; the
 * repo is public.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { summarizeGoals } from '../src/task-queue.ts';
import { TaskStore } from '../src/tasks.ts';
import { seedGoals, seedGoalsOverHttp } from './goal-seed.ts';

const PERSON = { id: 'known-harbour', name: 'Harbourmaster', kind: 'known' };

describe('an archived goal, read back and reordered around', () => {
  let dataDir: string;
  let store: TaskStore;
  let wsId: string;
  let G: Record<string, string>;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'goal-archive-read-'));
    store = new TaskStore({ dataDir, debounceMs: 5 });
    const ws = store.createWorkspace('Harbour Lights');
    wsId = ws.id;
    G = seedGoals(
      store,
      wsId,
      [
        { key: 'lamps', title: '1. Keep the lamps lit' },
        { key: 'moor', title: '2. Mend the moorings' },
        { key: 'chart', title: '3. Redraw the chart' },
      ],
      PERSON,
    );
    const archived = store.archiveGoal(G.moor ?? '', { actor: PERSON, reason: 'moved ashore' });
    if (!archived.ok) throw new Error('archive refused');
  });

  afterEach(() => {
    store.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const rows = () =>
    summarizeGoals(
      store.listTasks(wsId),
      store.getWorkspace(wsId)?.goals ?? [],
      store.listGoalRows(wsId),
    );

  it('marks the archived band with archivedAt, archivedBy and archiveReason, and not reorderable', () => {
    const moor = rows().find((r) => r.id === G.moor);
    expect(moor).toBeDefined(); // it is still listed: retired, not vanished
    expect(moor).toMatchObject({
      reorderable: false,
      archivedBy: PERSON.name,
      archiveReason: 'moved ashore',
    });
    expect(typeof moor?.archivedAt).toBe('number');
    // The control: the live bands beside it carry none of that and stay reorderable.
    const lamps = rows().find((r) => r.id === G.lamps);
    expect(lamps?.reorderable).toBe(true);
    expect(lamps?.archivedAt).toBeUndefined();
    expect(lamps?.status).toBe('todo');
  });

  it('accepts a permutation of the live goals only, and refuses the archived id by name', () => {
    const live = store.reorderGoals(wsId, [G.chart ?? '', G.lamps ?? ''], { actor: PERSON });
    expect(live.ok).toBe(true);
    if (live.ok) expect(live.order).toEqual([G.chart, G.lamps]);
    // The archived band kept its slot, so a restore puts it back where it was.
    expect((store.getWorkspace(wsId)?.goals ?? []).map((g) => g.id)).toEqual([
      G.chart,
      G.moor,
      G.lamps,
    ]);
    const withArchived = store.reorderGoals(wsId, [G.lamps ?? '', G.moor ?? '', G.chart ?? ''], {
      actor: PERSON,
    });
    expect(withArchived.ok).toBe(false);
    if (!withArchived.ok && withArchived.error === 'order-mismatch') {
      expect(withArchived.archivedIds).toEqual([G.moor]);
      expect(withArchived.unknownIds).toEqual([]);
      expect(withArchived.missingIds).toEqual([]);
    } else throw new Error(`expected order-mismatch, got ${JSON.stringify(withArchived)}`);
    // Unchanged by the refusal.
    expect((store.getWorkspace(wsId)?.goals ?? []).map((g) => g.id)).toEqual([
      G.chart,
      G.moor,
      G.lamps,
    ]);
  });
});

describe('over HTTP — what get_workspace and reorder_goals actually return', () => {
  let dataDir: string;
  let handle: ServerHandle;
  let base: string;
  let wsId: string;
  let G: Record<string, string>;

  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  type Row = { id: string; reorderable: boolean; status?: string; archivedAt?: number };
  const summary = async (): Promise<Row[]> =>
    (
      (await (await fetch(`${base}/workspaces/${wsId}?format=json`)).json()) as {
        goalSummary: Row[];
      }
    ).goalSummary;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'goal-archive-read-http-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
    const { workspace } = (await (
      await post('/workspaces', { name: 'Harbour Lights', goal: 'Keep the lamps lit.' })
    ).json()) as { workspace: { id: string } };
    wsId = workspace.id;
    G = await seedGoalsOverHttp(
      base,
      wsId,
      [
        { key: 'lamps', title: '1. Keep the lamps lit' },
        { key: 'moor', title: '2. Mend the moorings' },
      ],
      PERSON,
    );
    const res = await post(`/workspaces/${wsId}/goals/${G.moor}/archive`, {
      author: PERSON,
      reason: 'moved ashore',
    });
    if (!res.ok) throw new Error(`archive refused: ${res.status}`);
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('reads the archived band back marked, and a reorder of the live band alone succeeds', async () => {
    const rows = await summary();
    expect(rows.find((r) => r.id === G.moor)).toMatchObject({ reorderable: false });
    expect(typeof rows.find((r) => r.id === G.moor)?.archivedAt).toBe('number');
    expect(rows.find((r) => r.id === G.lamps)).toMatchObject({ reorderable: true, status: 'todo' });
    // Send back exactly the reorderable rows, as the tool's own advice says.
    const ok = await post(`/workspaces/${wsId}/goals/reorder`, {
      order: rows.filter((r) => r.reorderable).map((r) => r.id),
      author: PERSON,
    });
    expect(ok.status).toBe(200);
    const bad = await post(`/workspaces/${wsId}/goals/reorder`, {
      order: [G.moor, G.lamps],
      author: PERSON,
    });
    expect(bad.status).toBe(400);
    const body = (await bad.json()) as { archivedIds: string[]; message: string };
    expect(body.archivedIds).toEqual([G.moor]);
    expect(body.message).toContain('archived');
  });
});
