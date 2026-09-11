/**
 * The Library's real routes, against a real git repo: what the listing shows,
 * what the open verb will and will not bind, and what a share visitor is
 * refused. Every refusal is paired with a positive control on the same server
 * — a listed file opens — so a 404 cannot be a listing that never built.
 *
 * The pure build over hand-made sources is `library.test.ts` beside this.
 *
 * All fixtures synthetic.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type LibraryPayload, createMarkdownLister } from '../src/library.ts';
import type { ShareTarget } from '../src/middleware/host-guard.ts';
import { MountStore } from '../src/mount-store.ts';
import { RepoRegistry } from '../src/repo-registry.ts';
import { type LibraryRoutesContext, handleLibraryRoutes } from '../src/routes/workspace-library.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
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

describe('library routes', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let repo: string;
  let WS = '';

  const at = (path: string, init: RequestInit = {}) =>
    fetch(`http://127.0.0.1:${handle.port}${path}`, {
      ...init,
      headers: { host: `localhost:${handle.port}`, 'content-type': 'application/json' },
    });
  const items = async (): Promise<LibraryPayload> => {
    const res = await at(`/workspaces/${WS}/library/items`);
    expect(res.status).toBe(200);
    return (await res.json()) as LibraryPayload;
  };
  const open = (path: string) =>
    at(`/workspaces/${WS}/library/open`, { method: 'POST', body: JSON.stringify({ path }) });

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'library-data-'));
    repo = mkdtempSync(join(tmpdir(), 'library-repo-'));
    git(repo, 'init', '-q');
    writeFileSync(join(repo, '.gitignore'), 'private/\n');
    writeFileSync(join(repo, 'handbook.md'), '# Volunteer handbook\n');
    mkdirSync(join(repo, 'docs'));
    writeFileSync(join(repo, 'docs', 'tide-gauge.md'), '# Tide gauge\n');
    mkdirSync(join(repo, 'private'));
    writeFileSync(join(repo, 'private', 'hidden.md'), 'FIXTURE_MARKER\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'base');
    handle = createServer({ port: 0, dataDir });
    WS = await seedBoard(`http://127.0.0.1:${handle.port}`);
    const bound = await at(`/workspaces/${WS}/docs`, {
      method: 'POST',
      body: JSON.stringify({
        docId: 'handbook',
        type: 'markdown',
        sourceUrl: join(repo, 'handbook.md'),
        title: 'Volunteer handbook',
      }),
    });
    expect(bound.status).toBe(200);
  });

  afterEach(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
    rmSync(`${repo}-side`, { recursive: true, force: true });
  });

  it('lists the bound doc and the unbound project file, and nothing git ignores', async () => {
    const lib = await items();
    expect(lib.project?.name).toBeTruthy();
    const byName = new Map(lib.files.map((f) => [f.name, f]));
    expect(byName.get('Volunteer handbook')?.href).toMatch(/^\/workspaces\/[^/]+\/docs\//);
    expect(byName.get('tide-gauge.md')?.open).toBe('docs/tide-gauge.md');
    expect(lib.files.some((f) => f.name.includes('hidden'))).toBe(false);
  });

  it('lists a discussion huddle under meetings', async () => {
    const huddle = await at(`/workspaces/${WS}/huddles`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'discussion' }),
    });
    expect(huddle.status).toBe(200);
    const lib = await items();
    expect(lib.meetings).toHaveLength(1);
  });

  it('opens a listed file into a doc on this board, once', async () => {
    const first = await open('docs/tide-gauge.md');
    expect(first.status).toBe(200);
    const { docId, href } = (await first.json()) as { docId: string; href: string };
    expect(href).toBe(`/workspaces/${WS}/docs/${docId}`);
    // The page it names answers, so the tap lands on a doc rather than a 404.
    const page = await at(`/workspaces/${WS}/docs/${encodeURIComponent(docId)}?format=json`);
    expect(page.status).toBe(200);
    // Now it is the board's doc: listed once, as a doc, and a second open
    // of the same path is refused rather than minting a twin.
    const lib = await items();
    const rows = lib.files.filter((f) => f.href === href || f.open === 'docs/tide-gauge.md');
    expect(rows).toEqual([expect.objectContaining({ href })]);
    expect((await open('docs/tide-gauge.md')).status).toBe(404);
  });

  it('opens a mounted file from the checkout its mount recorded', async () => {
    // A second working copy of the same project, holding a file the main
    // checkout does not have. Only the mount lists it, so only the mount
    // knows which bytes the path means.
    const side = `${repo}-side`;
    git(repo, 'worktree', 'add', '-q', side, '-b', 'side');
    mkdirSync(join(side, 'notes'));
    writeFileSync(join(side, 'notes', 'survey.md'), '# Saltmarsh survey\n\nSide-checkout copy.\n');
    const mounted = await at('/api/mounts', {
      method: 'POST',
      body: JSON.stringify({ path: join(side, 'notes') }),
    });
    expect(mounted.status).toBe(200);

    const lib = await items();
    expect(lib.files.some((f) => f.open === 'notes/survey.md')).toBe(true);
    // Positive control on the same server: the main checkout's own file opens.
    expect((await open('docs/tide-gauge.md')).status).toBe(200);

    const res = await open('notes/survey.md');
    expect(res.status).toBe(200);
    const { docId } = (await res.json()) as { docId: string };
    const page = await at(`/workspaces/${WS}/docs/${encodeURIComponent(docId)}?format=json`);
    expect(page.status).toBe(200);
    const doc = (await page.json()) as { meta: { sourceUrl?: string } };
    // The bytes bound are the side checkout's. Joining the path to the MAIN
    // checkout instead would bind a file that is not there at all.
    expect(doc.meta.sourceUrl).toBe(realpathSync(join(side, 'notes', 'survey.md')));
    expect(readFileSync(join(side, 'notes', 'survey.md'), 'utf8')).toContain('Side-checkout copy.');
  });

  /**
   * The two callers a `fetch` to the test server cannot be: a share visitor,
   * and somebody arriving on a socket that is not this machine. Both are
   * driven through `handleLibraryRoutes` with the context stubbed — the same
   * shape `mount-routes.test.ts` uses — because a fetch here always arrives
   * on 127.0.0.1 as the board's owner, and a `cf-ray` header on a localhost
   * Host is refused by the host guard long before this handler.
   */
  describe('gates a real socket cannot reach', () => {
    const ctxFor = (address: string): LibraryRoutesContext => ({
      docStore: handle.docStore,
      taskStore: handle.tasks,
      taskProjection: handle.projection,
      mounts: new MountStore(dataDir, new RepoRegistry(dataDir)),
      dataDir,
      j: (status, body) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      safeJson: async (r) => (await r.json()) as Record<string, unknown>,
      unfileFromDefault: () => {},
      markdownFiles: createMarkdownLister(),
      requestAddress: () => address,
    });
    const scopeFor = (rest: string) => {
      const board = handle.tasks.getWorkspace(WS);
      if (!board) throw new Error('no board');
      return { workspaceId: WS, rest, board };
    };
    const ask = (ctx: LibraryRoutesContext, rest: string, visitor: ShareTarget | null) =>
      handleLibraryRoutes(ctx, {
        scope: scopeFor(rest),
        req: new Request(`http://board.example/workspaces/${WS}/${rest}`, {
          ...(rest === 'library/open'
            ? { method: 'POST', body: JSON.stringify({ path: 'docs/tide-gauge.md' }) }
            : {}),
        }),
        visitor,
      });

    it('refuses a share visitor both the list and the open verb', async () => {
      const ctx = ctxFor('127.0.0.1');
      const visitor = { workspaceId: WS } as ShareTarget;
      for (const rest of ['library/items', 'library/open']) {
        // Positive control on the same context: the owner is answered.
        expect((await ask(ctx, rest, null))?.status).toBe(200);
        expect((await ask(ctx, rest, visitor))?.status).toBe(403);
      }
    });

    it('lists a local-only project on the box and not a file of it off the box', async () => {
      const priv = await at('/api/mounts/privacy', {
        method: 'PUT',
        body: JSON.stringify({ path: repo, privacy: 'local-only' }),
      });
      expect(priv.status).toBe(200);

      const onBox = (await (await ask(ctxFor('127.0.0.1'), 'library/items', null))?.json()) as
        | LibraryPayload
        | undefined;
      expect(onBox?.project?.name).toBeTruthy();
      expect(onBox?.files.some((f) => f.open === 'docs/tide-gauge.md')).toBe(true);

      // Off the box the project's file NAMES are the first thing that would
      // leave: the page falls back to the docs already filed on the board.
      const away = (await (await ask(ctxFor('100.64.0.7'), 'library/items', null))?.json()) as
        | LibraryPayload
        | undefined;
      expect(away?.project).toBeNull();
      expect(away?.files.some((f) => f.open !== undefined)).toBe(false);
      expect(away?.files.map((f) => f.name)).toEqual(['Volunteer handbook']);
      // And the verb refuses what the listing no longer offers.
      expect((await ask(ctxFor('100.64.0.7'), 'library/open', null))?.status).toBe(404);
    });
  });

  it('refuses a path the listing does not offer', async () => {
    // Positive control on the same server: a listed path opens.
    expect((await open('docs/tide-gauge.md')).status).toBe(200);
    expect((await open('private/hidden.md')).status).toBe(404);
    expect((await open('../outside.md')).status).toBe(404);
    expect((await open('handbook.md')).status).toBe(404);
    expect((await open('')).status).toBe(400);
  });
});
