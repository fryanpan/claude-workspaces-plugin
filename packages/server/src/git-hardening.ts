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
 *   `board-socket-roots.ts`), and in a repository whose top folder or git
 *   folders, followed through a `.git` link or `gitdir:` file, are under
 *   one or hold one. Every caller answers "git cannot tell" there, and
 *   listing falls back to a plain walk. With no project registered it is
 *   false everywhere and reads nothing.
 * - Everywhere else git runs with `core.fsmonitor`, `core.untrackedCache`
 *   and `log.showSignature` off, `safe.bareRepository=explicit` (a folder
 *   shaped like a bare repository is not read as one), no system or global
 *   config, and no inherited `GIT_*` variable, which would point the read
 *   at another repository. These are a second line: they name only the
 *   settings they turn off.
 */
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs';
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

/** The server's environment without `GIT_*`, and with no system or global config. */
export function hardenedGitEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith('GIT_') && v !== undefined) env[k] = v;
  }
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = '/dev/null';
  return env;
}

/** Whether no git may run for `path` (a folder, or a file in one): it is
 *  under a walled lead's project, or in a repository whose top folder or
 *  git folders are under one or hold one. With no project registered,
 *  nothing is barred and nothing is read. */
export function gitBarred(path: string): boolean {
  const guards = boundFiles.guards;
  if (!guards.holdsRoot('/')) return false;
  if (guards.covers(path)) return true;
  const repo = repoOf(path);
  if (repo === 'refused') return true;
  if (repo === null) return false;
  return [repo.top, ...repo.gitDirs].some((d) => guards.covers(d) || guards.holdsRoot(d));
}

/**
 * The repository git would find from `start`: its top folder and the git
 * folders it reads, resolved (the `.git` folder, or the one a `.git` link
 * or `gitdir:` file names, and that folder's `commondir`). Null outside
 * one; `'refused'` for a `.git` that is neither a folder, a link to one,
 * nor a readable `gitdir:` file. A pointer under a lead's project is not
 * followed further: the repository is barred by it already.
 */
export function repoOf(start: string): { top: string; gitDirs: string[] } | null | 'refused' {
  let dir = realOr(resolve(start));
  for (;;) {
    const dotGit = join(dir, '.git');
    let st: ReturnType<typeof lstatSync> | null = null;
    try {
      st = lstatSync(dotGit);
    } catch {}
    if (st) {
      if (st.isDirectory()) return { top: dir, gitDirs: [dotGit] };
      let gitDir: string;
      if (st.isSymbolicLink()) gitDir = realOr(dotGit);
      else if (st.isFile()) {
        const named = readLine(dotGit, /^gitdir:\s*(.+?)\s*$/m);
        if (!named) return 'refused';
        gitDir = realOr(resolve(dir, named));
      } else return 'refused';
      if (!isDir(gitDir)) return 'refused';
      if (boundFiles.guards.covers(gitDir)) return { top: dir, gitDirs: [gitDir] };
      const common = readLine(join(gitDir, 'commondir'), /^(.+?)\s*$/m);
      return {
        top: dir,
        gitDirs: common ? [gitDir, realOr(resolve(gitDir, common))] : [gitDir],
      };
    }
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/** The most of a pointer file `readLine` reads by default; git writes one line. */
const POINTER_MAX = 4_096;

/** A match in a small regular file, read without blocking: a pipe or a
 *  device at the path would otherwise hold the main thread. */
export function readLine(path: string, re: RegExp, max = POINTER_MAX): string | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    if (!fstatSync(fd).isFile()) return null;
    const buf = Buffer.alloc(max);
    const n = readSync(fd, buf, 0, max, 0);
    return re.exec(buf.subarray(0, n).toString('utf8'))?.[1] ?? null;
  } catch {
    return null;
  } finally {
    closeSync(fd);
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
