/**
 * Retiring a checkout, over HTTP.
 *
 * Split out of `repo-routes.test.ts` when that file crossed 500 lines: this
 * is the one verb with state of its own to check afterwards — what moved,
 * what has nowhere left to go, and what the registry still remembers — and it
 * carries the same fixture rather than a smaller one, because the whole
 * subject is a repo with two checkouts.
 *
 * Fixtures are synthetic.
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
import { type ServerHandle, createServer } from '../src/server.ts';
import { pastWriteBack, waitFor } from './wait-for.ts';

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
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'cw-repo-retire-')));
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

  describe('retiring a checkout', () => {
    it('retires the row without destroying it, and the doc keeps its id', async () => {
      await register(main);
      await register(wt);
      const docId = await bindDoc('plan', join(main, rel));

      const gone = await send('/api/repos/checkouts', {
        method: 'DELETE',
        body: JSON.stringify({ path: wt }),
      });
      expect(gone.status).toBe(200);
      expect(((await gone.json()) as { ok: boolean }).ok).toBe(true);

      // Soft: the row is still there, marked retired, so the history of what
      // was registered survives the removal.
      const list = (await (await send('/api/repos')).json()) as {
        repos: Array<{ checkouts: Array<{ root: string; registered: boolean }> }>;
      };
      const row = list.repos[0]?.checkouts.find((c) => c.root === wt);
      expect(row).toBeDefined();
      expect(row?.registered).toBe(false);

      // Retiring the row is not the same as the directory going away: git
      // still lists the worktree, so the copy in it is still a copy. Take the
      // directory too — the removal the retirement was warning us about — and
      // the doc keeps its id and falls back to the copy that is left.
      rmSync(wt, { recursive: true, force: true });
      git(main, 'worktree', 'prune');
      const live = await send(`/api/repos/live-copy?docId=${docId}`);
      expect(live.status).toBe(200);
      expect(((await live.json()) as { live: string }).live).toBe(join(main, rel));
    });

    it('moves the docs bound inside it onto another copy before it goes', async () => {
      // The retirement is announced BEFORE `git worktree remove`, so every
      // copy is still on disk at this moment. A doc bound in the retiring
      // checkout has to be moved anyway — otherwise the next write-back goes
      // to a directory that is about to be deleted, and nothing says so.
      await register(main);
      await register(wt);
      setMtime(join(main, rel), T0);
      setMtime(join(wt, rel), T0 + 60);
      const docId = await bindDoc('plan', join(wt, rel));
      const boundTo = (await (await send(`/api/repos/live-copy?docId=${docId}`)).json()) as {
        live: string;
      };
      expect(boundTo.live).toBe(join(wt, rel));

      const gone = await send('/api/repos/checkouts', {
        method: 'DELETE',
        body: JSON.stringify({ path: wt }),
      });
      const body = (await gone.json()) as {
        retargeted: Array<{ docId: string; to: string }>;
        needsPick: string[];
        noCopyLeft: string[];
      };
      expect(body.retargeted).toEqual([{ docId, to: join(main, rel) }]);
      expect(body.needsPick).toEqual([]);
      expect(body.noCopyLeft).toEqual([]);
    });

    it('CONTROL: a doc bound in a checkout that is staying is left alone', async () => {
      // Without this, "everything moved" would pass against a retirement that
      // re-resolved every doc in the corpus.
      await register(main);
      await register(wt);
      setMtime(join(main, rel), T0 + 60);
      setMtime(join(wt, rel), T0);
      await bindDoc('plan', join(main, rel));
      const gone = await send('/api/repos/checkouts', {
        method: 'DELETE',
        body: JSON.stringify({ path: wt }),
      });
      const body = (await gone.json()) as { retargeted: unknown[] };
      expect(body.retargeted).toEqual([]);
    });

    it('says which docs have no copy left, and flags them rather than failing quietly', async () => {
      // A file that exists only on the branch: retiring its checkout leaves
      // the doc with nowhere to write back to. The `.ydoc` still holds every
      // word of it — what is lost is the binding, and that is what is
      // recorded.
      await register(main);
      await register(wt);
      const onlyHere = 'docs/branch-only.md';
      writeFileSync(join(wt, onlyHere), '# Branch only\n\nnot on main\n');
      const docId = await bindDoc('branch-only', join(wt, onlyHere));

      const gone = await send('/api/repos/checkouts', {
        method: 'DELETE',
        body: JSON.stringify({ path: wt }),
      });
      const body = (await gone.json()) as {
        retargeted: unknown[];
        noCopyLeft: string[];
      };
      expect(body.noCopyLeft).toEqual([docId]);
      expect(body.retargeted).toEqual([]);
      // The flag is on the doc, in the sidecar every server-side reader uses,
      // so it outlives the response nobody kept.
      await waitFor(() => {
        const sidecar = join(dataDir, `${docId}.private.json`);
        const raw = JSON.parse(readFileSync(sidecar, 'utf8')) as { bindingLostAt?: number };
        return typeof raw.bindingLostAt === 'number';
      });
    });

    it('does no work on the way to a 404', async () => {
      // The verb used to flush every pending write and move every binding
      // under the path, and only then find out the registry had never heard
      // of it: real writes, on somebody else's document, for a caller who
      // gets a 404 and never learns it happened.
      //
      // The fixture puts a doc's binding inside a checkout the registry holds
      // no row for: only `main` is registered, and the live copy is the one
      // in the worktree because it was edited later.
      await register(main);
      setMtime(join(main, rel), T0);
      setMtime(join(wt, rel), T0 + 60);
      const docId = await bindDoc('plan', join(main, rel));
      const sidecar = join(dataDir, `${docId}.private.json`);
      await waitFor(() => {
        const raw = JSON.parse(readFileSync(sidecar, 'utf8')) as { liveCheckout?: string };
        return raw.liveCheckout === wt;
      });

      const r = await send('/api/repos/checkouts', {
        method: 'DELETE',
        body: JSON.stringify({ path: wt }),
      });
      expect(r.status).toBe(404);
      // timed: the meta write a retarget would have scheduled runs on the
      // `.ydoc` persist debounce, so proving it never happened means waiting
      // past that window. The wait IS the assertion; there is no observable
      // to poll for an event that must not occur.
      await new Promise((resolve) => setTimeout(resolve, pastWriteBack()));
      const after = JSON.parse(readFileSync(sidecar, 'utf8')) as { liveCheckout?: string };
      expect(after.liveCheckout).toBe(wt);
    });

    it('answers 404 for a checkout nobody registered', async () => {
      await register(main);
      const r = await send('/api/repos/checkouts', {
        method: 'DELETE',
        body: JSON.stringify({ path: join(tmp, 'nowhere') }),
      });
      expect(r.status).toBe(404);
    });
  });
});
