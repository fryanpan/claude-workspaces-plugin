/**
 * The gates run once, before both routers.
 *
 * Hono sits below `routes/request-chain-gates.ts` and above every family the
 * ordered chain still holds. This file drives a real server, with a probe
 * family mounted on the Hono app, and shows three things:
 *
 * - a share visitor is refused on a path Hono answers AND on a path the
 *   chain answers, by the same gate, and the Hono handler never runs for the
 *   refused one;
 * - admission decides each request exactly once, whichever router answers —
 *   a request Hono passes on to the chain is not admitted a second time;
 * - a websocket upgrade on a path a Hono family claims still opens on Bun.
 *
 * The positive controls are the owner reaching both paths and the visitor
 * reaching its own board: the refusals below are scope decisions, not a
 * credential that never worked.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HonoFamily } from '../src/hono-env.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import {
  type AccessHarness,
  type MintedShare,
  accessHarness,
  mintAccessShare,
} from './access-share.ts';
import { waitFor } from './wait-for.ts';

describe('the gates run once, before Hono and the ordered chain', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let access: AccessHarness;
  let share: MintedShare;
  /** The board the share covers, and a task on it. */
  let sharedBoard: string;
  let sharedTask: string;
  /** A board the share does not cover, and a task on it. */
  let otherBoard: string;
  let otherTask: string;

  /** Every admission verdict, in order. */
  const admissions: Array<{ pathname: string; admitted: boolean }> = [];
  /** How many times the probe's handler ran. */
  let probeRuns = 0;

  const probe: HonoFamily = (app) => {
    app.get('/api/hono-probe', (c) => {
      probeRuns += 1;
      return c.json({ answeredBy: 'hono', visitor: c.env.gate.visitor !== null });
    });
    // Claims the board's Yjs socket address, so the upgrade test can show a
    // socket still opens on Bun when a family matches the path.
    app.get('/workspaces/:ws/y', (c) => c.json({ answeredBy: 'hono' }));
  };

  /** One request, and the admission verdicts it produced. */
  const send = async (
    path: string,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; body: unknown; verdicts: boolean[] }> => {
    const before = admissions.length;
    const res = await fetch(`${base}${path}`, { redirect: 'manual', headers });
    const body = await res.json().catch(() => null);
    const verdicts = admissions
      .slice(before)
      .filter((a) => a.pathname === path)
      .map((a) => a.admitted);
    return { status: res.status, body, verdicts };
  };

  const task = (ws: string): string => {
    const filed = handle.tasks.createTask(ws, {
      title: 'Riverbend survey',
      assignee: 'human',
      actor: { id: 'agent-harborlight', name: 'Harborlight', kind: 'agent' },
    });
    if (!filed.ok) throw new Error('task create refused');
    return filed.task.id;
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'hono-front-gates-'));
    access = await accessHarness();
    handle = createServer({
      port: 0,
      dataDir,
      ...access.serverOptions,
      honoFamilies: [probe],
      observeAdmission: (pathname, admitted) => admissions.push({ pathname, admitted }),
    });
    base = `http://127.0.0.1:${handle.port}`;
    sharedBoard = handle.tasks.createWorkspace('Harborlight').id;
    otherBoard = handle.tasks.createWorkspace('Saltmarsh').id;
    sharedTask = task(sharedBoard);
    otherTask = task(otherBoard);
    share = await mintAccessShare(base, { ...access, shareLinks: handle.shareLinks }, sharedBoard);
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('the owner reaches the Hono path, admitted once (positive control)', async () => {
    const got = await send('/api/hono-probe');
    expect(got.status).toBe(200);
    expect(got.body).toEqual({ answeredBy: 'hono', visitor: false });
    expect(got.verdicts).toEqual([true]);
  });

  it('the owner reaches the chain path, admitted once though Hono saw it first', async () => {
    const got = await send(`/workspaces/${otherBoard}/tasks/${otherTask}/detail`);
    expect(got.status).toBe(200);
    expect((got.body as { task?: { id?: string } }).task?.id).toBe(otherTask);
    expect(got.verdicts).toEqual([true]);
  });

  it('the visitor reaches its own board (positive control)', async () => {
    const got = await send(`/workspaces/${sharedBoard}/tasks/${sharedTask}/detail`, share.headers);
    expect(got.status).toBe(200);
    expect(got.verdicts).toEqual([true]);
  });

  it('refuses the visitor on the Hono path, before the Hono handler runs', async () => {
    const runs = probeRuns;
    const got = await send('/api/hono-probe', share.headers);
    expect(got.status).toBe(403);
    expect(got.verdicts).toEqual([false]);
    expect(probeRuns).toBe(runs);
  });

  it('refuses the visitor on the chain path, by the same single check', async () => {
    const got = await send(`/workspaces/${otherBoard}/tasks/${otherTask}/detail`, share.headers);
    expect(got.status).toBe(403);
    expect(got.verdicts).toEqual([false]);
  });

  it('opens a websocket on Bun even where a Hono family claims the path', async () => {
    // A plain GET there is the probe's: Hono does claim this address.
    const plain = await send(`/workspaces/${sharedBoard}/y`);
    expect(plain.body).toEqual({ answeredBy: 'hono' });

    const ws = new WebSocket(`ws://127.0.0.1:${handle.port}/workspaces/${sharedBoard}/y`);
    let opened = false;
    let failed = false;
    ws.addEventListener('open', () => {
      opened = true;
    });
    ws.addEventListener('error', () => {
      failed = true;
    });
    await waitFor(() => opened || failed, { describe: 'the socket opened or failed' });
    expect({ opened, failed }).toEqual({ opened: true, failed: false });
    ws.close();
  });
});
