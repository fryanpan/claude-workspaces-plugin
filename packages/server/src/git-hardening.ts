/**
 * What every server-side git read does before it runs, so a repository a
 * lead or anyone else can write cannot make that read run a program.
 *
 * Git reads config from the repository it finds, and settings there can
 * name a program git runs as the server's user: `core.fsmonitor`, a
 * filter's `clean`, `core.hooksPath`, a file `includeIf` pulls in. Options
 * on the command line cover only the settings named, so the first rule is
 * not to run git where a lead can write at all:
 *
 * - `gitBarred(path)` is true under a lead's root (the bound-file guard
 *   covers it, `slow-fs.ts` `boundFiles.guards`, from
 *   `board-socket-roots.ts`), in a repository whose top folder or git
 *   folder holds one, and where `.git` is a link or a `gitdir:` file git
 *   did not write. Every caller answers "git cannot tell" there, and
 *   listing falls back to a plain walk.
 * - Everywhere else git runs with `core.fsmonitor`, `core.untrackedCache`
 *   and `log.showSignature` off, `safe.bareRepository=explicit` (a folder
 *   shaped like a bare repository is not read as one), no system config,
 *   and no inherited `GIT_*` variable, which would point the read at
 *   another repository. These are a second line: a filter still runs.
 */
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { boundFiles } from './slow-fs.ts';

export const HARDENED_GIT_ARGS: readonly string[] = [
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.untrackedCache=false',
  '-c',
  'safe.bareRepository=explicit',
  '-c',
  'log.showSignature=false',
];

/** `<hardened> <args>` as one argv tail, for spawn calls that take one. */
export function hardenedGitArgs(args: readonly string[]): string[] {
  return [...HARDENED_GIT_ARGS, ...args];
}

/** The server's environment without `GIT_*`, and with no system config. */
export function hardenedGitEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith('GIT_') && v !== undefined) env[k] = v;
  }
  env.GIT_CONFIG_NOSYSTEM = '1';
  return env;
}

/** Whether no git may run for `path` (a folder, or a file in one): it is
 *  under a lead's root, its repository holds one, or its `.git` is not one
 *  git itself would have made. */
export function gitBarred(path: string): boolean {
  const guards = boundFiles.guards;
  if (guards.covers(path)) return true;
  const repo = repoOf(path);
  if (repo === 'refused') return true;
  if (repo === null) return false;
  return [repo.top, repo.common].some((d) => guards.covers(d) || guards.holdsRoot(d));
}

/** The repository git would find from `start`: its top folder and the git
 *  folder holding its config. Null outside one; `'refused'` for a `.git`
 *  that is a link, or a `gitdir:` file git did not write (`gitDirOf`). */
export function repoOf(start: string): { top: string; common: string } | null | 'refused' {
  let dir = realOr(resolve(start));
  for (;;) {
    const dotGit = join(dir, '.git');
    let st: ReturnType<typeof lstatSync> | null = null;
    try {
      st = lstatSync(dotGit);
    } catch {}
    if (st) {
      if (st.isDirectory()) return { top: dir, common: dotGit };
      if (!st.isFile()) return 'refused';
      const common = gitDirOf(dir, dotGit);
      return common === null ? 'refused' : { top: dir, common };
    }
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/**
 * The git folder a `.git` file in `dir` names, when it is exactly one of
 * the two git writes: a worktree's (`<repo>/.git/worktrees/<name>`, whose
 * own `gitdir` names this `.git` back and whose `commondir` is that
 * `<repo>/.git`), answered as the common folder; or a submodule's
 * (`<super>/.git/modules/…`, with `<super>` above `dir`). Else null.
 */
function gitDirOf(dir: string, dotGit: string): string | null {
  const named = readLine(dotGit, /^gitdir:\s*(.+?)\s*$/m);
  if (!named) return null;
  const target = realOr(resolve(dir, named));
  const worktree = /^(.+\/\.git)\/worktrees\/[^/]+$/.exec(target);
  if (worktree?.[1]) {
    const back = readLine(join(target, 'gitdir'), /^(.+?)\s*$/m);
    const common = readLine(join(target, 'commondir'), /^(.+?)\s*$/m);
    if (!back || !common) return null;
    if (realOr(resolve(target, back)) !== realOr(dotGit)) return null;
    if (realOr(resolve(target, common)) !== worktree[1]) return null;
    return isDir(worktree[1]) ? worktree[1] : null;
  }
  const module = /^(.+)\/\.git\/modules\/.+$/.exec(target);
  const superTop = module?.[1];
  if (superTop && dir.startsWith(`${superTop}/`) && isDir(join(superTop, '.git'))) return target;
  return null;
}

function readLine(path: string, re: RegExp): string | null {
  try {
    return re.exec(readFileSync(path, 'utf8'))?.[1] ?? null;
  } catch {
    return null;
  }
}

function realOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function isDir(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}
