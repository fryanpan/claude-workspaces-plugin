/**
 * `doc-move.ts` driven directly, for the refusals the HTTP suite beside it
 * cannot reach cheaply: a meeting still recording, a share visitor, a doc
 * pinned to a branch, and the path rules one at a time. Each refusal is paired
 * with the same move succeeding once the one condition is lifted.
 *
 * The route end to end — restart, anchor, Library — is `doc-move-routes.test.ts`.
 *
 * All fixtures synthetic.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type DocMoveDeps, cleanRelPath, moveDocToProject } from '../src/doc-move.ts';
import type { ShareTarget } from '../src/middleware/host-guard.ts';
import { MountStore } from '../src/mount-store.ts';
import { type DocMoveRoutesContext, handleDocMoveRoute } from '../src/routes/doc-move.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { rowAt } from './route-row.ts';
import { seedBoard } from './workspace-seed.ts';

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  }).trim();
}

describe('cleanRelPath', () => {
  it('takes a markdown path from the project root and nothing else', () => {
    expect(cleanRelPath('docs/meetings/ferry.md')).toBe('docs/meetings/ferry.md');
    expect(cleanRelPath('README.MD')).toBe('README.MD');
    for (const bad of [
      '',
      '/docs/a.md',
      '../a.md',
      'docs/../a.md',
      'docs/./a.md',
      'docs//a.md',
      'docs/.git/a.md',
      'docs\\a.md',
      'docs/a\u0000.md',
      'docs/a.txt',
      'docs/',
      `${'a/'.repeat(600)}a.md`,
      42,
      null,
    ]) {
      expect(cleanRelPath(bad), String(bad)).toBeNull();
    }
  });
});

describe('moveDocToProject', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let repo: string;
  let WS = '';
  let recording = new Set<string>();

  const send = (method: string, path: string, body?: unknown) =>
    fetch(`http://127.0.0.1:${handle.port}${path}`, {
      method,
      headers: { host: `localhost:${handle.port}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const bind = async (name: string, sourceUrl: string): Promise<string> => {
    const res = await send('POST', `/workspaces/${WS}/docs`, {
      docId: name,
      type: 'markdown',
      sourceUrl,
      title: name,
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const body = (await res.json()) as { meta?: { docId?: string }; docId?: string };
    return String(body.meta?.docId ?? body.docId);
  };
  /** A doc held by Workspaces — its file in the data dir. */
  const held = (name: string): Promise<string> => {
    const file = join(dataDir, 'held', `${name}.md`);
    mkdirSync(join(dataDir, 'held'), { recursive: true });
    writeFileSync(file, `# ${name}\n`);
    return bind(name, file);
  };
  /** Built after the mount, so the store reads the registry the route wrote. */
  const deps = (): DocMoveDeps => ({
    docStore: handle.docStore,
    mounts: new MountStore(dataDir, handle.docStore.repos),
    dataDir,
    isRecording: (docId) => recording.has(docId),
  });
  const board = () => {
    const b = handle.tasks.getWorkspace(WS);
    if (!b) throw new Error('no board');
    return b;
  };

  beforeEach(async () => {
    recording = new Set();
    dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'cw-move-unit-data-')));
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'cw-move-unit-repo-')));
    git(repo, 'init', '-q');
    writeFileSync(join(repo, 'handbook.md'), '# Saltmarsh handbook\n');
    mkdirSync(join(repo, 'docs'));
    writeFileSync(join(repo, 'docs', '.keep'), '');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'base');
    handle = createServer({ port: 0, dataDir });
    WS = await seedBoard(`http://127.0.0.1:${handle.port}`, { name: 'Saltmarsh' });
    await bind('handbook', join(repo, 'handbook.md'));
    const mounted = await send('POST', '/api/mounts', { path: join(repo, 'docs') });
    expect(mounted.status).toBe(200);
  });

  afterEach(async () => {
    await handle.stop();
    for (const dir of [dataDir, repo]) rmSync(dir, { recursive: true, force: true });
  });

  it('refuses a meeting still recording, and moves it once it stops', async () => {
    const docId = await held('tide-meeting');
    recording.add(docId);
    const rq = { workspaceId: WS, board: board(), docId, relPath: 'docs/tide-meeting.md' };
    const refused = moveDocToProject(deps(), rq);
    expect(refused).toMatchObject({ ok: false, error: 'recording' });
    expect(existsSync(join(repo, 'docs', 'tide-meeting.md'))).toBe(false);

    recording.delete(docId);
    expect(moveDocToProject(deps(), rq)).toMatchObject({ ok: true, docId });
    expect(existsSync(join(repo, 'docs', 'tide-meeting.md'))).toBe(true);
  });

  it('refuses a doc pinned to a branch', async () => {
    const docId = await held('pinned-plan');
    const doc = handle.docStore.get(docId);
    if (!doc) throw new Error('no doc');
    doc.meta.docHome = { repoRoot: repo, branch: 'main', relPath: 'docs/pinned-plan.md' };
    const rq = { workspaceId: WS, board: board(), docId, relPath: 'docs/pinned-plan.md' };
    expect(moveDocToProject(deps(), rq)).toMatchObject({ ok: false, error: 'home-pinned' });
    doc.meta.docHome = undefined;
    expect(moveDocToProject(deps(), rq)).toMatchObject({ ok: true });
  });

  it('refuses a doc the board does not hold', async () => {
    const docId = await held('stray-notes');
    const rq = { workspaceId: WS, docId, relPath: 'docs/stray-notes.md' };
    expect(moveDocToProject(deps(), { ...rq, board: { docIds: [] } })).toMatchObject({
      ok: false,
      error: 'not-on-board',
    });
    expect(moveDocToProject(deps(), { ...rq, board: board() })).toMatchObject({ ok: true });
  });

  it('refuses a share visitor at the route, and answers the owner on the same context', async () => {
    const docId = await held('visitor-notes');
    const ctx: DocMoveRoutesContext = {
      ...deps(),
      j: (status, body) => new Response(JSON.stringify(body), { status }),
      safeJson: async () => ({ relPath: 'docs/visitor-notes.md' }),
      isValidDocId: () => true,
    };
    const ask = (visitor: ShareTarget | null) =>
      handleDocMoveRoute(ctx, {
        scope: { workspaceId: WS, rest: `docs/${docId}/move`, board: board() },
        req: new Request(`http://board.example/workspaces/${WS}/docs/${docId}/move`, {
          method: 'POST',
        }),
        row: rowAt('doc-move.ts', `/workspaces/${WS}/docs/${docId}/move`),
        visitor,
      });
    const away = await ask({ workspaceId: WS } as ShareTarget);
    expect(away?.status).toBe(403);
    expect(existsSync(join(repo, 'docs', 'visitor-notes.md'))).toBe(false);
    const owner = await ask(null);
    expect(owner?.status).toBe(200);
    expect(existsSync(join(repo, 'docs', 'visitor-notes.md'))).toBe(true);
  });
});
