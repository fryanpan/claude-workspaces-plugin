/**
 * The repo registry over HTTP, driven through the real server.
 *
 * The unit tests prove the registry and the live-copy rule. They cannot prove
 * anybody can reach them, that the 409 carries a table a person could choose
 * from, or that the gate refuses the callers it is supposed to — every one of
 * those is a property of the route.
 *
 * Fixtures are synthetic: a throwaway git repo with a fictional remote, and a
 * worktree of it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DocStore } from '../src/doc-store.ts';
import type { ShareTarget } from '../src/middleware/host-guard.ts';
import { type RepoRoutesContext, handleRepoRoutes } from '../src/routes/repos.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { SseBus } from '../src/sse.ts';
import { createWebhookDispatcher } from '../src/webhooks.ts';
import { waitFor } from './wait-for.ts';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
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

/** A fixed clock for the fixtures, in seconds: nothing here measures a machine. */
const T0 = 1_788_912_000;
const setMtime = (path: string, epochSeconds: number): void =>
  utimesSync(path, epochSeconds, epochSeconds);

describe('/api/repos', () => {
  let handle: ServerHandle | null = null;
  let tmp: string;
  let main: string;
  let wt: string;
  let base: string;
  let dataDir: string;
  const rel = 'docs/plan.md';

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'cw-repo-routes-')));
    dataDir = join(tmp, 'data');
    mkdirSync(dataDir);
    main = join(tmp, 'repo');
    mkdirSync(main);
    git(main, 'init', '-b', 'main');
    git(main, 'remote', 'add', 'origin', 'git@github.com:example/widgets.git');
    mkdirSync(join(main, 'docs'));
    writeFileSync(join(main, rel), '# Plan\n\nshared\n');
    git(main, 'add', '.');
    git(main, 'commit', '-m', 'init');
    wt = join(tmp, 'wt-feature');
    git(main, 'worktree', 'add', wt, '-b', 'feature');
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

  const register = (path: string) =>
    send('/api/repos/checkouts', { method: 'POST', body: JSON.stringify({ path }) });

  /** A board to file the fixture docs under. */
  const seedBoard = async (): Promise<string> => {
    const r = await send('/workspaces', {
      method: 'POST',
      body: JSON.stringify({ name: 'widgets', goal: 'Keep one doc per repo path.' }),
    });
    expect(r.status).toBe(200);
    return ((await r.json()) as { workspace: { id: string } }).workspace.id;
  };

  /** Bind a doc to a copy of a file, and return the id the server minted. */
  const bindDoc = async (name: string, sourceUrl: string): Promise<string> => {
    const ws = await seedBoard();
    const r = await send(`/workspaces/${ws}/docs`, {
      method: 'POST',
      body: JSON.stringify({ docId: name, type: 'markdown', sourceUrl, hubWorkspaceId: ws }),
    });
    expect(r.status).toBe(200);
    return ((await r.json()) as { docId: string }).docId;
  };

  describe('registering a checkout', () => {
    it('registers a worktree and lists it under the same repo as the main checkout', async () => {
      const a = await register(main);
      expect(a.status).toBe(200);
      const b = await register(wt);
      expect(b.status).toBe(200);
      const first = (await a.json()) as { repoKey: string };
      const second = (await b.json()) as { repoKey: string; alreadyKnown: boolean };
      // The whole point of the row: a worktree is the SAME repo.
      expect(second.repoKey).toBe(first.repoKey);
      expect(second.alreadyKnown).toBe(false);

      const list = (await (await send('/api/repos')).json()) as {
        repos: Array<{ repoKey: string; mainRoot: string; live: string[] }>;
      };
      expect(list.repos).toHaveLength(1);
      expect(list.repos[0]?.mainRoot).toBe(main);
      expect(list.repos[0]?.live.sort()).toEqual([main, wt].sort());
    });

    it('says so a second time rather than pretending the first never happened', async () => {
      await register(wt);
      const again = (await (await register(wt)).json()) as { alreadyKnown: boolean };
      expect(again.alreadyKnown).toBe(true);
    });

    it('refuses a path that is not a checkout, and a path that is not absolute', async () => {
      const notARepo = await register(join(tmp, 'nowhere'));
      expect(notARepo.status).toBe(400);
      expect(((await notARepo.json()) as { error: string }).error).toBe('not-a-repo');

      const relative = await register('repo');
      expect(relative.status).toBe(400);

      const missing = await send('/api/repos/checkouts', {
        method: 'POST',
        body: JSON.stringify({ path: 42 }),
      });
      expect(missing.status).toBe(400);
      // Nothing hostile got as far as the registry.
      const list = (await (await send('/api/repos')).json()) as { repos: unknown[] };
      expect(list.repos).toHaveLength(0);
    });
  });

  describe('which copy is live', () => {
    it('reports the checkout edited most recently', async () => {
      await register(main);
      await register(wt);
      const docId = await bindDoc('plan', join(main, rel));
      writeFileSync(join(wt, rel), '# Plan\n\nedited on the branch\n');
      setMtime(join(main, rel), T0);
      setMtime(join(wt, rel), T0 + 600);

      const r = await send(`/api/repos/live-copy?docId=${docId}`);
      expect(r.status).toBe(200);
      const body = (await r.json()) as { live: string; drift: string[]; driftFirings: number };
      expect(body.live).toBe(join(wt, rel));
      expect(body.drift).toEqual([main]);
      expect(body.driftFirings).toBe(1);
    });

    it('answers 409 with every candidate rather than guessing, then takes the pick', async () => {
      await register(main);
      await register(wt);
      const docId = await bindDoc('plan', join(main, rel));
      writeFileSync(join(wt, rel), '# Plan\n\nbranch edit\n');
      writeFileSync(join(main, rel), '# Plan\n\nmain edit\n');
      setMtime(join(main, rel), T0);
      setMtime(join(wt, rel), T0 + 1);

      const asked = await send(`/api/repos/live-copy?docId=${docId}`);
      expect(asked.status).toBe(409);
      const body = (await asked.json()) as {
        error: string;
        candidates: Array<{ root: string; branch: string | null; sha: string | null }>;
      };
      expect(body.error).toBe('ambiguous-copy');
      // A table a person could actually choose from: both places, and which
      // branch each is on.
      expect(body.candidates.map((c) => c.root).sort()).toEqual([main, wt].sort());
      expect(body.candidates.map((c) => c.branch).sort()).toEqual(['feature', 'main']);

      const picked = await send(
        `/api/repos/live-copy?docId=${docId}&checkout=${encodeURIComponent(wt)}`,
      );
      expect(picked.status).toBe(200);
      expect(((await picked.json()) as { live: string }).live).toBe(join(wt, rel));
    });

    it('answers plainly for a doc with no repo identity, and 400 with no docId', async () => {
      const loose = join(tmp, 'loose.md');
      writeFileSync(loose, '# Loose\n');
      const docId = await bindDoc('loose', loose);
      const r = await send(`/api/repos/live-copy?docId=${docId}`);
      expect(r.status).toBe(200);
      expect(((await r.json()) as { drift: string[] }).drift).toEqual([]);

      expect((await send('/api/repos/live-copy')).status).toBe(400);
    });
  });

  describe('binding a file that has more than one copy', () => {
    it('binds to the live copy rather than the one the caller could see', async () => {
      await register(main);
      await register(wt);
      // The agent works in the worktree and names the copy in front of it;
      // the copy in the main checkout is the one edited most recently.
      writeFileSync(join(main, rel), '# Plan\n\nedited in main\n');
      setMtime(join(wt, rel), T0);
      setMtime(join(main, rel), T0 + 600);
      const ws = await seedBoard();
      const created = await send(`/workspaces/${ws}/docs`, {
        method: 'POST',
        body: JSON.stringify({
          docId: 'plan',
          type: 'markdown',
          sourceUrl: join(wt, rel),
          hubWorkspaceId: ws,
        }),
      });
      expect(created.status).toBe(200);
      const docId = ((await created.json()) as { docId: string }).docId;

      // The binding, not the survey: an edit through the doc has to land in
      // the copy the server chose. Asking `/live-copy` again would only ask
      // the same question twice and would pass against a doc bound to the
      // other file.
      const written = await send(`/workspaces/${ws}/docs/${docId}/content`, {
        method: 'POST',
        body: JSON.stringify({
          markdown: '# Plan\n\nwritten through the doc\n',
          author: { name: 'Tester' },
        }),
      });
      expect(written.status).toBe(200);
      await waitFor(
        () => readFileSync(join(main, rel), 'utf8').includes('written through the doc'),
        { describe: 'the write-back reaching the live copy in the main checkout' },
      );
      // And the copy the caller named is untouched by it.
      expect(readFileSync(join(wt, rel), 'utf8')).not.toContain('written through the doc');
    });

    it('refuses the bind with a candidate table when two copies were edited at once', async () => {
      await register(main);
      await register(wt);
      writeFileSync(join(main, rel), '# Plan\n\nmain edit\n');
      writeFileSync(join(wt, rel), '# Plan\n\nbranch edit\n');
      setMtime(join(main, rel), T0);
      setMtime(join(wt, rel), T0 + 1);
      const ws = await seedBoard();
      const r = await send(`/workspaces/${ws}/docs`, {
        method: 'POST',
        body: JSON.stringify({
          docId: 'plan',
          type: 'markdown',
          sourceUrl: join(main, rel),
          hubWorkspaceId: ws,
        }),
      });
      expect(r.status).toBe(409);
      const body = (await r.json()) as {
        error: string;
        candidates: Array<{ root: string }>;
      };
      expect(body.error).toBe('ambiguous-copy');
      expect(body.candidates.map((c) => c.root).sort()).toEqual([main, wt].sort());

      // And the pick lands: same request, naming the checkout to treat as
      // live. Without this the refusal would be a dead end.
      const picked = await send(`/workspaces/${ws}/docs`, {
        method: 'POST',
        body: JSON.stringify({
          docId: 'plan',
          type: 'markdown',
          sourceUrl: join(main, rel),
          hubWorkspaceId: ws,
          checkout: wt,
        }),
      });
      expect(picked.status).toBe(200);
      const bound = (await picked.json()) as { docId: string; meta: { sourceUrl?: string } };
      expect(bound.meta.sourceUrl).toBe(join(wt, rel));

      // The pick settles the call it was made on; it is not a standing
      // answer. The two copies still disagree, so the next question is asked
      // again — new evidence, not a decision already taken — and nothing is
      // rebound behind anyone's back in the meantime.
      const later = await send(`/api/repos/live-copy?docId=${bound.docId}`);
      expect(later.status).toBe(409);
    });

    it('CONTROL: a bind with one copy is not refused', async () => {
      // Same route, same fixture, one checkout registered: an
      // always-ambiguous bind would stop every ordinary attach dead, and
      // nothing above would notice.
      await register(main);
      const docId = await bindDoc('plan', join(main, rel));
      expect(docId).toMatch(/^d-/);
    });
  });

  describe('the gate', () => {
    /** What a page on another local port sends; the origin policy admits it. */
    const devServerPage = (): Record<string, string> => ({
      origin: 'http://localhost:5173',
      'sec-fetch-site': 'cross-site',
      'sec-fetch-mode': 'cors',
    });

    it('refuses a request that came through the edge', async () => {
      // Positive control first, so a route that refused EVERYTHING could not
      // pass this test.
      expect((await register(main)).status).toBe(200);
      const proxied = await send('/api/repos', { headers: { 'cf-ray': '7b9c0d1e2f3a4b5c-SJC' } });
      expect(proxied.status).toBe(403);
    });

    it('refuses a page on this machine, on read and on write alike', async () => {
      expect((await send('/api/repos', { headers: devServerPage() })).status).toBe(403);
      const write = await send('/api/repos/checkouts', {
        method: 'POST',
        headers: devServerPage(),
        body: JSON.stringify({ path: main }),
      });
      expect(write.status).toBe(403);
      expect(((await write.json()) as { error: string }).error).toBe('browser_cannot_operate');
      // The registry is untouched by the refused write.
      const list = (await (await send('/api/repos')).json()) as { repos: unknown[] };
      expect(list.repos).toHaveLength(0);
    });

    it('answers 405 for a verb it does not have, rather than falling through', async () => {
      const r = await send('/api/repos', { method: 'DELETE' });
      expect(r.status).toBe(405);
    });

    /**
     * The gate, driven at the route itself.
     *
     * Over the wire every one of these requests arrives from loopback with no
     * `cf-ray` and no share cookie, because that is the only kind of request a
     * test can make — which means the wire tests above cannot tell this
     * route's own refusals from the ones the admission layer makes first. Two
     * of the three were proved by nothing until this block existed: deleting
     * the edge check and deleting the loopback check both left the suite
     * green.
     */
    const routeCtx = (over: Partial<RepoRoutesContext> = {}): RepoRoutesContext => {
      const dataDir = mkdtempSync(join(tmp, 'route-unit-'));
      return {
        docStore: new DocStore({
          dataDir,
          sse: new SseBus(),
          webhooks: createWebhookDispatcher({ onLog: () => {} }),
          decorateDocMeta: (m) => ({ ...m }),
        }),
        j: (status: number, body: unknown) => Response.json(body, { status }),
        safeJson: async () => ({}),
        // A loopback socket by default, so nothing else in the gate is doing
        // the work when one refusal is under test.
        requestAddress: () => '127.0.0.1',
        ...over,
      };
    };

    const ask = (
      ctx: RepoRoutesContext,
      opts: { visitor?: ShareTarget | null; headers?: Record<string, string> } = {},
    ) =>
      handleRepoRoutes(ctx, {
        req: new Request('http://localhost/api/repos', { headers: opts.headers ?? {} }),
        pathname: '/api/repos',
        url: new URL('http://localhost/api/repos'),
        visitor: opts.visitor ?? null,
      });

    it('refuses a share visitor even from a loopback socket', async () => {
      // The admission layer refuses a visitor this path before it could ever
      // arrive — `/api/repos` is not on the share allowlist. That is the gate
      // that holds today; this is the belt beside it, and it needs a test of
      // its own or the next person to widen an allowlist prefix opens the
      // registry with everything still green.
      const ctx = routeCtx();
      const refused = await ask(ctx, { visitor: { workspaceId: 'w-somebody' } as ShareTarget });
      expect(refused?.status).toBe(403);
      expect((await ask(ctx))?.status).toBe(200);
    });

    it('refuses a request stamped by the edge', async () => {
      const ctx = routeCtx();
      expect((await ask(ctx, { headers: { 'cf-ray': '7b9c0d1e2f3a4b5c-SJC' } }))?.status).toBe(403);
      expect((await ask(ctx))?.status).toBe(200);
    });

    it('refuses a caller whose socket is not on this machine', async () => {
      const off = routeCtx({ requestAddress: () => '203.0.113.9' });
      expect((await ask(off))?.status).toBe(403);
      // Positive control: the same route, the same everything, from loopback.
      expect((await ask(routeCtx()))?.status).toBe(200);
    });

    it('flushes pending writes BEFORE it retires the checkout', async () => {
      // The order is the whole value of the verb. Retiring first and flushing
      // after would write the edit into a checkout we had already stopped
      // treating as live — and over the wire the two orders are
      // indistinguishable, because both answer 200.
      const ctx = routeCtx({ safeJson: async () => ({ path: wt }) });
      ctx.docStore.repos.registerCheckout(wt);
      const seen: Array<{ roots: string[]; stillRegistered: boolean }> = [];
      ctx.docStore.flushBoundWrites = (roots: string[]): number => {
        const row = ctx.docStore.repos.checkoutRows(
          ctx.docStore.repos.listRepos()[0]?.repoKey ?? '',
        );
        seen.push({ roots, stillRegistered: row.some((c) => c.root === wt && c.registered) });
        return 0;
      };
      const res = await handleRepoRoutes(ctx, {
        req: new Request('http://localhost/api/repos/checkouts', { method: 'DELETE' }),
        pathname: '/api/repos/checkouts',
        url: new URL('http://localhost/api/repos/checkouts'),
        visitor: null,
      });
      expect(res?.status).toBe(200);
      expect(seen).toHaveLength(1);
      expect(seen[0]?.roots).toEqual([wt]);
      expect(seen[0]?.stillRegistered).toBe(true);
    });
  });
});
