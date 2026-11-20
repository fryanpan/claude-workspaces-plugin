/**
 * Core mode: the server suite run with every test board on the collab core
 * (M8 cutover trial, bar 1).
 *
 * `CW_COLLAB_CORE_DEFAULT=on` (`ServerOptions.collabCoreDefault`) starts every
 * board and the server-wide setting on, so a test that never calls the switch
 * still syncs through the core. ci.yml's `server-core` job runs the whole
 * suite that way, unchanged.
 *
 * The last case is that job's positive control: it boots a server with no
 * option at all, as every other test does, and checks the socket took the
 * path the environment says. In the core job it proves the mode reached the
 * test servers (a run that silently took the current code would fail here);
 * in the ordinary job it proves the default is still off.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCollabCoreDefault } from '../src/collab-core-switch.ts';
import { type ServerHandle, type ServerOptions, createServer } from '../src/server.ts';
import { type Page, openPage } from './collab-core-page.ts';
import { seedBoard } from './workspace-seed.ts';

const dirs: string[] = [];
const handles: ServerHandle[] = [];
const pages: Page[] = [];

afterEach(async () => {
  for (const p of pages.splice(0)) p.close();
  for (const h of handles.splice(0)) await h.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function boot(opts: Partial<ServerOptions> = {}): {
  handle: ServerHandle;
  base: string;
  dataDir: string;
} {
  const dataDir = mkdtempSync(join(tmpdir(), 'collab-core-mode-'));
  dirs.push(dataDir);
  const handle = createServer({ port: 0, dataDir, requireSignInToWrite: false, ...opts });
  handles.push(handle);
  return { handle, base: `http://127.0.0.1:${handle.port}`, dataDir };
}

async function addDoc(base: string, dataDir: string, ws: string): Promise<string> {
  const path = join(dataDir, 'riverbend-notes.md');
  writeFileSync(path, '# Riverbend notes\n\nIntro paragraph.\n');
  const r = await fetch(`${base}/workspaces/${ws}/docs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ docId: 'riverbend-notes', type: 'markdown', sourceUrl: path }),
  });
  expect(r.status).toBe(200);
  return ((await r.json()) as { docId: string }).docId;
}

function page(base: string, path: string): Page {
  const p = openPage(`${base.replace('http', 'ws')}${path}`, base);
  pages.push(p);
  return p;
}

describe('core mode', () => {
  it('puts a new board and its docs on the core with no switch call', async () => {
    const { handle, base, dataDir } = boot({ collabCoreDefault: true });
    const ws = await seedBoard(base, { name: 'Harborlight' });
    const docId = await addDoc(base, dataDir, ws);
    expect(handle.collabCore.switch.usesCore(ws)).toBe(true);
    const board = page(base, `/workspaces/${ws}/y`);
    const doc = page(base, `/workspaces/${ws}/docs/${docId}/y`);
    await Promise.all([board.ready, doc.ready]);
    expect(handle.collabCore.path.openRooms().sort()).toEqual([docId, `ws:${ws}`].sort());
    const r = await fetch(`${base}/workspaces/${ws}?format=json`);
    const record = (await r.json()) as { collabCore?: { active?: boolean } };
    expect(record.collabCore?.active).toBe(true);
  });

  it('control: the same server without it keeps every board on the current code', async () => {
    const { handle, base, dataDir } = boot({ collabCoreDefault: false });
    const ws = await seedBoard(base, { name: 'Harborlight' });
    const docId = await addDoc(base, dataDir, ws);
    const doc = page(base, `/workspaces/${ws}/docs/${docId}/y`);
    await doc.ready;
    expect(handle.collabCore.switch.usesCore(ws)).toBe(false);
    expect(handle.collabCore.path.openRooms()).toEqual([]);
  });

  it('an environment that fixes the core off still wins', async () => {
    const { handle, base } = boot({ collabCoreDefault: true, collabCore: false });
    const ws = await seedBoard(base, { name: 'Harborlight' });
    expect(handle.collabCore.switch.usesCore(ws)).toBe(false);
  });

  it('a server booted with no option follows CW_COLLAB_CORE_DEFAULT (the core job’s control)', async () => {
    const expected = parseCollabCoreDefault(process.env.CW_COLLAB_CORE_DEFAULT);
    console.log(`[collab-core-mode] CW_COLLAB_CORE_DEFAULT reads ${expected ? 'on' : 'off'}`);
    const { handle, base, dataDir } = boot();
    const ws = await seedBoard(base, { name: 'Harborlight' });
    const docId = await addDoc(base, dataDir, ws);
    const doc = page(base, `/workspaces/${ws}/docs/${docId}/y`);
    await doc.ready;
    expect(handle.collabCore.switch.usesCore(ws)).toBe(expected);
    expect(handle.collabCore.path.openRooms()).toEqual(expected ? [docId] : []);
  });
});
