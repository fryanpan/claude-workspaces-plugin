/**
 * The keeper refuses to start from anything another user could change.
 *
 * The keeper is only as safe as the code it runs. If its source, the bun
 * that runs it, or the `fly` it calls sat in a folder Bryan's user can
 * write, any agent running as Bryan could replace one of them and run as the
 * keeper, with every credential in reach. So before it reads a credential,
 * the keeper checks each of those paths and every folder above it, up to
 * `/`: each must be owned by root or by the keeper's own user, and none may
 * be writable by group or world, except a sticky folder such as `/tmp`,
 * where nobody can replace an entry they do not own. Every file under the
 * keeper's source folder is checked the same way, and so are the package
 * and TypeScript configs bun reads beside it.
 *
 * This is what makes "updating the keeper needs Bryan's admin password"
 * true rather than a convention: the only users that can change these files
 * are root and the keeper's own, and both need `sudo`.
 */
import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface PathStat {
  uid: number;
  mode: number;
  isDirectory: boolean;
}

export type StatFn = (path: string) => PathStat;

const realStat: StatFn = (path) => {
  const st = lstatSync(path);
  return { uid: st.uid, mode: st.mode, isDirectory: st.isDirectory() };
};

const STICKY = 0o1000;

function problemAt(path: string, st: PathStat, keeperUid: number): string | null {
  if (st.uid !== 0 && st.uid !== keeperUid) return `${path} is owned by uid ${st.uid}`;
  if ((st.mode & 0o022) !== 0 && !(st.isDirectory && (st.mode & STICKY) !== 0)) {
    return `${path} is writable by group or others (mode ${(st.mode & 0o7777).toString(8)})`;
  }
  return null;
}

/** Every reason `path` (resolved) or a folder above it is unsafe. */
export function chainProblems(
  path: string,
  keeperUid: number,
  stat: StatFn = realStat,
  realpath: (p: string) => string = realpathSync,
): string[] {
  let real: string;
  try {
    real = realpath(path);
  } catch {
    return [`${path} does not exist`];
  }
  const out: string[] = [];
  for (let p = real; ; p = dirname(p)) {
    const problem = problemAt(p, stat(p), keeperUid);
    if (problem) out.push(problem);
    if (p === dirname(p)) break;
  }
  return out;
}

/** Every reason a file or folder under `root` is unsafe. Symlinks count as files. */
export function treeProblems(root: string, keeperUid: number, stat: StatFn = realStat): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = stat(p);
      const problem = problemAt(p, st, keeperUid);
      if (problem) out.push(problem);
      if (st.isDirectory) walk(p);
    }
  };
  walk(root);
  return out;
}

/** The guard the keeper runs at boot. Empty means it may start. */
export function keeperStartProblems(opts: {
  /** Folders whose every file the keeper may load. */
  sourceDirs: readonly string[];
  /** Single files it runs or reads as configuration: bun, fly, package.json. */
  files: readonly string[];
  keeperUid: number;
  stat?: StatFn;
}): string[] {
  const stat = opts.stat ?? realStat;
  const out: string[] = [];
  for (const dir of opts.sourceDirs) {
    out.push(...chainProblems(dir, opts.keeperUid, stat));
    if (out.length === 0) out.push(...treeProblems(realpathSync(dir), opts.keeperUid, stat));
  }
  for (const file of opts.files) out.push(...chainProblems(file, opts.keeperUid, stat));
  return [...new Set(out)];
}
