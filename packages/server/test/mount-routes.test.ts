/**
 * The mount routes, driven through the real server, plus the two refusals a
 * real socket cannot produce.
 *
 * The store's own tests prove the address and the move. What only a route can
 * prove is that the table is unreachable from off the box, that a share
 * visitor is refused, that a `local-only` project's bytes stop at the edge
 * while an ordinary project's do not, and that a credential-shaped name has
 * no address to ask for in the first place.
 *
 * The non-loopback case is driven against `handleMountRoutes` directly with a
 * stubbed socket address, because a `fetch` to the test server always arrives
 * on 127.0.0.1 — the same shape `repo-routes.test.ts` uses for its gate.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ShareTarget } from '../src/middleware/host-guard.ts';
import { MountStore } from '../src/mount-store.ts';
import { RepoRegistry } from '../src/repo-registry.ts';
import { type MountRoutesContext, handleMountRoutes } from '../src/routes/mounts.ts';
import { type ServerHandle, createServer } from '../src/server.ts';

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))),
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.invalid',
    },
  });
}

describe('mount routes', () => {
  let handle: ServerHandle | null = null;
  let tmp: string;
  let repo: string;
  let dataDir: string;
  let base: string;

  const mocks = () => join(repo, 'docs', 'mocks');

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'cw-mount-routes-')));
    dataDir = join(tmp, 'data');
    mkdirSync(dataDir);
    repo = join(tmp, 'widgets');
    mkdirSync(repo);
    git(repo, 'init', '-b', 'main');
    git(repo, 'remote', 'add', 'origin', 'git@github.example:example/widgets.git');
    mkdirSync(mocks(), { recursive: true });
    writeFileSync(join(mocks(), 'home.png'), 'round-one-bytes');
    writeFileSync(join(mocks(), '.env'), 'SAMPLE_TOKEN=not-a-real-value\n');
    writeFileSync(join(mocks(), 'notes.md'), '# Round one\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'init');
    handle = createServer({ port: 0, dataDir, requireSignInToWrite: false });
    base = `http://localhost:${handle.port}`;
  });

  afterEach(async () => {
    await handle?.stop();
    handle = null;
    rmSync(tmp, { recursive: true, force: true });
  });

  const send = (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: {
        host: `localhost:${handle?.port ?? 0}`,
        'content-type': 'application/json',
        ...((init.headers as Record<string, string>) ?? {}),
      },
    });

  const mount = async (path: string) => {
    const r = await send('/api/mounts', { method: 'POST', body: JSON.stringify({ path }) });
    expect(r.status).toBe(200);
    return (await r.json()) as { mountId: string; repoKey: string; fileCount: number };
  };

  const fileId = async (relPath: string): Promise<string> => {
    const r = await send(`/api/mounts/files?path=${encodeURIComponent(repo)}&limit=1000`);
    const body = (await r.json()) as { files: Array<{ fileId: string; relPath: string }> };
    const found = body.files.find((f) => f.relPath === relPath);
    if (!found) throw new Error(`no address for ${relPath}: ${JSON.stringify(body.files)}`);
    return found.fileId;
  };

  describe('mounting', () => {
    it('mounts a folder and counts what it will serve', async () => {
      const res = await mount(mocks());
      expect(res.mountId).toStartWith('m-');
      // Two files, not three: `.env` is refused at the listing.
      expect(res.fileCount).toBe(2);
    });

    it('is idempotent, and refuses a path that is not in a repo', async () => {
      const first = await mount(mocks());
      const again = await mount(mocks());
      expect(again.mountId).toBe(first.mountId);

      const outside = join(tmp, 'loose');
      mkdirSync(outside);
      const bad = await send('/api/mounts', {
        method: 'POST',
        body: JSON.stringify({ path: outside }),
      });
      expect(bad.status).toBe(400);
      expect(((await bad.json()) as { error: string }).error).toBe('not-a-repo');
    });

    it('refuses a relative path, a non-string and a NUL', async () => {
      for (const path of ['widgets/docs', 42, `${mocks()}\x00/x`]) {
        const r = await send('/api/mounts', { method: 'POST', body: JSON.stringify({ path }) });
        expect(r.status).toBe(400);
      }
      const list = (await (await send('/api/mounts')).json()) as { projects: unknown[] };
      expect(list.projects).toHaveLength(0);
    });
  });

  describe('an address', () => {
    it('serves the bytes, and the same address serves the new ones after a rewrite', async () => {
      await mount(mocks());
      const id = await fileId('docs/mocks/home.png');

      const first = await send(`/mounts/${id}/raw`);
      expect(first.status).toBe(200);
      expect(first.headers.get('content-type')).toBe('image/png');
      expect(await first.text()).toBe('round-one-bytes');

      writeFileSync(join(mocks(), 'home.png'), 'round-two');
      const second = await send(`/mounts/${id}/raw`);
      expect(await second.text()).toBe('round-two');
      // Same address, new bytes, and the validator moved with them.
      expect(second.headers.get('etag')).not.toBe(first.headers.get('etag'));
    });

    it('describes the file without its host path', async () => {
      await mount(mocks());
      const id = await fileId('docs/mocks/notes.md');
      const body = (await (await send(`/mounts/${id}`)).json()) as Record<string, unknown>;
      expect(body.relPath).toBe('docs/mocks/notes.md');
      expect(body.name).toBe('notes.md');
      expect(body.rawUrl).toBe(`/mounts/${id}/raw`);
      expect(JSON.stringify(body)).not.toContain(tmp);
    });

    it('serves an unrecognised type as an attachment rather than a page', async () => {
      writeFileSync(join(mocks(), 'report.html'), '<script>alert(1)</script>');
      await mount(mocks());
      const r = await send(`/mounts/${await fileId('docs/mocks/report.html')}/raw`);
      expect(r.headers.get('content-type')).toBe('application/octet-stream');
      expect(r.headers.get('content-disposition')).toStartWith('attachment');
      expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    });

    it('404s an address nobody minted, and a path under one', async () => {
      await mount(mocks());
      expect((await send('/mounts/f-nope')).status).toBe(404);
      const id = await fileId('docs/mocks/home.png');
      expect((await send(`/mounts/${id}/raw/extra`)).status).toBe(404);
    });

    it('has no address at all for a credential-shaped name', async () => {
      await mount(mocks());
      const r = await send(`/api/mounts/files?path=${encodeURIComponent(repo)}&limit=1000`);
      const body = (await r.json()) as { files: Array<{ relPath: string }> };
      expect(body.files.map((f) => f.relPath).sort()).toEqual([
        'docs/mocks/home.png',
        'docs/mocks/notes.md',
      ]);
    });
  });

  describe('unmounting', () => {
    it('stops serving the address and leaves every file on disk', async () => {
      const { mountId } = await mount(mocks());
      const id = await fileId('docs/mocks/home.png');
      expect((await send(`/mounts/${id}/raw`)).status).toBe(200);

      const r = await send('/api/mounts', {
        method: 'DELETE',
        body: JSON.stringify({ path: repo, mountId }),
      });
      expect(r.status).toBe(200);
      expect((await r.json()) as { filesLeftOnDisk: boolean }).toMatchObject({
        filesLeftOnDisk: true,
      });
      expect((await send(`/mounts/${id}/raw`)).status).toBe(404);
      // Nothing was destroyed — the bytes are exactly where the project put them.
      expect(await Bun.file(join(mocks(), 'home.png')).text()).toBe('round-one-bytes');

      // And the row is still listed, retired rather than gone.
      const list = (await (await send('/api/mounts')).json()) as {
        projects: Array<{ mounts: Array<{ mountId: string; removedAt?: number }> }>;
      };
      expect(list.projects[0]?.mounts[0]?.mountId).toBe(mountId);
      expect(list.projects[0]?.mounts[0]?.removedAt).toBeGreaterThan(0);
    });
  });

  describe('the conventions index', () => {
    it('defaults to WORKSPACES.md, reads it, and follows where the lead points it', async () => {
      await mount(mocks());
      const q = `?path=${encodeURIComponent(repo)}`;
      const first = (await (await send(`/api/mounts/conventions${q}`)).json()) as {
        relPath: string;
        text: string | null;
      };
      expect(first).toMatchObject({ relPath: 'WORKSPACES.md', text: null });

      writeFileSync(join(repo, 'docs', 'conventions.md'), 'Plans go in docs/plans.\n');
      const put = await send('/api/mounts/conventions', {
        method: 'PUT',
        body: JSON.stringify({ path: repo, conventionsPath: 'docs/conventions.md' }),
      });
      expect(put.status).toBe(200);
      const after = (await (await send(`/api/mounts/conventions${q}`)).json()) as { text: string };
      expect(after.text).toBe('Plans go in docs/plans.\n');
    });

    it('refuses a conventions path that escapes the repo or hides in a dot-directory', async () => {
      await mount(mocks());
      for (const conventionsPath of ['../../etc/passwd', '.ssh/config', '/etc/passwd', '']) {
        const r = await send('/api/mounts/conventions', {
          method: 'PUT',
          body: JSON.stringify({ path: repo, conventionsPath }),
        });
        expect(r.status).toBe(400);
      }
    });
  });

  describe('privacy', () => {
    it('keeps serving a local-only project to a caller on the box', async () => {
      await mount(mocks());
      const id = await fileId('docs/mocks/home.png');
      expect((await send(`/mounts/${id}/raw`)).status).toBe(200);

      const put = await send('/api/mounts/privacy', {
        method: 'PUT',
        body: JSON.stringify({ path: repo, privacy: 'local-only' }),
      });
      expect(put.status).toBe(200);

      // Local-only narrows WHERE the bytes go, not who on the box may read
      // them: a local agent is exactly who the mount is for. The refusal it
      // adds is asserted below, where the caller can be given an address that
      // is not this machine's.
      const still = await send(`/mounts/${id}/raw`);
      expect(still.status).toBe(200);
      expect(await still.text()).toBe('round-one-bytes');
    });

    it('refuses a privacy value that is neither of the two', async () => {
      await mount(mocks());
      const r = await send('/api/mounts/privacy', {
        method: 'PUT',
        body: JSON.stringify({ path: repo, privacy: 'public' }),
      });
      expect(r.status).toBe(400);
    });
  });

  describe('a malformed percent-escape in the address', () => {
    /**
     * `serveMountedFile` calls `decodeURIComponent` on the id segment, which
     * throws on `%ZZ`. It never sees one: `malformedPathSegment` answers 400
     * at the front door, above every route (PR 762). That is worth asserting
     * rather than assuming, because the alternative — a try/catch wrapped
     * around each decode — is the thing the front-door guard exists to make
     * unnecessary, and nothing else in this family would notice if it went.
     */
    it('is answered 400 at the front door, not by this family', async () => {
      for (const path of ['/mounts/%ZZ/raw', '/mounts/%', '/mounts/%E0%A4%A/raw']) {
        const r = await send(path);
        expect(r.status, path).toBe(400);
        expect(await r.text(), path).toContain('percent');
      }
      // The control: a WELL-formed address the family does not know is its
      // own 404, so the 400s above are the guard's verdict and not a blanket
      // refusal of anything under `/mounts/`.
      expect((await send('/mounts/f-nothing/raw')).status).toBe(404);
    });
  });

  describe('the table is not reachable from off the box', () => {
    it('refuses a request that came through the edge', async () => {
      const r = await send('/api/mounts', { headers: { 'cf-ray': 'test-ray-3' } });
      expect(r.status).toBe(403);
    });

    it('refuses a browser, which cannot be told from an agent by address alone', async () => {
      const r = await send('/api/mounts', {
        method: 'POST',
        body: JSON.stringify({ path: mocks() }),
        headers: { 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'same-origin' },
      });
      expect(r.status).toBe(403);
    });
  });

  /**
   * The two callers a `fetch` to the test server cannot be: one arriving on a
   * non-loopback socket, and a share visitor. Both are driven through the
   * handler with the context stubbed, which is what makes the gate itself the
   * thing under test rather than the network.
   */
  describe('gates a real socket cannot reach', () => {
    const ctxFor = (address: string): { ctx: MountRoutesContext; store: MountStore } => {
      const store = new MountStore(dataDir, new RepoRegistry(dataDir));
      return {
        store,
        ctx: {
          mounts: store,
          j: (status, body) =>
            new Response(JSON.stringify(body), {
              status,
              headers: { 'content-type': 'application/json' },
            }),
          safeJson: async (req) => (await req.json()) as Record<string, unknown>,
          requestAddress: () => address,
        },
      };
    };

    it('refuses the table to a caller on the tailnet', async () => {
      const { ctx } = ctxFor('100.64.0.7');
      const res = await handleMountRoutes(ctx, {
        req: new Request('http://board.example/api/mounts'),
        pathname: '/api/mounts',
        url: new URL('http://board.example/api/mounts'),
        visitor: null,
      });
      expect(res?.status).toBe(403);
      expect(((await res?.json()) as { error: string }).error).toContain('loopback-only');
    });

    it('refuses a local-only file to a caller on the tailnet, and serves an open one', async () => {
      const { ctx, store } = ctxFor('100.64.0.7');
      const mounted = store.mount(mocks());
      expect(mounted.ok).toBe(true);
      const repoKey = store.locate(repo)?.repoKey ?? '';
      const id = store.reconcile(repoKey, true).files.find((f) => f.relPath.endsWith('home.png'))
        ?.fileId as string;

      const ask = () =>
        handleMountRoutes(ctx, {
          req: new Request(`http://board.example/mounts/${id}/raw`),
          pathname: `/mounts/${id}/raw`,
          url: new URL(`http://board.example/mounts/${id}/raw`),
          visitor: null,
        });

      // The control first: an unmarked project is served off the box.
      expect((await ask())?.status).toBe(200);
      store.setPrivacy(repoKey, 'local-only');
      expect((await ask())?.status).toBe(403);
    });

    it('refuses a local-only file that came through the edge, whatever the socket says', async () => {
      // Loopback socket, but stamped by Cloudflare: the request reached this
      // machine through the tunnel, so the bytes would be leaving it.
      const { ctx, store } = ctxFor('127.0.0.1');
      store.mount(mocks());
      const repoKey = store.locate(repo)?.repoKey ?? '';
      const id = store.reconcile(repoKey, true).files.find((f) => f.relPath.endsWith('home.png'))
        ?.fileId as string;
      const ask = () =>
        handleMountRoutes(ctx, {
          req: new Request(`http://board.example/mounts/${id}/raw`, {
            headers: { 'cf-ray': 'test-ray' },
          }),
          pathname: `/mounts/${id}/raw`,
          url: new URL(`http://board.example/mounts/${id}/raw`),
          visitor: null,
        });

      // The control: the same edge request on a project nobody marked.
      expect((await ask())?.status).toBe(200);
      store.setPrivacy(repoKey, 'local-only');
      const refused = await ask();
      expect(refused?.status).toBe(403);
      expect(((await refused?.json()) as { error: string }).error).toContain('local-only');
    });

    it('refuses a share visitor both the table and every address', async () => {
      const { ctx, store } = ctxFor('127.0.0.1');
      store.mount(mocks());
      const repoKey = store.locate(repo)?.repoKey ?? '';
      const id = store.reconcile(repoKey, true).files.find((f) => f.relPath.endsWith('home.png'))
        ?.fileId as string;
      const visitor = { workspaceId: 'w-other' } as ShareTarget;

      for (const pathname of ['/api/mounts', `/mounts/${id}`, `/mounts/${id}/raw`]) {
        const res = await handleMountRoutes(ctx, {
          req: new Request(`http://share.example${pathname}`),
          pathname,
          url: new URL(`http://share.example${pathname}`),
          visitor,
        });
        expect(res?.status).toBe(403);
      }
    });
  });
});
