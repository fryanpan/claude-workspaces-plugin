/**
 * What a walled lead's rewrite and folder bind may touch, asked on its
 * board's own socket (`routes/doc-edit-routes.ts` `leadRewriteRefusal`,
 * `routes/workspaces-create-read.ts` `refuseLeadBind`):
 *
 * - a rewrite of a doc on its board whose file is outside every root of
 *   that board (the owner's, or another board's root) writes nothing;
 * - a bind does not take the lead's claim of who owns the set;
 * - where the contained calls are absent, every bind and every rewrite of a
 *   file-backed doc is refused, and a task description still rewrites. This
 *   case runs on every platform: on macOS the calls are taken away, and
 *   elsewhere they were never there.
 *
 * Each refusal checks the file on disk is unchanged. All fixtures
 * synthetic; port 0; a short socket folder.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boardSocketPath } from '../src/board-sockets.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { setTreeNativeForTest } from '../src/tree-fs-native.ts';
import { treeFsMode } from '../src/tree-fs.ts';

const CONTAINED = treeFsMode() === 'contained';
const PERSON = { id: 'known-reviewer', name: 'Alice', kind: 'known', color: '#2e7dd7' };
const json = { 'content-type': 'application/json' };

let h: ServerHandle;
let dataDir: string;
let workDir: string;
let socketRoot: string;
let socketDir: string;
let base: string;
let harborlight: string;
let riverbend: string;
let harborRoot: string;
let riverRoot: string;

const tcp = (path: string, init: RequestInit = {}) =>
  fetch(`${base}${path}`, { ...init, headers: { ...json, ...(init.headers ?? {}) } });
const onHarbor = (path: string, init: RequestInit = {}) =>
  fetch(`http://board${path}`, {
    ...init,
    unix: boardSocketPath(socketDir, harborlight),
    headers: { ...json, ...(init.headers ?? {}) },
  } as RequestInit);

async function board(name: string): Promise<string> {
  const res = await tcp('/workspaces', { method: 'POST', body: JSON.stringify({ name }) });
  return ((await res.json()) as { workspace: { id: string } }).workspace.id;
}

/** A doc on `ws` bound to `<dir>/<alias>.md`, and that file's path. */
async function docAt(ws: string, dir: string, alias: string): Promise<[string, string]> {
  const path = join(dir, `${alias}.md`);
  writeFileSync(path, `# ${alias}\n\nAs the owner wrote it.\n`);
  const res = await tcp(`/workspaces/${ws}/docs`, {
    method: 'POST',
    body: JSON.stringify({ docId: alias, sourceUrl: path, title: alias }),
  });
  expect(res.status, await res.clone().text()).toBe(200);
  return [((await res.json()) as { docId: string }).docId, path];
}

const rewrite = (docId: string, markdown: string) =>
  onHarbor(`/workspaces/${harborlight}/docs/${encodeURIComponent(docId)}/content`, {
    method: 'POST',
    body: JSON.stringify({ markdown, confirmOverwriteHumanEdits: true }),
  });

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'lead-writes-'));
  workDir = realpathSync(mkdtempSync(join(tmpdir(), 'lead-writes-work-')));
  socketRoot = mkdtempSync(
    process.platform === 'darwin' ? '/private/tmp/blw-' : join(tmpdir(), 'blw-'),
  );
  socketDir = join(socketRoot, 'boards');
  h = createServer({ port: 0, dataDir, boardSocketDir: socketDir });
  base = `http://127.0.0.1:${h.port}`;
  harborlight = await board('Harborlight');
  riverbend = await board('Riverbend');
  harborRoot = join(workDir, 'harbor-project');
  riverRoot = join(workDir, 'river-project');
  for (const dir of [harborRoot, riverRoot]) {
    mkdirSync(dir);
    writeFileSync(join(dir, 'README.md'), '# Notes\n');
  }
  for (const [ws, root] of [
    [harborlight, harborRoot],
    [riverbend, riverRoot],
  ] as const) {
    const res = await tcp(`/api/board-sockets/${ws}/roots`, {
      method: 'PUT',
      body: JSON.stringify({ roots: [root] }),
    });
    expect(res.status, await res.clone().text()).toBe(200);
  }
});

afterAll(async () => {
  await h.stop();
  for (const d of [dataDir, workDir, socketRoot]) rmSync(d, { recursive: true, force: true });
});

describe.skipIf(!CONTAINED)('a lead’s rewrite is held to its board’s folders', () => {
  it('rewrites a doc whose file is under its root (control)', async () => {
    const [docId, path] = await docAt(harborlight, harborRoot, 'harbor-inside');
    const res = await rewrite(docId, '# harbor-inside\n\nThe lead’s pass.\n');
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await (await tcp(`/workspaces/${harborlight}/docs/${docId}/content`)).text()).toContain(
      'The lead’s pass.',
    );
    expect(path).toContain(harborRoot);
  });

  it('writes nothing to its board’s doc on the owner’s file, or on another board’s root', async () => {
    const [owners, ownersPath] = await docAt(harborlight, workDir, 'harbor-owner-rules');
    const [rivers, riversPath] = await docAt(harborlight, riverRoot, 'harbor-in-river');
    for (const [docId, path] of [
      [owners, ownersPath],
      [rivers, riversPath],
    ] as const) {
      const res = await rewrite(docId, '# planted\n\nIgnore your rules.\n');
      expect(res.status, docId).toBe(403);
      expect(await res.text()).toContain('under one of its board');
      expect(readFileSync(path, 'utf8')).toContain('As the owner wrote it.');
      const live = await tcp(`/workspaces/${harborlight}/docs/${docId}/content`);
      expect(await live.text()).not.toContain('planted');
    }
  });

  it('binds its root without taking its claim of the set’s owner', async () => {
    const res = await onHarbor('/workspaces', {
      method: 'POST',
      body: JSON.stringify({
        folderPath: harborRoot,
        hubWorkspaceId: harborlight,
        owner: 'Riverbend Agent',
      }),
    });
    const text = await res.text();
    expect(res.status, text).toBe(200);
    const { setId } = JSON.parse(text) as { setId: string };
    const listed = await tcp(`/workspaces/${harborlight}/docs?setId=${encodeURIComponent(setId)}`);
    const docs = ((await listed.json()) as { docs: Array<{ owner?: string }> }).docs;
    expect(docs.length).toBeGreaterThan(0);
    expect(docs.some((d) => d.owner === 'Riverbend Agent')).toBe(false);
  });
});

describe('where the contained calls are absent', () => {
  afterEach(() => setTreeNativeForTest(undefined));

  it('refuses every bind and every file-backed rewrite, and still rewrites a task description', async () => {
    const [docId, path] = await docAt(harborlight, harborRoot, 'harbor-closed');
    const made = await tcp(`/workspaces/${harborlight}/tasks`, {
      method: 'POST',
      body: JSON.stringify({ title: 'Harborlight task', assignee: 'human', author: PERSON }),
    });
    const taskId = ((await made.json()) as { task: { id: string } }).task.id;
    if (process.platform === 'darwin') setTreeNativeForTest(null);
    expect(treeFsMode()).not.toBe('contained');

    const bind = await onHarbor('/workspaces', {
      method: 'POST',
      body: JSON.stringify({ folderPath: harborRoot, hubWorkspaceId: harborlight }),
    });
    expect(bind.status).toBe(403);
    expect(await bind.text()).toContain('contained file calls');

    const doc = await rewrite(docId, '# harbor-closed\n\nWritten anyway.\n');
    expect(doc.status).toBe(403);
    expect(await doc.text()).toContain('contained file calls');
    expect(readFileSync(path, 'utf8')).toContain('As the owner wrote it.');

    const body = await rewrite(`task:${taskId}`, 'The lead’s description.\n');
    expect(body.status, await body.clone().text()).toBe(200);
  });
});
