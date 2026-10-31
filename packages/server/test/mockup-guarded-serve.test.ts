/**
 * A mock that is not HTML, served by its address while a path guard covers
 * its folder: read through the guard's checked read, never refused only for
 * being covered, and refused where the guard does not admit it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { boundFiles } from '../src/slow-fs.ts';

describe('a non-HTML mock in a folder a guard covers', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let ws = '';
  const LOCAL = () => ({ host: `localhost:${handle.port}` });
  const AGENT = { id: 'agent-cartographer', name: 'Cartographer', kind: 'agent' };
  const post = async (path: string, body: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...LOCAL() },
      body: JSON.stringify(body),
    });
    expect(res.ok, `${path} ${res.status}`).toBe(true);
    return res.json() as Promise<Record<string, unknown>>;
  };
  const get = (path: string) => fetch(`${base}${path}`, { headers: LOCAL() });

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'mockup-guarded-serve-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://127.0.0.1:${handle.port}`;
    ws = (
      (await post('/workspaces', { name: 'Harborlight', author: AGENT })) as {
        workspace: { id: string };
      }
    ).workspace.id;
  });
  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  // A guard covers the owner's part of `~/.claude` and admits it, refusing
  // only what a walled lead writes: such a mock is read, not refused.
  it('serves an SVG mock a guard covers by its checked read, and refuses one it does not admit', async () => {
    const dir = join(dataDir, 'guarded');
    mkdirSync(dir);
    const svg = join(dir, 'plan.svg');
    writeFileSync(svg, '<svg xmlns="http://www.w3.org/2000/svg"><text>plan</text></svg>');
    const id = (
      (await post(`/workspaces/${ws}/docs`, {
        docId: 'plan-svg',
        type: 'mockup',
        sourceUrl: svg,
      })) as { docId: string }
    ).docId;
    let admit = true;
    const inDir = (p: string) => p.startsWith(`${dir}/`);
    const remove = boundFiles.guards.add({
      covers: inDir,
      admits: (p) => !inDir(p) || admit,
      landsInside: () => true,
    });
    try {
      const res = await get(`/workspaces/${ws}/mockups/${id}`);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('<text>plan</text>');
      admit = false;
      expect((await get(`/workspaces/${ws}/mockups/${id}`)).status).toBe(404);
    } finally {
      remove();
    }
  });
});
