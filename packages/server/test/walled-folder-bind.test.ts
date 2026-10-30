/**
 * A walled lead binds its own registered root over its board's socket, and
 * the bind, the listing, the folder watch and the rewrite that follow go
 * through `tree-fs.ts`: the root holds a link out of it, a hard link to an
 * outside file, a FIFO and an include through a linked folder, and none of
 * them shows an outside name or byte. The lead's rewrite of a file in the
 * set reaches the disk (the control), and the same rewrite after a folder on
 * its way is swapped for a link writes nothing outside and says so on the
 * doc.
 *
 * Each refusal checks an "outside" canary folder is unchanged. macOS only:
 * the contained calls are, and a walled lead is. Fixtures synthetic.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  linkSync,
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
import { boardSocketPath } from '../src/board-sockets.ts';
import { folderListing } from '../src/folder-watch.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { setTreeSeamForTest } from '../src/tree-fs.ts';
import { makeFifo } from './fifo.ts';
import { waitFor } from './wait-for.ts';

const CANARY = 'saltmarsh-canary-41d2';
let h: ServerHandle;
let dataDir: string;
let workDir: string;
let socketRoot: string;
let socketDir: string;
let base: string;
let harborlight: string;
let root: string;
let outside: string;

const json = { 'content-type': 'application/json' };
const tcp = (path: string, init: RequestInit = {}) =>
  fetch(`${base}${path}`, { ...init, headers: { ...json, ...(init.headers ?? {}) } });
const onSocket = (path: string, init: RequestInit = {}) =>
  fetch(`http://board${path}`, {
    ...init,
    unix: boardSocketPath(socketDir, harborlight),
    headers: { ...json, ...(init.headers ?? {}) },
  } as RequestInit);

function canary(): string {
  return JSON.stringify(
    readdirSync(outside)
      .sort()
      .map((name) => [name, readFileSync(join(outside, name), 'utf8')]),
  );
}

describe.skipIf(process.platform !== 'darwin')('a walled lead’s own folder bind', () => {
  let setId: string;
  let bindBody: string;
  let before: string;
  const judged: string[] = [];

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'walled-bind-'));
    workDir = realpathSync(mkdtempSync(join(tmpdir(), 'walled-bind-work-')));
    socketRoot = mkdtempSync('/private/tmp/wfb-');
    socketDir = join(socketRoot, 'boards');
    h = createServer({ port: 0, dataDir, boardSocketDir: socketDir });
    base = `http://127.0.0.1:${h.port}`;
    const made = await tcp('/workspaces', {
      method: 'POST',
      body: JSON.stringify({ name: 'Harborlight' }),
    });
    harborlight = ((await made.json()) as { workspace: { id: string } }).workspace.id;

    root = join(workDir, 'harbor-project');
    outside = join(workDir, 'riverbend-keys');
    mkdirSync(join(root, 'docs'), { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(outside, 'secret.md'), CANARY);
    writeFileSync(join(root, 'docs', 'plan.md'), '# Harborlight plan\n');
    symlinkSync(outside, join(root, 'out'));
    linkSync(join(outside, 'secret.md'), join(root, 'docs', 'hard.md'));
    makeFifo(join(root, 'docs', 'pipe.md'));
    before = canary();

    const roots = await tcp(`/api/board-sockets/${harborlight}/roots`, {
      method: 'PUT',
      body: JSON.stringify({ roots: [root] }),
    });
    expect(roots.status, await roots.clone().text()).toBe(200);
    // Every descriptor `tree-fs.ts` judges, so a case can show it was the
    // contained walk that answered and not a plain one.
    setTreeSeamForTest((c) => judged.push(c.abs));
    const bound = await onSocket('/workspaces', {
      method: 'POST',
      body: JSON.stringify({
        folderPath: root,
        hubWorkspaceId: harborlight,
        include: ['out/secret.md'],
      }),
    });
    bindBody = await bound.text();
    expect(bound.status, bindBody).toBe(200);
    setId = (JSON.parse(bindBody) as { setId: string }).setId;
  });

  afterAll(async () => {
    setTreeSeamForTest(null);
    await h.stop();
    for (const d of [dataDir, workDir, socketRoot]) rmSync(d, { recursive: true, force: true });
  });

  it('lists the plain file, and nothing behind a link, a FIFO or the linked include', async () => {
    const bound = JSON.parse(bindBody) as {
      listed: string[];
      skipped: Array<{ path: string; reason: string }>;
    };
    expect(bound.listed).toContain('docs/plan.md');
    expect(bound.listed.some((p) => p.startsWith('out') || p.includes('pipe'))).toBe(false);
    expect(bound.skipped).toContainEqual({ path: 'out', reason: 'not-a-regular-file' });
    expect(bound.skipped).toContainEqual({ path: 'out/secret.md', reason: 'not-a-regular-file' });
    expect(bound.skipped).toContainEqual({ path: 'docs/pipe.md', reason: 'not-a-regular-file' });
    const tree = await tcp(
      `/workspaces/${harborlight}/attachments/${encodeURIComponent(setId)}/tree`,
    );
    expect(await tree.text()).not.toContain('secret');
    expect(bindBody).not.toContain(CANARY);
    expect(canary()).toBe(before);
    expect(judged).toContain(join(root, 'docs'));
  });

  it('never serves the hard-linked file’s bytes', async () => {
    const res = await tcp(
      `/workspaces/${harborlight}/attachments/${encodeURIComponent(setId)}/context-file`,
      { method: 'POST', body: JSON.stringify({ relPath: 'docs/hard.md' }) },
    );
    expect(await res.text()).not.toContain(CANARY);
  });

  it('the folder watch’s own listing names nothing behind a link', async () => {
    judged.length = 0;
    const listed = await folderListing(root);
    expect(judged).toContain(join(root, 'docs'));
    expect(listed && [...listed].sort()).toEqual(['docs/hard.md', 'docs/plan.md']);
  });

  it('a rewrite reaches the file, and after a swap writes nothing outside', async () => {
    const opened = await tcp(
      `/workspaces/${harborlight}/attachments/${encodeURIComponent(setId)}/editable-file`,
      { method: 'POST', body: JSON.stringify({ relPath: 'docs/plan.md' }) },
    );
    expect(opened.status, await opened.clone().text()).toBe(200);
    const docId = ((await opened.json()) as { docId: string }).docId;
    const rewrite = (markdown: string) =>
      onSocket(`/workspaces/${harborlight}/docs/${encodeURIComponent(docId)}/content`, {
        method: 'POST',
        body: JSON.stringify({ markdown, confirmOverwriteHumanEdits: true }),
      });

    const first = await rewrite('# Harborlight plan\n\nFirst pass.\n');
    expect(first.status, await first.clone().text()).toBe(200);
    await waitFor(
      () => readFileSync(join(root, 'docs', 'plan.md'), 'utf8').includes('First pass.'),
      {
        describe: 'the lead’s rewrite written back to its file',
      },
    );

    renameSync(join(root, 'docs'), join(root, 'docs.moved'));
    symlinkSync(outside, join(root, 'docs'));
    await rewrite('# Harborlight plan\n\nSecond pass.\n');
    const said = await waitFor(() => h.docStore.getSyncError(docId), {
      describe: 'the refused write-back reported on the doc',
    });
    expect(JSON.stringify(said)).toContain('Not saved to disk');
    expect(canary()).toBe(before);
  }, 30_000);
});
