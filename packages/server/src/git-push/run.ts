/**
 * Judging a push, and sending it, in repositories that hold upstream's
 * objects and this push's bundle and nothing else.
 *
 * Two repositories per push:
 *
 *  - the MIRROR, one per upstream repo (`git-push/mirrors/`), into which
 *    only upstream is ever fetched. No bundle is fetched into it, so it never
 *    holds a commit a person refused or another board's unsent work.
 *  - the WORK repo, made for this one run (`git-push/work/<id>.git`), which
 *    borrows the mirror's objects (git's alternates) and receives the bundle.
 *    It is removed when the run ends, however it ends.
 *
 * So `git bundle verify` in the work repo passes only when every commit the
 * bundle builds on came from upstream, and a fetch there cannot complete a
 * bundle with objects some earlier bundle left behind.
 */
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import type { PushCredential } from './credential.ts';
import { type GitRunner, ScratchRepo, type Upstream, redact } from './git.ts';

export interface RunInput {
  /** The push's id; names its work repo. */
  id: string;
  repo: string;
  branch: string;
  bundle: string;
}

export type RunResult =
  | {
      ok: true;
      sha: string;
      tip: string | null;
      /** Commit subjects being added, newest first, at most ten. */
      subjects: string[];
      upToDate: boolean;
      /** Set when the run was asked to push and did. */
      pushed?: true;
    }
  | { ok: false; status: number; error: string; message: string };

export interface RunDeps {
  /** `<dataDir>/git-push`. */
  root: string;
  credential: PushCredential;
  remoteUrlFor: (repo: string) => string;
  runGit: GitRunner;
}

const refused = (status: number, error: string, message: string): RunResult => ({
  ok: false,
  status,
  error,
  message,
});

/**
 * Judge `input` and, when `push` is set and it passes, push it. The caller
 * holds the repo's lock: the mirror is shared by every push to that repo.
 */
export async function runPush(deps: RunDeps, input: RunInput, push: boolean): Promise<RunResult> {
  const workDir = join(deps.root, 'work', `${input.id}.git`);
  try {
    return await judgeIn(deps, input, workDir, push);
  } finally {
    // Transient by construction, so a hard delete.
    rmSync(workDir, { recursive: true, force: true });
  }
}

async function judgeIn(
  deps: RunDeps,
  input: RunInput,
  workDir: string,
  push: boolean,
): Promise<RunResult> {
  const { repo, branch, bundle } = input;
  const token = await deps.credential();
  if (!token)
    return refused(503, 'no-credential', 'this server holds no GitHub credential to push with');
  const authDir = join(deps.root, 'auth');
  const up: Upstream = { url: deps.remoteUrlFor(repo), token };
  const mirror = new ScratchRepo(
    join(deps.root, 'mirrors', `${repo.replace('/', '__')}.git`),
    deps.runGit,
    authDir,
  );
  const work = new ScratchRepo(workDir, deps.runGit, authDir);
  if (!(await mirror.ensure()) || !(await work.ensure())) {
    return refused(500, 'scratch', 'could not prepare a repository');
  }
  work.borrowObjectsFrom(mirror);

  const state = await mirror.upstreamState(up, branch);
  if ('error' in state) {
    return refused(
      502,
      'upstream-unreadable',
      `could not read ${repo}: ${redact(state.error, token)}`,
    );
  }
  if (state.defaultBranch === branch) {
    return refused(
      403,
      'default-branch',
      `${branch} is ${repo}'s default branch; push a feature branch and open a PR`,
    );
  }
  const heads = await work.bundleHeads(bundle);
  const ref = `refs/heads/${branch}`;
  const named = heads?.length === 1 && heads[0]?.[1] === ref ? heads[0] : undefined;
  if (!named) {
    return refused(400, 'bundle-heads', `the body must be a git bundle carrying one ref, ${ref}`);
  }
  const fetches = [mirror.fetchUpstream(up, state.defaultBranch)];
  if (state.tip) fetches.push(mirror.fetchUpstream(up, branch));
  for (const r of await Promise.all(fetches)) {
    if (r.code !== 0) {
      return refused(
        502,
        'upstream-unreadable',
        `could not fetch ${repo}: ${redact(r.stderr.trim().slice(-300), token)}`,
      );
    }
  }
  if (!(await work.bundleApplies(bundle))) {
    return refused(
      409,
      'bundle-base-missing',
      `the bundle builds on commits ${repo} does not have; make it from origin/${state.defaultBranch}..${branch}`,
    );
  }
  if (!(await work.fetchBundle(bundle, ref, input.id))) {
    return refused(400, 'bundle-unreadable', 'could not read the bundle');
  }
  const sha = named[0];
  if (state.tip === sha) return { ok: true, sha, tip: state.tip, subjects: [], upToDate: true };
  if (state.tip && !(await work.isAncestor(state.tip, sha))) {
    return refused(
      403,
      'not-fast-forward',
      `${sha.slice(0, 12)} does not descend from ${repo}'s ${branch} at ${state.tip.slice(0, 12)}; this server never force-pushes`,
    );
  }
  const base = state.tip ?? (await mirror.revParse(`refs/up/${state.defaultBranch}`));
  const subjects = await work.subjects(base, sha, 10);
  if (!push) return { ok: true, sha, tip: state.tip, subjects, upToDate: false };
  const r = await work.push(up, sha, branch);
  if (r.code !== 0) {
    const why = redact(r.stderr, token).trim().split('\n').slice(-2).join(' ').slice(0, 300);
    return refused(502, 'push-failed', `upstream refused the push: ${why}`);
  }
  return { ok: true, sha, tip: state.tip, subjects, upToDate: false, pushed: true };
}
