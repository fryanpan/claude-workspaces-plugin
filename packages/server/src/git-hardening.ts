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
 * - `gitBarred(path)` is true under a root a lead bound (the bound-file
 *   guard covers it, `slow-fs.ts` `boundFiles.guards`), and for a folder
 *   whose `.git` is a link, or a `gitdir:` file pointing outside its folder
 *   other than into a `.git/worktrees/` or `.git/modules/` folder (git's own
 *   layouts for a worktree and a submodule). Every caller answers "git
 *   cannot tell" for such a path, and listing falls back to a plain walk.
 * - Everywhere else git runs with `core.fsmonitor` and `core.untrackedCache`
 *   off, `safe.bareRepository=explicit` (a folder shaped like a bare
 *   repository is not read as one), no system config, and no inherited
 *   `GIT_*` variable, which would point the read at another repository.
 */
import { lstatSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { boundFiles } from './slow-fs.ts';

export const HARDENED_GIT_ARGS: readonly string[] = [
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.untrackedCache=false',
  '-c',
  'safe.bareRepository=explicit',
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

/** Whether no git may run for `path` (a folder, or a file in one). */
export function gitBarred(path: string): boolean {
  return boundFiles.guards.covers(path) || gitDirRefused(path);
}

/**
 * Whether the nearest `.git` at or above `start` leads somewhere a planted
 * file could: a link, something that is neither folder nor file, or a
 * `gitdir:` file pointing outside the folder holding it and not into a
 * worktree's or a submodule's git folder.
 */
export function gitDirRefused(start: string): boolean {
  let dir = resolve(start);
  for (;;) {
    const dotGit = join(dir, '.git');
    let isDir = false;
    let isFile = false;
    let found = true;
    try {
      const st = lstatSync(dotGit);
      isDir = st.isDirectory();
      isFile = st.isFile();
    } catch {
      found = false;
    }
    if (found) {
      if (isDir) return false;
      if (!isFile) return true;
      let text = '';
      try {
        text = readFileSync(dotGit, 'utf8');
      } catch {
        return true;
      }
      const named = /^gitdir:\s*(.+?)\s*$/m.exec(text)?.[1];
      if (!named) return true;
      const target = `${resolve(dir, named)}/`;
      return !(target.startsWith(`${dir}/`) || /\/\.git\/(worktrees|modules)\//.test(target));
    }
    const up = dirname(dir);
    if (up === dir) return false;
    dir = up;
  }
}
