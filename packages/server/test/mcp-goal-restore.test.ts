/**
 * Restoring an archived GOAL through `unarchive_task`, end to end: the
 * SHIPPED BUNDLE over stdio, against a real server.
 *
 * Before this, a goal's restore had a route and a board button but no tool,
 * so undoing a goal archive needed a person's hands. The store's half
 * (`unarchiveGoal`, exact by `archivedWithGoal`) is covered in
 * `goal-archive.test.ts`; what this file proves is that an agent reaches it:
 * the goal id goes on the wire to the goal route, and the answer names the
 * tasks that came back.
 *
 * The three things a restore must get right, each asserted on the store the
 * route wrote: every task the archive took is back under its band, each one
 * keeps the status it had (open and done both), and a task somebody archived
 * on its own BEFORE the goal went stays archived.
 *
 * Fixtures are synthetic. The repo is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { seedGoals } from './goal-seed.ts';

const BUNDLE = resolve(import.meta.dir, '../../plugin/mcp/index.js');
const PERSON = { id: 'known-harbour', name: 'Harbourmaster', kind: 'known' };

/** The env keys that name a session; the parent's must not reach the child. */
const IDENTITY_KEYS = new Set([
  'FEEDBACK_AGENT_NAME',
  'FEEDBACK_AUTHOR',
  'FEEDBACK_BASE_URL',
  'CW_AGENT_NAME',
  'CW_AUTHOR',
  'CW_BASE_URL',
]);

type ToolResult = { isError?: boolean; content?: Array<{ text?: string }> };

describe('unarchive_task restores an archived goal with its tasks', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let child: ChildProcess;
  const pending = new Map<number, (msg: Record<string, unknown>) => void>();
  let nextId = 1;

  const call = (method: string, params: unknown): Promise<Record<string, unknown>> => {
    const id = ++nextId;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 15_000);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        resolvePromise(msg);
      });
      child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  };

  const toolRaw = async (name: string, args: unknown): Promise<ToolResult> => {
    const reply = (await call('tools/call', { name, arguments: args })) as {
      result?: ToolResult;
      error?: unknown;
    };
    expect(reply.error).toBeUndefined();
    return reply.result ?? {};
  };

  const tool = async (name: string, args: unknown): Promise<Record<string, unknown>> => {
    const res = await toolRaw(name, args);
    expect(res.isError).not.toBe(true);
    return JSON.parse(res.content?.[0]?.text ?? '{}');
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'mcp-goal-restore-'));
    handle = createServer({ port: 0, dataDir });
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (!IDENTITY_KEYS.has(k) && v !== undefined) env[k] = v;
    }
    env.FEEDBACK_BASE_URL = `http://127.0.0.1:${handle.port}`;
    env.FEEDBACK_AGENT_NAME = 'Lighthouse Keeper';
    child = spawn('node', [BUNDLE], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '';
    child.stdout?.on('data', (d: Buffer) => {
      buf += d.toString();
      let nl = buf.indexOf('\n');
      while (nl !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line.startsWith('{')) {
          const msg = JSON.parse(line) as { id?: number };
          if (typeof msg.id === 'number') pending.get(msg.id)?.(msg);
        }
        nl = buf.indexOf('\n');
      }
    });
    await call('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'goal-restore-test', version: '0' },
    });
    child.stdin?.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
    );
  }, 60_000);

  afterAll(async () => {
    child?.kill();
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  /** One band holding an open task, an in-progress task, a done task, and a
   *  task archived on its own before the band goes; a second band beside it
   *  that nothing here may touch. */
  function seed() {
    const store = handle.tasks;
    const ws = store.createWorkspace('Harbour Lights');
    const G = seedGoals(
      store,
      ws.id,
      [
        { key: 'lamps', title: 'Keep the lamps lit' },
        { key: 'moor', title: 'Mend the moorings' },
      ],
      PERSON,
    );
    const add = (title: string, goal: string) => {
      const res = store.createTask(ws.id, { title, goal });
      if (!res.ok) throw new Error(`create failed: ${title}`);
      return res.task.id;
    };
    const ids = {
      open: add('Trim the wicks', G.lamps ?? ''),
      working: add('Polish the lens', G.lamps ?? ''),
      done: add('Order more oil', G.lamps ?? ''),
      earlier: add('Paint the rail', G.lamps ?? ''),
      beside: add('Splice the lines', G.moor ?? ''),
    };
    for (const [id, to] of [
      [ids.working, 'in-progress'],
      [ids.done, 'done'],
    ] as const) {
      const moved = store.transition(id, to, { actor: PERSON });
      if (!moved.ok) throw new Error(`transition to ${to} refused`);
    }
    const earlier = store.archiveTask(ids.earlier, { actor: PERSON, reason: 'not needed' });
    if (!earlier.ok) throw new Error('task archive refused');
    const statusBefore = new Map(
      [ids.open, ids.working, ids.done].map((id) => [id, store.getTask(id)?.status]),
    );
    const goalArchive = store.archiveGoal(G.lamps ?? '', { actor: PERSON, reason: 'season over' });
    if (!goalArchive.ok) throw new Error('goal archive refused');
    return { wsId: ws.id, G, ids, statusBefore, took: goalArchive.taskIds };
  }

  it('brings back every task the archive took, in its band, with its status', async () => {
    const store = handle.tasks;
    const { wsId, G, ids, statusBefore, took } = seed();
    // Positive control on the premise: the archive really took the three
    // tasks under the band, and they are off the board before the restore.
    expect(new Set(took)).toEqual(new Set([ids.open, ids.working, ids.done]));
    for (const id of took) expect(store.getTask(id)?.archivedAt).toBeGreaterThan(0);
    expect([...statusBefore.values()]).toEqual(['todo', 'in-progress', 'done']);

    const res = await tool('unarchive_task', { workspaceId: wsId, goalId: G.lamps });
    expect(res.goalId).toBe(G.lamps);
    expect(res.changed).toBe(true);
    expect(new Set(res.restoredTaskIds as string[])).toEqual(new Set(took));

    expect(store.getGoalRow(G.lamps ?? '')?.archivedAt).toBeUndefined();
    for (const id of took) {
      const task = store.getTask(id);
      expect(task?.archivedAt).toBeUndefined();
      expect(task?.goal).toBe(G.lamps);
      expect(task?.status).toBe(statusBefore.get(id));
    }
  });

  it('leaves a task that was archived on its own before the goal archived', async () => {
    const store = handle.tasks;
    const { wsId, G, ids } = seed();
    const res = await tool('unarchive_task', { workspaceId: wsId, goalId: G.lamps });
    expect(res.restoredTaskIds as string[]).not.toContain(ids.earlier);
    expect(store.getTask(ids.earlier)?.archivedAt).toBeGreaterThan(0);
    expect(store.getTask(ids.earlier)?.archiveReason).toBe('not needed');
    // The band beside it was never archived and is not touched.
    expect(store.getTask(ids.beside)?.archivedAt).toBeUndefined();
  });

  it('answers changed: false for a goal that is not archived', async () => {
    const { wsId, G } = seed();
    const res = await tool('unarchive_task', { workspaceId: wsId, goalId: G.moor });
    expect(res).toMatchObject({ goalId: G.moor, changed: false, restoredTaskIds: [] });
  });

  it('refuses a call that names both a task and a goal, or neither', async () => {
    const { wsId, G, ids } = seed();
    const both = await toolRaw('unarchive_task', {
      workspaceId: wsId,
      goalId: G.lamps,
      taskId: ids.earlier,
    });
    expect(both.isError).toBe(true);
    const neither = await toolRaw('unarchive_task', { workspaceId: wsId });
    expect(neither.isError).toBe(true);
    // The refusal names the way out, rather than a 404 for a task id nobody sent.
    expect(neither.content?.[0]?.text).toContain('goalId');
    expect(both.content?.[0]?.text).toContain('goalId');
    // Nothing was restored by either refusal.
    expect(handle.tasks.getGoalRow(G.lamps ?? '')?.archivedAt).toBeGreaterThan(0);
    expect(handle.tasks.getTask(ids.earlier)?.archivedAt).toBeGreaterThan(0);
  });

  it('still restores a single task by taskId', async () => {
    const { wsId, ids } = seed();
    const res = await tool('unarchive_task', { workspaceId: wsId, taskId: ids.earlier });
    expect(res).toMatchObject({ taskId: ids.earlier, changed: true });
    expect(handle.tasks.getTask(ids.earlier)?.archivedAt).toBeUndefined();
  });
});
