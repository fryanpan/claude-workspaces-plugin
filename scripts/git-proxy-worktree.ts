/**
 * Worktrees for walled leads, made by the git proxy outside the wall.
 *
 * Inside the wall a lead cannot `git worktree add`: the profile makes every
 * git folder's settings read only (`gitCodeRegex`), and a worktree needs a
 * new `.git/worktrees/<name>/` holding `commondir` and `gitdir`, which can
 * point git at a config the lead wrote. So the lead asks the proxy, which
 * runs as the owner, and the proxy makes the worktree from one fixed shape:
 *
 *   <repo>/.claude/worktrees/<name>, on a new branch <branch> from <base>,
 *   with `branch.<branch>.remote origin` and `.merge refs/heads/<branch>`.
 *
 * `<repo>` must be a repository at or inside one of the lead's projects, as
 * the owner's config names them. The proxy's git runs with hooks and
 * fsmonitor off and checks nothing out (`--no-checkout`), so it runs no
 * filter a lead's `.gitattributes` names either; the lead's own git fills
 * the files in afterwards, inside the wall. Before and after, the proxy
 * checks that no path it writes passes through a symlink and that the
 * worktree's `.git` file and `commondir` say what git should have written.
 *
 * Once made, the worktree is covered like the rest of the project: its
 * `.git` file and the git folder's settings are read only to the lead.
 * The lead's side is `cw-worktree`, written by `git-proxy-lead.ts`.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';

/** The proxy's path for it; `-` is no GitHub owner, so no repo's path can be this. */
export const WORKTREE_PATH = '/-/worktree';

export interface WorktreeRequest {
  repo: string;
  name: string;
  branch: string;
  base: string;
}

export type WorktreeResult =
  | { ok: true; path: string; branch: string }
  | { ok: false; status: number; why: string };

/** A folder name: no slash, no dot step, no leading dash. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** A branch or a base: ref-name characters only, so no option and no revision syntax. */
const REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

/** The request in a form body (`repo=…&name=…`), checked for shape, or why not. */
export function parseWorktreeForm(body: string): WorktreeRequest | string {
  const form = new URLSearchParams(body);
  const repo = form.get('repo') ?? '';
  const name = form.get('name') ?? '';
  const branch = form.get('branch') || name;
  const base = form.get('base') || 'origin/HEAD';
  if (!isAbsolute(repo) || repo.includes('\0')) return 'repo must be an absolute path';
  if (!NAME.test(name) || name.endsWith('.lock'))
    return 'name must be letters, digits, dot, dash or underscore, at most 64';
  for (const [what, ref] of [
    ['branch', branch],
    ['base', base],
  ] as const)
    if (!REF.test(ref) || ref.includes('..') || ref.includes('//') || /(\.lock|\/|\.)$/.test(ref))
      return `${what} is not a ref name git and the proxy both accept`;
  return { repo, name, branch, base };
}

/** Git as the owner runs it here: no hooks, no fsmonitor, no prompt, nothing from the caller's GIT_ variables. */
function git(cwd: string, args: string[]) {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GIT_')) env[k] = v;
  env.GIT_TERMINAL_PROMPT = '0';
  return spawnSync(
    'git',
    ['-C', cwd, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args],
    { encoding: 'utf8', env, timeout: 60_000 },
  );
}

/** Every existing step from `top` down to `path`, refused at the first symlink or non-folder. */
function symlinkOnTheWay(top: string, path: string): string | null {
  let at = top;
  for (const step of relative(top, path).split(sep)) {
    at = join(at, step);
    if (!existsSync(at) && !isLink(at)) return null;
    const st = lstatSync(at);
    if (st.isSymbolicLink()) return `${at} is a symlink`;
    if (!st.isDirectory() && at !== path) return `${at} is not a folder`;
  }
  return null;
}

function isLink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function inside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(`${parent}/`);
}

/** Make the worktree, or say why not. `projects` are the lead's, as the owner's config names them. */
export function addLeadWorktree(projects: readonly string[], req: WorktreeRequest): WorktreeResult {
  const refuse = (status: number, why: string): WorktreeResult => ({ ok: false, status, why });
  let repo: string;
  try {
    repo = realpathSync(req.repo);
  } catch {
    return refuse(404, `${req.repo} does not exist`);
  }
  const own = projects.flatMap((p) => {
    try {
      return [realpathSync(p)];
    } catch {
      return [];
    }
  });
  if (!own.some((p) => inside(repo, p)))
    return refuse(403, `${req.repo} is not in one of the lead's projects`);
  const gitDir = join(repo, '.git');
  if (isLink(gitDir) || !existsSync(gitDir) || !lstatSync(gitDir).isDirectory())
    return refuse(400, `${req.repo} is not the top of a repository with its own .git folder`);
  const path = join(repo, '.claude', 'worktrees', req.name);
  const admin = join(gitDir, 'worktrees', req.name);
  const before = symlinkOnTheWay(repo, path) ?? symlinkOnTheWay(gitDir, admin);
  if (before) return refuse(400, before);
  if (existsSync(path) || isLink(path)) return refuse(409, `${path} already exists`);
  if (existsSync(admin) || isLink(admin)) return refuse(409, `${admin} already exists`);
  const ref = git(repo, ['check-ref-format', '--branch', req.branch]);
  if (ref.status !== 0) return refuse(400, `${req.branch} is not a branch name git accepts`);
  if (git(repo, ['rev-parse', '--verify', '-q', `refs/heads/${req.branch}`]).status === 0)
    return refuse(409, `branch ${req.branch} already exists`);
  const add = git(repo, [
    'worktree',
    'add',
    '--no-checkout',
    '--no-track',
    '-b',
    req.branch,
    path,
    req.base,
  ]);
  if (add.status !== 0)
    return refuse(400, `git worktree add failed: ${add.stderr.trim().slice(0, 500)}`);
  const after = checkWorktree(repo, path, admin);
  if (after) return refuse(500, `the worktree is not the shape the proxy makes: ${after}`);
  for (const [key, value] of [
    [`branch.${req.branch}.remote`, 'origin'],
    [`branch.${req.branch}.merge`, `refs/heads/${req.branch}`],
  ] as const)
    if (git(repo, ['config', key, value]).status !== 0)
      return refuse(500, `the worktree was made, but setting ${key} failed`);
  return { ok: true, path, branch: req.branch };
}

/** Null when the worktree git made is the one the proxy meant, otherwise what differs. */
export function checkWorktree(repo: string, path: string, admin: string): string | null {
  const moved = symlinkOnTheWay(repo, path) ?? symlinkOnTheWay(join(repo, '.git'), admin);
  if (moved) return moved;
  if (realpathSync(path) !== path || realpathSync(admin) !== admin)
    return 'a folder resolves somewhere else';
  const dotGit = join(path, '.git');
  if (isLink(dotGit) || !lstatSync(dotGit).isFile()) return `${dotGit} is not a file`;
  const points = readFileSync(dotGit, 'utf8').trim();
  if (points !== `gitdir: ${admin}`) return `${dotGit} says ${points}`;
  const common = readFileSync(join(admin, 'commondir'), 'utf8').trim();
  if (common !== '../..') return `commondir says ${common}`;
  if (existsSync(join(admin, 'config.worktree'))) return 'it has a config.worktree';
  const back = readFileSync(join(admin, 'gitdir'), 'utf8').trim();
  if (back !== dotGit) return `gitdir says ${back}`;
  if (dirname(admin) !== join(repo, '.git', 'worktrees')) return 'its git folder moved';
  return null;
}
