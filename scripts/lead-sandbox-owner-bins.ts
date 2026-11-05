/**
 * The folders outside the home folder that hold programs the owner runs and
 * that the owner can write, so a lead under the same user could too. The
 * profile is `(allow default)` and then denies, and its denies cover the
 * home folder, so without these `/opt/homebrew` stayed writable inside the
 * wall (measured 4 November 2026: `/opt/homebrew/bin/brew` opened for write
 * under a live lead profile). It is first on the owner's PATH, so a lead
 * that replaced `brew`'s `git` would run its code in every owner session.
 *
 * Found by checking, not from a list of names: each folder on the owner's
 * PATH (the launch's own and the login shell's) and `/Applications`, walked
 * up to the highest folder above it that the owner can write. Each one found
 * is made read only to the lead after every other rule. A folder that holds
 * the home folder, a `protect` folder, a lead's project or `allow` folder,
 * or the temporary folders is never one of them: those have their own rules,
 * and denying a folder above them would wall the lead out of its own work.
 */
import { spawnSync } from 'node:child_process';
import { constants, accessSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute } from 'node:path';

/** Folders that are not on PATH but hold programs the owner starts. */
export const APP_FOLDERS = ['/Applications'];

/** Temporary folders: a lead needs to write them, and the owner runs nothing from them. */
const TEMP = ['/tmp', '/private/tmp', '/var/folders', '/private/var/folders'];

export interface OwnerBinsInput {
  /** Every folder on the owner's PATH, in any order, duplicates allowed. */
  pathDirs: readonly string[];
  /** Folders the walk must not reach or pass: home, `protect`, the leads' folders. */
  keep: readonly string[];
  realpath(p: string): string;
  writable(p: string): boolean;
  exists(p: string): boolean;
}

function inside(child: string, parent: string): boolean {
  return parent === '/' || child === parent || child.startsWith(`${parent}/`);
}

/** The highest owner-writable folder above each candidate, outermost only, sorted. */
export function ownerBinFolders(input: OwnerBinsInput): string[] {
  const keep = [
    ...new Set([...input.keep, ...TEMP, tmpdir()].flatMap((k) => [k, input.realpath(k)])),
  ];
  const holdsKept = (dir: string) => keep.some((k) => inside(k, dir));
  const underKept = (dir: string) => keep.some((k) => inside(dir, k));
  const found = new Set<string>();
  for (const c of new Set([...input.pathDirs, ...APP_FOLDERS])) {
    if (!isAbsolute(c)) continue;
    for (const start of new Set([c, input.realpath(c)])) {
      if (underKept(start)) continue;
      let top: string | null = null;
      for (let at = start; at !== '/'; at = dirname(at)) {
        if (holdsKept(at)) break;
        if (input.exists(at) && input.writable(at)) top = at;
      }
      if (top) found.add(top);
    }
  }
  const all = [...found];
  return all.filter((d) => !all.some((o) => o !== d && inside(d, o))).sort();
}

/** The owner's PATH as its login shell sets it, or none if the shell does not answer in 5s. */
export function loginShellPath(shell = process.env.SHELL || '/bin/zsh'): string[] {
  const r = spawnSync(shell, ['-l', '-c', 'printf "%s" "$PATH"'], {
    encoding: 'utf8',
    timeout: 5_000,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return r.status === 0 ? r.stdout.split(':').filter(Boolean) : [];
}

/**
 * `ownerBinFolders` on this machine for `config`: this process's PATH and
 * the login shell's, keeping clear of the home folder, `protect`, and every
 * lead's projects and `allow` folders.
 */
export function findOwnerBinFolders(
  config: { protect: readonly string[]; leads: readonly { projects: string[]; allow: string[] }[] },
  home: string,
  realpath: (p: string) => string,
): string[] {
  return ownerBinFolders({
    pathDirs: [...(process.env.PATH ?? '').split(':').filter(Boolean), ...loginShellPath()],
    keep: [home, ...config.protect, ...config.leads.flatMap((l) => [...l.projects, ...l.allow])],
    realpath,
    exists: existsSync,
    writable(p) {
      try {
        accessSync(p, constants.W_OK);
        return true;
      } catch {
        return false;
      }
    },
  });
}

/**
 * The exception to "the owner runs nothing from them": every Xcode shim
 * (`/usr/bin/git`, `python3`, `make`) picks its real binary from
 * `xcrun_db` in the owner's temporary folder, so a lead that rewrote it
 * would choose what owner processes run (lead-tree-containment.md review
 * round 2, H1). The file, and its folder so the folder cannot be renamed
 * away and replaced. Both are literals: the lead still writes inside it.
 */
export function xcrunCachePaths(userTemp: string | null): string[] {
  if (!userTemp || !isAbsolute(userTemp)) return [];
  const dir = userTemp.replace(/\/+$/, '');
  return [`${dir}/xcrun_db`, dir];
}

/** `DARWIN_USER_TEMP_DIR`, or null where there is none. */
export function userTempDir(): string | null {
  if (process.platform !== 'darwin') return null;
  const r = spawnSync('/usr/bin/getconf', ['DARWIN_USER_TEMP_DIR'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() || null : null;
}

const found = new WeakMap<object, string[]>();

/** `machine` with `ownerBins` for `config`, found once per config object, and the Xcode cache. */
export function withOwnerBins<M extends { home: string; realpath(p: string): string }>(
  machine: M,
  config: Parameters<typeof findOwnerBinFolders>[0],
): M & { ownerBins: readonly string[]; xcrunCache: readonly string[] } {
  let bins = found.get(config);
  if (!bins) {
    bins = findOwnerBinFolders(config, machine.home, machine.realpath);
    found.set(config, bins);
  }
  return { ...machine, ownerBins: bins, xcrunCache: xcrunCachePaths(userTempDir()) };
}
