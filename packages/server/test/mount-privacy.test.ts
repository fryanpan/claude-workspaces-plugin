/**
 * Privacy one MOUNTED FOLDER at a time: the verbs that set it, and what a
 * caller off the box reaches once it is set.
 *
 * The project-wide switch and every other gate on this family are in
 * `mount-routes.test.ts` beside this. What is here is only the narrowing a
 * project needs when one of its folders holds an outside party's material
 * and a dozen others hold nothing: that the marked folder is refused, that
 * its harmless neighbours are not, that a project which sets nothing reaches
 * exactly what it did, and that the narrower of the two settings wins so a
 * project shut over everything cannot be reopened a folder at a time.
 *
 * The off-box caller is driven through `handleMountRoutes` with a stubbed
 * socket address, because a `fetch` to the test server always arrives on
 * 127.0.0.1 — the same shape `mount-routes.test.ts` uses. A share visitor is
 * refused every mount address outright, so the reach this setting decides is
 * a signed-in member's over the tunnel or the tailnet.
 *
 * All fixtures invented.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

describe('per-mount privacy', () => {
  let handle: ServerHandle | null = null;
  let tmp: string;
  let repo: string;
  let dataDir: string;
  let base: string;

  const mocks = () => join(repo, 'docs', 'mocks');

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'cw-mount-privacy-')));
    dataDir = join(tmp, 'data');
    mkdirSync(dataDir);
    repo = join(tmp, 'widgets');
    mkdirSync(repo);
    git(repo, 'init', '-b', 'main');
    git(repo, 'remote', 'add', 'origin', 'git@github.example:example/widgets.git');
    mkdirSync(mocks(), { recursive: true });
    writeFileSync(join(mocks(), 'home.png'), 'round-one-bytes');
    writeFileSync(join(mocks(), 'notes.md'), '# Round one\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'init');
    handle = createServer({ port: 0, dataDir, requireSignInToWrite: false });
    base = `http://127.0.0.1:${handle.port}`;
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

  describe('setting it', () => {
    it('sets one mount, reports what it is served against, and survives a re-mount', async () => {
      const { mountId } = await mount(mocks());
      const put = await send('/api/mounts/privacy', {
        method: 'PUT',
        body: JSON.stringify({ path: repo, mountId, privacy: 'local-only' }),
      });
      expect(put.status).toBe(200);
      expect(await put.json()).toMatchObject({
        mountId,
        privacy: 'local-only',
        effectivePrivacy: 'local-only',
      });
      // The project itself was not touched: the whole point is that its other
      // folders stay as open as they were.
      const table = async () =>
        (await (await send('/api/mounts')).json()) as {
          projects: Array<{
            privacy: string;
            mounts: Array<{ mountId: string; privacy?: string; effectivePrivacy: string }>;
          }>;
        };
      expect((await table()).projects[0]?.privacy).toBe('workspace');

      // Unmount and mount again. The row is rebuilt, and a restriction that
      // did not survive that would be one an ordinary re-mount lifts.
      const off = await send('/api/mounts', {
        method: 'DELETE',
        body: JSON.stringify({ path: repo, mountId }),
      });
      expect(off.status).toBe(200);
      await mount(mocks());
      const row = (await table()).projects[0]?.mounts.find((m) => m.mountId === mountId);
      expect(row?.privacy).toBe('local-only');
      expect(row?.effectivePrivacy).toBe('local-only');
    });

    it('takes a privacy on the mount itself, and refuses a bad one before mounting', async () => {
      const bad = await send('/api/mounts', {
        method: 'POST',
        body: JSON.stringify({ path: mocks(), privacy: 'public' }),
      });
      expect(bad.status).toBe(400);
      // Nothing was mounted by the refused call.
      const before = (await (await send('/api/mounts')).json()) as {
        projects: Array<{ mounts: unknown[] }>;
      };
      expect(before.projects[0]?.mounts ?? []).toHaveLength(0);

      const good = await send('/api/mounts', {
        method: 'POST',
        body: JSON.stringify({ path: mocks(), privacy: 'local-only' }),
      });
      expect(good.status).toBe(200);
      expect(await good.json()).toMatchObject({ mountPrivacy: 'local-only' });
    });

    it('refuses a mountId this project does not have', async () => {
      await mount(mocks());
      const r = await send('/api/mounts/privacy', {
        method: 'PUT',
        body: JSON.stringify({ path: repo, mountId: 'm-nothing', privacy: 'local-only' }),
      });
      expect(r.status).toBe(404);
    });
  });

  /**
   * The caller a `fetch` to the test server cannot be: one arriving on a
   * socket that is not this machine. Driven through the handler with the
   * context stubbed, which is what makes the gate itself the thing under test
   * rather than the network.
   */
  describe('what it decides', () => {
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

    const twoMounts = (
      store: MountStore,
    ): { repoKey: string; open: string; shut: string; shutMountId: string } => {
      const saltmarsh = join(repo, 'docs', 'saltmarsh');
      mkdirSync(saltmarsh, { recursive: true });
      writeFileSync(join(saltmarsh, 'survey.png'), 'saltmarsh-bytes');
      expect(store.mount(mocks()).ok).toBe(true);
      const shutMount = store.mount(saltmarsh);
      expect(shutMount.ok).toBe(true);
      const repoKey = store.locate(repo)?.repoKey ?? '';
      const files = store.reconcile(repoKey, true).files;
      const idOf = (name: string) => files.find((f) => f.relPath.endsWith(name))?.fileId as string;
      return {
        repoKey,
        open: idOf('home.png'),
        shut: idOf('survey.png'),
        shutMountId: shutMount.ok ? shutMount.mount.mountId : '',
      };
    };

    const askFor = (ctx: MountRoutesContext, id: string) =>
      handleMountRoutes(ctx, {
        req: new Request(`http://board.example/mounts/${id}/raw`),
        pathname: `/mounts/${id}/raw`,
        url: new URL(`http://board.example/mounts/${id}/raw`),
        visitor: null,
      });

    it('serves the project\u2019s other mounts and refuses the marked one', async () => {
      const { ctx, store } = ctxFor('100.64.0.7');
      const { repoKey, open, shut, shutMountId } = twoMounts(store);

      // The control: before the mark, both folders are served off the box.
      expect((await askFor(ctx, open))?.status).toBe(200);
      expect((await askFor(ctx, shut))?.status).toBe(200);

      store.setMountPrivacy(repoKey, shutMountId, 'local-only');

      expect((await askFor(ctx, shut))?.status).toBe(403);
      // And the harmless folder is still reachable, which is the half a
      // project-wide switch cannot give.
      const still = await askFor(ctx, open);
      expect(still?.status).toBe(200);
      // On the box the marked folder is served as it always was: the
      // setting is about the network, not about who is asking.
      const { ctx: onBox } = ctxFor('127.0.0.1');
      expect((await askFor(onBox, shut))?.status).toBe(200);
    });

    it('leaves a project that sets nothing reaching exactly what it did', async () => {
      const { ctx, store } = ctxFor('100.64.0.7');
      const { open, shut } = twoMounts(store);
      // No per-mount setting anywhere: every address answers off the box,
      // and the metadata beside the bytes does too.
      for (const id of [open, shut]) {
        expect((await askFor(ctx, id))?.status).toBe(200);
        const meta = await handleMountRoutes(ctx, {
          req: new Request(`http://board.example/mounts/${id}`),
          pathname: `/mounts/${id}`,
          url: new URL(`http://board.example/mounts/${id}`),
          visitor: null,
        });
        expect(meta?.status).toBe(200);
      }
    });

    it('refuses a mount set to workspace inside a local-only project', async () => {
      const { ctx, store } = ctxFor('100.64.0.7');
      const { repoKey, open, shut, shutMountId } = twoMounts(store);
      store.setPrivacy(repoKey, 'local-only');
      // The mount asks to be open. The narrower of the two wins, so it is
      // not: a project shut over everything cannot be reopened a folder at
      // a time.
      store.setMountPrivacy(repoKey, shutMountId, 'workspace');
      expect(store.mountPrivacyOf(repoKey, shutMountId)).toBe('local-only');
      expect((await askFor(ctx, shut))?.status).toBe(403);
      expect((await askFor(ctx, open))?.status).toBe(403);
    });
  });
});
