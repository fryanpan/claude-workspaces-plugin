/**
 * How an open board page learns whether the collab core serves its board, so
 * it can pick its presence strip (D1 step 10): the board record carries
 * `collabCore.active`, and `POST /workspaces/<id>/collab-core` tells the
 * board's open pages with a `collab-core.changed` frame. Pages only: an
 * agent acts on nothing in it, and each frame costs a session a turn.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { pageStream } from './lead-chat-page-stream.ts';
import { type Frame, listenFrames } from './sse-frames.ts';
import { waitFor } from './wait-for.ts';
import { seedBoard } from './workspace-seed.ts';

const handles: ServerHandle[] = [];
const dirs: string[] = [];
const streams: Array<{ close: () => void }> = [];
afterEach(async () => {
  for (const s of streams.splice(0)) s.close();
  for (const h of handles.splice(0)) await h.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function boot(collabCore: boolean): Promise<{ base: string; ws: string }> {
  const dataDir = mkdtempSync(join(tmpdir(), 'collab-core-strip-'));
  dirs.push(dataDir);
  const handle = createServer({ port: 0, dataDir, collabCore, requireSignInToWrite: false });
  handles.push(handle);
  const base = `http://127.0.0.1:${handle.port}`;
  return { base, ws: await seedBoard(base, { name: 'Harborlight' }) };
}

async function record(base: string, ws: string): Promise<unknown> {
  const r = await fetch(`${base}/workspaces/${ws}?format=json`);
  expect(r.status).toBe(200);
  return ((await r.json()) as { collabCore?: unknown }).collabCore;
}

async function flip(base: string, ws: string, on: boolean): Promise<void> {
  const r = await fetch(`${base}/workspaces/${ws}/collab-core`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ on }),
  });
  expect(r.status).toBe(200);
}

async function streamsFor(base: string, ws: string) {
  const res = await fetch(`${base}/workspaces/${ws}/events:stream`, {
    headers: { accept: 'text/event-stream' },
  });
  const page = listenFrames(res);
  const agent = await pageStream(base, ws, 'agent-riverbend');
  streams.push({ close: () => void page.stop() }, agent);
  return { page, agent };
}

const flips = (frames: readonly Frame[]) =>
  frames.filter((f) => f.event === 'collab-core.changed').map((f) => f.data?.active);

describe('the board record and frame that pick the presence strip', () => {
  it('says active once the board is switched on, and tells open pages but no agent', async () => {
    const { base, ws } = await boot(true);
    expect(await record(base, ws)).toEqual({ active: false });
    const { page, agent } = await streamsFor(base, ws);

    await flip(base, ws, true);
    await waitFor(() => flips(page.frames).length === 1, { describe: 'the page hears the flip' });
    expect(flips(page.frames)).toEqual([true]);
    expect(await record(base, ws)).toEqual({ active: true });

    // The agent's stream is open and hearing board news (the control): a
    // task filed now reaches it, and the flip before it never did.
    const filed = await fetch(`${base}/workspaces/${ws}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Saltmarsh survey',
        author: { id: 'known-alice', name: 'Alice', kind: 'known' },
      }),
    });
    expect(filed.status).toBeLessThan(300);
    await waitFor(() => agent.events.some((e) => e.startsWith('task.')), {
      describe: 'the agent hears a task event',
    });
    expect(agent.events).not.toContain('collab-core.changed');

    await flip(base, ws, false);
    await waitFor(() => flips(page.frames).length === 2, {
      describe: 'the page hears the flip back',
    });
    expect(flips(page.frames)).toEqual([true, false]);
    expect(await record(base, ws)).toEqual({ active: false });
  });

  it('stays inactive on a server started with the collab core off', async () => {
    const { base, ws } = await boot(false);
    await flip(base, ws, true);
    expect(await record(base, ws)).toEqual({ active: false });
  });
});
