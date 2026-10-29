/**
 * A walled lead's folder bind stays held to its roots after the bind, not
 * only at it (`board-socket-roots.ts`, installed as a path guard on
 * `slow-fs.ts` `boundFiles.guards`):
 *
 * - a bound root swapped for a link to a folder outside the roots serves
 *   nothing from it, neither a file nor a name;
 * - a folder inside the root swapped for such a link serves nothing either,
 *   and a write through it never creates a file outside;
 * - a root dropped from the board's list stops serving the lead's set, and
 *   only the lead's: a set the owner bound on the same folder still serves;
 * - archiving a lead's set sets its record aside, and unarchiving restores it;
 * - a lead's bind never lands on a set another board holds;
 * - a lead's `maxFiles` is bounded.
 *
 * Each refusal has its positive control: the same read before the change.
 * The bind is posted on Harborlight's socket; reads are over TCP from this
 * machine, which is any reader the server answers. Fixtures synthetic.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boardSocketRootsPath } from '../src/board-socket-roots.ts';
import { boardSocketPath } from '../src/board-sockets.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { waitFor } from './wait-for.ts';

let h: ServerHandle;
let dataDir: string;
let workDir: string;
let socketRoot: string;
let socketDir: string;
let base: string;
let harborlight: string;
let riverbend: string;
let secrets: string;

const json = { 'content-type': 'application/json' };
const tcp = (path: string, init: RequestInit = {}) =>
  fetch(`${base}${path}`, { ...init, headers: { ...json, ...(init.headers ?? {}) } });
const onSocket = (path: string, init: RequestInit = {}) =>
  fetch(`http://board${path}`, {
    ...init,
    unix: boardSocketPath(socketDir, harborlight),
    headers: { ...json, ...(init.headers ?? {}) },
  });

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

async function leadBind(folderPath: string, extra: Record<string, unknown> = {}) {
  return onSocket('/workspaces', {
    method: 'POST',
    body: JSON.stringify({ folderPath, hubWorkspaceId: harborlight, ...extra }),
  });
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

/** The lead's whole-doc rewrite, posted on its own socket. */
async function leadRewrite(docId: string, markdown: string): Promise<Response> {
  return onSocket(`/workspaces/${harborlight}/docs/${encodeURIComponent(docId)}/content`, {
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
  riverbend = await board('Riverbend');
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

describe('a lead’s bind after the bind', () => {
  it('serves nothing through a root swapped for a link out of the roots', async () => {
    const root = project('harbor-swap');
    await setRoots([root]);
    const bound = await leadBind(root);
    expect(bound.status, await bound.clone().text()).toBe(200);
    const { setId } = (await bound.json()) as { setId: string };
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
    const bound = await leadBind(root);
    expect(bound.status, await bound.clone().text()).toBe(200);
    const { setId } = (await bound.json()) as { setId: string };
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
    const bound = await leadBind(root);
    expect(bound.status, await bound.clone().text()).toBe(200);
    const { setId } = (await bound.json()) as { setId: string };
    const docId = await openEditable(setId, 'sub/plan.md');

    // The control: before the swap the rewrite reaches the file on disk.
    const first = await leadRewrite(docId, '# harbor plan\n\nFirst pass.\n');
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
    await leadRewrite(docId, '# harbor plan\n\nSecond pass.\n');
    // The refusal reports itself on the doc rather than failing quietly.
    const said = await waitFor(() => h.docStore.getSyncError(docId), {
      describe: 'the refused write-back reported on the doc',
    });
    expect(JSON.stringify(said)).toContain('Not saved to disk');
    expect(existsSync(join(outside, 'plan.md'))).toBe(false);
    expect(readdirSync(outside)).toEqual([]);
  }, 30_000);

  it('stops serving a root dropped from the board’s list', async () => {
    const root = project('harbor-dropped');
    await setRoots([root]);
    const bound = await leadBind(root);
    expect(bound.status, await bound.clone().text()).toBe(200);
    const { setId } = (await bound.json()) as { setId: string };
    expect((await openFile(setId, 'notes.md')).status).toBe(200);
    await setRoots([]);
    expect((await openFile(setId, 'later.md')).status).not.toBe(200);
  }, 30_000);
});

describe('the guard holds only the lead’s own sets', () => {
  it('leaves a set the owner bound on the same folder alone', async () => {
    const root = project('harbor-owner');
    await setRoots([root]);
    const lead = await leadBind(root);
    expect(lead.status, await lead.clone().text()).toBe(200);
    const leadSet = ((await lead.json()) as { setId: string }).setId;
    const owner = await tcp('/workspaces', {
      method: 'POST',
      body: JSON.stringify({ folderPath: root, hubWorkspaceId: harborlight }),
    });
    expect(owner.status, await owner.clone().text()).toBe(200);
    const ownerSet = ((await owner.json()) as { setId: string }).setId;
    expect(ownerSet).not.toBe(leadSet);

    await setRoots([]);
    expect((await openFile(leadSet, 'notes.md')).status).not.toBe(200);
    // The control is the refusal above; the owner's set on the same file serves.
    const ownerOpen = await openFile(ownerSet, 'notes.md');
    expect(ownerOpen.status, await ownerOpen.clone().text()).toBe(200);
  }, 30_000);

  it('sets a lead’s record aside when its set is archived, and back on unarchive', async () => {
    const root = project('harbor-archived');
    await setRoots([root]);
    const lead = await leadBind(root);
    expect(lead.status, await lead.clone().text()).toBe(200);
    const setId = ((await lead.json()) as { setId: string }).setId;
    const recorded = () =>
      JSON.parse(readFileSync(boardSocketRootsPath(dataDir), 'utf8')) as {
        binds: Record<string, unknown>;
        archived: Record<string, unknown>;
      };
    expect(Object.keys(recorded().binds)).toContain(setId);

    const at = `/workspaces/${harborlight}/attachments/${encodeURIComponent(setId)}`;
    const archived = await tcp(`${at}/archive`, { method: 'POST', body: '{}' });
    expect(archived.status, await archived.clone().text()).toBe(200);
    expect(Object.keys(recorded().binds)).not.toContain(setId);
    expect(Object.keys(recorded().archived)).toContain(setId);

    const back = await tcp(`${at}/unarchive`, { method: 'POST', body: '{}' });
    expect(back.status, await back.clone().text()).toBe(200);
    expect(Object.keys(recorded().binds)).toContain(setId);
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
    const bound = await leadBind(root);
    expect(bound.status, await bound.clone().text()).toBe(200);
    const { setId, listed } = (await bound.json()) as { setId: string; listed: string[] };
    // Listed by a walk, since no git runs here.
    expect(listed).toEqual(['later.md', 'notes.md']);
    const opened = await openFile(setId, 'notes.md');
    expect(opened.status, await opened.clone().text()).toBe(200);
    expect(existsSync(marker)).toBe(false);
  }, 30_000);
});

describe('links at the bind, and media after it', () => {
  it('refuses a root holding a link out of it, and keeps one that stays inside', async () => {
    const root = project('harbor-links');
    symlinkSync('notes.md', join(root, 'notes-link.md'));
    // A package manager's links are its own: node_modules is skipped here,
    // and every path under it is refused when read or written.
    mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true });
    symlinkSync(secrets, join(root, 'node_modules', '.bin', 'tool'));
    await setRoots([root]);
    // The control: a relative link that stays inside binds.
    const kept = await leadBind(root);
    expect(kept.status, await kept.clone().text()).toBe(200);
    symlinkSync(secrets, join(root, 'keys'));
    const refused = await leadBind(root, { exclude: ['later.md'] });
    expect(refused.status).toBe(403);
    expect(await refused.text()).toContain('a link that leads out of it');
  }, 30_000);

  it('refuses a link that climbs, because moving its folder moves where it lands', async () => {
    const root = project('harbor-climb');
    mkdirSync(join(root, 'deep'));
    // Inside today: deep/up -> ../notes.md. Rename deep's parent and it is not.
    symlinkSync('../notes.md', join(root, 'deep', 'up.md'));
    await setRoots([root]);
    const refused = await leadBind(root);
    expect(refused.status).toBe(403);
    expect(await refused.text()).toContain('a link that leads out of it');
  }, 30_000);

  it('serves a lead’s media from the file it checked, and nothing through a swapped folder', async () => {
    const root = project('harbor-media');
    mkdirSync(join(root, 'shots'));
    writeFileSync(join(root, 'shots', 'first.png'), 'harbor-png-first');
    writeFileSync(join(root, 'shots', 'later.png'), 'harbor-png-later');
    writeFileSync(join(secrets, 'later.png'), 'riverbend-png');
    await setRoots([root]);
    const bound = await leadBind(root);
    expect(bound.status, await bound.clone().text()).toBe(200);
    const { setId } = (await bound.json()) as { setId: string };
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

describe('a lead’s bind is held to its own board', () => {
  it('is refused when its set is filed on another board', async () => {
    const root = project('harbor-shared');
    await setRoots([root]);
    const first = await leadBind(root);
    expect(first.status, await first.clone().text()).toBe(200);
    const { setId } = (await first.json()) as { setId: string };
    // An operator files the same set on Riverbend too.
    const filed = await tcp(`/workspaces/${riverbend}/docs:attach`, {
      method: 'POST',
      body: JSON.stringify({ docId: setId }),
    });
    expect(filed.status, await filed.clone().text()).toBe(200);
    const again = await leadBind(root, { exclude: ['notes.md'] });
    expect(again.status).toBe(403);
    expect(await again.text()).toContain('another board');
  }, 30_000);

  it('bounds maxFiles', async () => {
    const root = project('harbor-max');
    await setRoots([root]);
    expect((await leadBind(root, { maxFiles: 1_000_000_000 })).status).toBe(403);
    expect((await leadBind(root, { maxFiles: 'all' })).status).toBe(403);
    const ok = await leadBind(root, { maxFiles: 100 });
    expect(ok.status, await ok.clone().text()).toBe(200);
  }, 30_000);
});
