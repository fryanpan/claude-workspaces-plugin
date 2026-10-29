/**
 * A file the server reads or writes under a walled lead's registered root
 * stays held to that root (`board-socket-roots.ts`, installed as a path guard
 * on `slow-fs.ts` `boundFiles.guards`), whoever bound it. The lead can write
 * the folders on the way to such a file, so:
 *
 * - a bound root swapped for a link to a folder outside serves nothing from
 *   it, neither a file nor a name;
 * - a folder inside the root swapped for such a link serves nothing either,
 *   and a write through it never creates a file outside;
 * - media, and the images beside a bound doc, are read from the descriptor
 *   that was checked, and an image upload through a swapped folder creates
 *   nothing outside;
 * - no git runs in a repository holding a root, so no program its settings
 *   name runs.
 *
 * Each refusal has its positive control: the same read before the change.
 * The binds are the owner's, over TCP from this machine: a lead may not bind
 * over its socket. Fixtures synthetic.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boardSocketPath } from '../src/board-sockets.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { tinyPng } from './tiny-png.ts';
import { waitFor } from './wait-for.ts';

let h: ServerHandle;
let dataDir: string;
let workDir: string;
let socketRoot: string;
let socketDir: string;
let base: string;
let harborlight: string;
let secrets: string;

const json = { 'content-type': 'application/json' };
const tcp = (path: string, init: RequestInit = {}) =>
  fetch(`${base}${path}`, { ...init, headers: { ...json, ...(init.headers ?? {}) } });

async function board(name: string): Promise<string> {
  const res = await tcp('/workspaces', { method: 'POST', body: JSON.stringify({ name }) });
  return ((await res.json()) as { workspace: { id: string } }).workspace.id;
}

/** A project folder with two notes in it. */
function project(name: string): string {
  const dir = join(workDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'notes.md'), `# ${name} notes\n`);
  writeFileSync(join(dir, 'later.md'), `# ${name} later\n`);
  return dir;
}

async function setRoots(roots: string[]): Promise<void> {
  const res = await tcp(`/api/board-sockets/${harborlight}/roots`, {
    method: 'PUT',
    body: JSON.stringify({ roots }),
  });
  expect(res.status, await res.clone().text()).toBe(200);
}

/** The owner binds a folder on Harborlight; its set id. */
async function bind(folderPath: string): Promise<string> {
  const res = await tcp('/workspaces', {
    method: 'POST',
    body: JSON.stringify({ folderPath, hubWorkspaceId: harborlight }),
  });
  expect(res.status, await res.clone().text()).toBe(200);
  return ((await res.json()) as { setId: string }).setId;
}

/** Open one file of a set for context, the all-files sidebar's click. */
async function openFile(setId: string, relPath: string): Promise<Response> {
  return tcp(`/workspaces/${harborlight}/attachments/${encodeURIComponent(setId)}/context-file`, {
    method: 'POST',
    body: JSON.stringify({ relPath }),
  });
}

/** Open one markdown file of a set for editing; its doc id. */
async function openEditable(setId: string, relPath: string): Promise<string> {
  const res = await tcp(
    `/workspaces/${harborlight}/attachments/${encodeURIComponent(setId)}/editable-file`,
    { method: 'POST', body: JSON.stringify({ relPath }) },
  );
  expect(res.status, await res.clone().text()).toBe(200);
  return ((await res.json()) as { docId: string }).docId;
}

/** A whole-doc rewrite. */
async function rewrite(docId: string, markdown: string): Promise<Response> {
  return tcp(`/workspaces/${harborlight}/docs/${encodeURIComponent(docId)}/content`, {
    method: 'POST',
    body: JSON.stringify({ markdown, confirmOverwriteHumanEdits: true }),
  });
}

async function treeNames(setId: string): Promise<string> {
  const res = await tcp(`/workspaces/${harborlight}/attachments/${encodeURIComponent(setId)}/tree`);
  return res.text();
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'bs-lead-binds-'));
  workDir = realpathSync(mkdtempSync(join(tmpdir(), 'bs-lead-binds-work-')));
  socketRoot = mkdtempSync(
    process.platform === 'darwin' ? '/private/tmp/bslb-' : join(tmpdir(), 'bslb-'),
  );
  socketDir = join(socketRoot, 'boards');
  h = createServer({ port: 0, dataDir, boardSocketDir: socketDir });
  base = `http://127.0.0.1:${h.port}`;
  harborlight = await board('Harborlight');
  // The socket is opened, as for any walled lead; nothing here is posted on it.
  expect(existsSync(boardSocketPath(socketDir, harborlight))).toBe(true);
  // What the lead's profile keeps from it, with a file of the same name.
  secrets = join(workDir, 'riverbend-keys');
  mkdirSync(secrets, { recursive: true });
  writeFileSync(join(secrets, 'later.md'), 'riverbend secret\n');
  writeFileSync(join(secrets, 'only-here.md'), 'riverbend secret\n');
});

afterAll(async () => {
  await h.stop();
  for (const d of [dataDir, workDir, socketRoot]) rmSync(d, { recursive: true, force: true });
});

describe('a bound folder under a lead’s root, after the bind', () => {
  it('serves nothing through a root swapped for a link out of it', async () => {
    const root = project('harbor-swap');
    await setRoots([root]);
    const setId = await bind(root);
    // The control: before the swap the root's own file opens.
    expect((await openFile(setId, 'notes.md')).status).toBe(200);

    renameSync(root, `${root}.moved`);
    symlinkSync(secrets, root);
    const opened = await openFile(setId, 'later.md');
    expect(opened.status).not.toBe(200);
    expect(await opened.text()).not.toContain('riverbend secret');
    expect((await openFile(setId, 'only-here.md')).status).not.toBe(200);
    expect(await treeNames(setId)).not.toContain('only-here.md');
  }, 30_000);

  it('serves nothing through a folder inside the root swapped for a link', async () => {
    const root = project('harbor-sub-read');
    mkdirSync(join(root, 'sub'));
    writeFileSync(join(root, 'sub', 'first.md'), '# harbor sub first\n');
    writeFileSync(join(root, 'sub', 'later.md'), '# harbor sub later\n');
    await setRoots([root]);
    const setId = await bind(root);
    // The control: before the swap a file in the folder opens.
    expect((await openFile(setId, 'sub/first.md')).status).toBe(200);

    renameSync(join(root, 'sub'), join(root, 'sub.moved'));
    symlinkSync(secrets, join(root, 'sub'));
    // `later.md` is listed in the set, and the link's target has one too.
    const opened = await openFile(setId, 'sub/later.md');
    expect(opened.status).not.toBe(200);
    expect(await opened.text()).not.toContain('riverbend secret');
  }, 30_000);

  it('never writes outside through a folder inside the root swapped for a link', async () => {
    const root = project('harbor-sub-write');
    mkdirSync(join(root, 'sub'));
    writeFileSync(join(root, 'sub', 'plan.md'), '# harbor plan\n');
    // Somewhere the profile keeps from the lead, with no plan.md in it.
    const outside = join(workDir, 'riverbend-rules');
    mkdirSync(outside, { recursive: true });
    await setRoots([root]);
    const setId = await bind(root);
    const docId = await openEditable(setId, 'sub/plan.md');

    // The control: before the swap the rewrite reaches the file on disk.
    const first = await rewrite(docId, '# harbor plan\n\nFirst pass.\n');
    expect(first.status, await first.clone().text()).toBe(200);
    await waitFor(
      () =>
        Bun.file(join(root, 'sub', 'plan.md'))
          .text()
          .then((t) => t.includes('First pass.')),
      { describe: 'the first rewrite written back to the bound file' },
    );

    renameSync(join(root, 'sub'), join(root, 'sub.moved'));
    symlinkSync(outside, join(root, 'sub'));
    await rewrite(docId, '# harbor plan\n\nSecond pass.\n');
    // The refusal reports itself on the doc rather than failing quietly.
    const said = await waitFor(() => h.docStore.getSyncError(docId), {
      describe: 'the refused write-back reported on the doc',
    });
    expect(JSON.stringify(said)).toContain('Not saved to disk');
    expect(existsSync(join(outside, 'plan.md'))).toBe(false);
    expect(readdirSync(outside)).toEqual([]);
  }, 30_000);

  it('serves media from the file it checked, and nothing through a swapped folder', async () => {
    const root = project('harbor-media');
    mkdirSync(join(root, 'shots'));
    writeFileSync(join(root, 'shots', 'first.png'), 'harbor-png-first');
    writeFileSync(join(root, 'shots', 'later.png'), 'harbor-png-later');
    writeFileSync(join(secrets, 'later.png'), 'riverbend-png');
    await setRoots([root]);
    const setId = await bind(root);
    const raw = (rel: string, range?: string) =>
      tcp(
        `/workspaces/${harborlight}/attachments/${encodeURIComponent(setId)}/raw?path=${encodeURIComponent(rel)}`,
        range ? { headers: { range } } : {},
      );
    // The controls: the whole file, and a range of it, from inside.
    const whole = await raw('shots/first.png');
    expect(whole.status, await whole.clone().text()).toBe(200);
    expect(await whole.text()).toBe('harbor-png-first');
    const part = await raw('shots/first.png', 'bytes=0-5');
    expect(part.status).toBe(206);
    expect(await part.text()).toBe('harbor');

    renameSync(join(root, 'shots'), join(root, 'shots.moved'));
    symlinkSync(secrets, join(root, 'shots'));
    const through = await raw('shots/later.png');
    expect(through.status).not.toBe(200);
    expect(await through.text()).not.toContain('riverbend');
  }, 30_000);
});

describe('the images beside a bound doc under a lead’s root', () => {
  it('reads and stores nothing through the doc’s folder swapped for a link', async () => {
    const root = project('harbor-assets');
    const docDir = join(root, 'plan');
    mkdirSync(join(docDir, 'images'), { recursive: true });
    writeFileSync(join(docDir, 'doc.md'), '# Harborlight plan\n');
    const png = tinyPng(40);
    writeFileSync(join(docDir, 'images', 'chart.png'), png);
    // What the profile keeps from the lead, with an image at the same place.
    const outside = join(workDir, 'riverbend-plan');
    mkdirSync(join(outside, 'images'), { recursive: true });
    writeFileSync(join(outside, 'images', 'chart.png'), tinyPng(41));
    await setRoots([root]);
    const created = await tcp(`/workspaces/${harborlight}/docs`, {
      method: 'POST',
      body: JSON.stringify({
        docId: 'harbor-assets',
        type: 'markdown',
        sourceUrl: join(docDir, 'doc.md'),
      }),
    });
    expect(created.ok, await created.clone().text()).toBe(true);
    const at = `/workspaces/${harborlight}/docs/harbor-assets/assets`;
    const upload = () =>
      fetch(`${base}${at}?name=${encodeURIComponent('Harborlight Chart.png')}`, {
        method: 'POST',
        headers: { 'content-type': 'image/png' },
        body: tinyPng(42),
      });

    // The controls: before the swap the image reads and an upload stores.
    const served = await tcp(`${at}/images/chart.png`);
    expect(served.status, await served.clone().text()).toBe(200);
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(png);
    const stored = await upload();
    expect(stored.status, await stored.clone().text()).toBe(201);

    // A link the lead could make in node_modules, moved into the doc folder's
    // place. Every check beside the doc resolves from that folder, so only
    // the guard, which judges from the root, can see that it left.
    renameSync(docDir, `${docDir}.moved`);
    symlinkSync(outside, docDir);
    const through = await tcp(`${at}/images/chart.png`);
    expect(through.status).toBe(404);
    const refused = await upload();
    expect(refused.status).toBe(409);
    expect(readdirSync(join(outside, 'images'))).toEqual(['chart.png']);
  }, 30_000);
});

describe('a doc bound through a link above the root', () => {
  it('is held as the root is spelled', async () => {
    const root = project('harbor-alias');
    const docDir = join(root, 'plan');
    mkdirSync(join(docDir, 'images'), { recursive: true });
    writeFileSync(join(docDir, 'doc.md'), '# Harborlight alias plan\n');
    writeFileSync(join(docDir, 'images', 'chart.png'), tinyPng(50));
    const outside = join(workDir, 'riverbend-alias');
    mkdirSync(join(outside, 'images'), { recursive: true });
    writeFileSync(join(outside, 'images', 'chart.png'), tinyPng(51));
    await setRoots([root]);
    // `~/dev` on a symlinked home: the bound path is not the root's spelling.
    const alias = join(socketRoot, 'work-alias');
    symlinkSync(workDir, alias);
    const created = await tcp(`/workspaces/${harborlight}/docs`, {
      method: 'POST',
      body: JSON.stringify({
        docId: 'harbor-alias',
        type: 'markdown',
        sourceUrl: join(alias, 'harbor-alias', 'plan', 'doc.md'),
      }),
    });
    expect(created.ok, await created.clone().text()).toBe(true);
    const image = () => tcp(`/workspaces/${harborlight}/docs/harbor-alias/assets/images/chart.png`);
    // The control: before the swap the image reads.
    expect((await image()).status).toBe(200);

    renameSync(docDir, `${docDir}.moved`);
    symlinkSync(outside, docDir);
    expect((await image()).status).toBe(404);
  }, 30_000);
});

describe('git in a lead’s root', () => {
  it('runs no program the repository names, through the bind and a file open', async () => {
    const root = project('harbor-git');
    const marker = join(workDir, 'harbor-git-ran');
    const hook = join(workDir, 'harbor-git-hook.sh');
    writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
    chmodSync(hook, 0o755);
    const git = (...args: string[]) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    git('init', '-q');
    writeFileSync(join(root, '.gitattributes'), '*.md filter=harbor\n');
    git('add', '.');
    git('-c', 'user.name=Alice', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'x');
    git('config', 'core.fsmonitor', hook);
    git('config', 'filter.harbor.clean', `${hook}; cat`);
    // Positive control: plain git in the same repo runs the planted program.
    writeFileSync(join(root, 'notes.md'), '# harbor-git notes\n\nEdited.\n');
    git('status', '--porcelain');
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);

    await setRoots([root]);
    const res = await tcp('/workspaces', {
      method: 'POST',
      body: JSON.stringify({ folderPath: root, hubWorkspaceId: harborlight }),
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const { setId, listed } = (await res.json()) as { setId: string; listed: string[] };
    // Listed by a walk, since no git runs here.
    expect(listed).toEqual(['later.md', 'notes.md']);
    const opened = await openFile(setId, 'notes.md');
    expect(opened.status, await opened.clone().text()).toBe(200);
    expect(existsSync(marker)).toBe(false);
  }, 30_000);
});
