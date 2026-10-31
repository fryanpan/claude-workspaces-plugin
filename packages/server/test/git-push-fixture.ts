/**
 * The upstream, the lead's clone and the server a push test drives.
 *
 * Upstream is a local bare repository per `owner/name`, under one folder, so
 * `remoteUrlFor` points the server at `file://` URLs and nothing reaches
 * GitHub. The credential is a fake value; every git call the server makes is
 * recorded so a test can say where the value went and where it did not.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boardSocketPath } from '../src/board-sockets.ts';
import { type GitCall, realGit } from '../src/git-push/git.ts';
import { GIT_PUSH_POLICY_FILE } from '../src/git-push/policy.ts';
import type { ServerOptions } from '../src/server-options.ts';
import { type ServerHandle, createServer } from '../src/server.ts';

/** Not a credential: a marker whose every appearance the tests look for. */
export const FAKE_TOKEN = 'fake-push-credential-for-tests-only';

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'Alice',
  GIT_AUTHOR_EMAIL: '',
  GIT_COMMITTER_NAME: 'Alice',
  GIT_COMMITTER_EMAIL: '',
};

export function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

export interface PushWorld {
  h: ServerHandle;
  base: string;
  board: string;
  dataDir: string;
  upstreamRoot: string;
  work: string;
  socketDir: string;
  calls: GitCall[];
  /** Upstream's sha for `refs/heads/<branch>`, or '' when absent. */
  upstreamTip: (repo: string, branch: string) => string;
  /** A clone of `repo` with `branch` holding one new commit, and a bundle of it. */
  leadBundle: (
    repo: string,
    branch: string,
    opts?: { from?: string; rewrite?: boolean },
  ) => ArrayBuffer;
  onSocket: (path: string, init?: RequestInit, board?: string) => Promise<Response>;
  overTcp: (path: string, init?: RequestInit) => Promise<Response>;
  stop: () => Promise<void>;
}

export async function startPushWorld(
  policy: (board: string) => unknown,
  extra: Partial<ServerOptions> = {},
): Promise<PushWorld> {
  const dataDir = mkdtempSync(join(tmpdir(), 'git-push-data-'));
  const work = mkdtempSync(join(tmpdir(), 'git-push-work-'));
  const upstreamRoot = join(work, 'upstream');
  const socketRoot = mkdtempSync(
    process.platform === 'darwin' ? '/private/tmp/gpw-' : join(tmpdir(), 'gpw-'),
  );
  const socketDir = join(socketRoot, 'boards');
  for (const repo of ['Harborlight/notes', 'Harborlight/approvals', 'Riverbend/notes']) {
    const dir = join(upstreamRoot, `${repo}.git`);
    mkdirSync(dir, { recursive: true });
    git(dir, 'init', '--bare', '--quiet', '--initial-branch=main');
    const seed = join(work, 'seed', repo);
    mkdirSync(seed, { recursive: true });
    git(seed, 'init', '--quiet', '--initial-branch=main');
    writeFileSync(join(seed, 'README.md'), `# ${repo}\n`);
    git(seed, 'add', '.');
    git(seed, 'commit', '--quiet', '-m', 'Seed');
    git(seed, 'push', '--quiet', dir, 'main');
  }
  const calls: GitCall[] = [];
  const h = createServer({
    port: 0,
    dataDir,
    boardSocketDir: socketDir,
    gitPush: {
      credential: async () => FAKE_TOKEN,
      remoteUrlFor: (repo) => `file://${upstreamRoot}/${repo}.git`,
      runGit: (call) => {
        calls.push(call);
        return realGit(call);
      },
    },
    ...extra,
  });
  const base = `http://127.0.0.1:${h.port}`;
  const overTcp = (path: string, init: RequestInit = {}) => fetch(`${base}${path}`, init);
  const res = await overTcp('/workspaces', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Harborlight' }),
  });
  const board = ((await res.json()) as { workspace: { id: string } }).workspace.id;
  writeFileSync(join(dataDir, GIT_PUSH_POLICY_FILE), JSON.stringify(policy(board)));

  let n = 0;
  return {
    h,
    base,
    board,
    dataDir,
    upstreamRoot,
    work,
    socketDir,
    calls,
    upstreamTip: (repo, branch) => {
      const r = spawnSync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], {
        cwd: join(upstreamRoot, `${repo}.git`),
        env: GIT_ENV,
        encoding: 'utf8',
      });
      return r.status === 0 ? r.stdout.trim() : '';
    },
    leadBundle: (repo, branch, opts = {}) => {
      n += 1;
      const clone = join(work, 'lead', `${n}`);
      git(work, 'clone', '--quiet', `${upstreamRoot}/${repo}.git`, clone);
      const from = opts.from ?? 'origin/main';
      git(clone, 'checkout', '--quiet', '-b', branch, from);
      if (opts.rewrite) git(clone, 'reset', '--quiet', '--hard', 'origin/main');
      writeFileSync(join(clone, `change-${n}.md`), `Change ${n}\n`);
      git(clone, 'add', '.');
      git(clone, 'commit', '--quiet', '-m', `Change ${n} from the Riverbend lead`);
      const file = join(work, `${n}.bundle`);
      git(clone, 'bundle', 'create', '--quiet', file, `origin/main..${branch}`);
      const b = readFileSync(file);
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
    },
    onSocket: (path, init = {}, which = board) =>
      fetch(`http://board${path}`, {
        ...init,
        unix: boardSocketPath(socketDir, which),
      } as RequestInit),
    overTcp,
    stop: async () => {
      await h.stop();
      for (const d of [dataDir, work, socketRoot]) rmSync(d, { recursive: true, force: true });
    },
  };
}

export function pushPath(board: string, repo: string, branch: string, task?: string): string {
  const q = new URLSearchParams({ repo, branch, ...(task ? { task } : {}) });
  return `/workspaces/${board}/git/push?${q}`;
}
