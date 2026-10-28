/**
 * The local paths a `fly` call names, and the refusal of any that reaches the
 * keeper's own folders.
 *
 * `fly` runs as the keeper's user, so it can read the store. A build folder,
 * a `--config` or a `--dockerfile` inside the keeper's home or store would
 * upload the credentials into an image an agent then reads, and no tap makes
 * that safe, so such a call is refused before it is held. Each path is
 * followed through every symlink in the part that exists, and is refused if
 * it lies inside a guarded folder or contains one. A relative path is
 * refused, because `fly` would resolve it against the keeper's own working
 * folder.
 *
 * A path the keeper's user cannot read (or, for a folder, list) is refused
 * too, except the one `fly ssh sftp get` writes to.
 *
 * The check runs again just before `fly` starts, and then `fly` reads a copy
 * the keeper made of each path, never the agent's folder (`keeper-stage.ts`).
 */
import { constants, accessSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';

/** Flags whose value is a local file or folder, on any fly command. */
const PATH_FLAGS = new Set(['config', 'dockerfile', 'ignorefile', '-c']);

/** The real path of `p`, following every link in the part that exists. */
export function realish(p: string): string {
  let head = resolve(p);
  const tail: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(head), ...tail.reverse());
    } catch {
      const parent = dirname(head);
      if (parent === head) return resolve(p);
      tail.push(basename(head));
      head = parent;
    }
  }
}

const within = (inner: string, outer: string): boolean =>
  inner === outer || inner.startsWith(outer.endsWith(sep) ? outer : `${outer}${sep}`);

/** The index of each local path in a fly argv. */
export function pathArgIndexes(args: readonly string[]): number[] {
  return localPaths(args).at;
}

/** Every local path's index, and the one `fly ssh sftp get` writes to, if any. */
function localPaths(args: readonly string[]): { at: number[]; written: number | null } {
  const at: number[] = [];
  const words: number[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (!a.startsWith('-')) {
      words.push(i);
      continue;
    }
    const name = a === '-c' ? '-c' : a.startsWith('--') ? (a.slice(2).split('=', 1)[0] ?? '') : '';
    if (!PATH_FLAGS.has(name)) continue;
    if (a.includes('=')) at.push(i);
    else if (i + 1 < args.length) {
      at.push(i + 1);
      words.push(i + 1);
      i++;
    }
  }
  const word = (n: number) => args[words[n] as number];
  // fly deploy [build folder]; fly ssh sftp put <local> ...; fly ssh sftp get <remote> <local>
  if (word(0) === 'deploy' && words[1] !== undefined && !at.includes(words[1])) {
    at.push(words[1]);
  }
  let written: number | null = null;
  if (word(0) === 'ssh' && word(1) === 'sftp') {
    const local = word(2) === 'put' ? words[3] : word(2) === 'get' ? words[4] : undefined;
    if (local !== undefined) at.push(local);
    if (word(2) === 'get' && local !== undefined) written = local;
  }
  return { at, written };
}

const valueAt = (args: readonly string[], i: number): string => {
  const a = args[i] as string;
  return a.startsWith('-') ? a.slice(a.indexOf('=') + 1) : a;
};

/**
 * Why this argv may not run, or the argv with each local path resolved.
 * `guarded` are the keeper's home and store.
 */
export function resolveFlyPaths(
  args: readonly string[],
  guarded: readonly string[],
): { error: string } | { args: string[]; paths: string[]; at: number[] } {
  const roots = guarded.map(realish);
  const out = [...args];
  const paths: string[] = [];
  const { at, written } = localPaths(args);
  for (const i of at) {
    const value = valueAt(args, i);
    if (!isAbsolute(value)) return { error: `name ${value.slice(0, 80)} as a full path` };
    const real = realish(value);
    if (roots.some((root) => within(real, root) || within(root, real))) {
      return { error: `${value.slice(0, 80)} reaches the keeper's own folders` };
    }
    // `fly` runs as the keeper's user. A path that user cannot read would
    // fail only once the command runs, after the tap and after whatever the
    // requester changed before it, so it is refused now.
    if (i !== written && !readable(real)) {
      return {
        error: `the keeper's user cannot read ${value.slice(0, 80)}; stage it where that user can (docs/process/keeper.md)`,
      };
    }
    const a = args[i] as string;
    out[i] = a.startsWith('-') ? `${a.slice(0, a.indexOf('=') + 1)}${real}` : real;
    paths.push(real);
  }
  return { args: out, paths, at };
}

/** Whether this process can read `path`, and list it when it is a folder. */
function readable(path: string): boolean {
  try {
    accessSync(
      path,
      statSync(path).isDirectory() ? constants.R_OK | constants.X_OK : constants.R_OK,
    );
    return true;
  } catch {
    return false;
  }
}

/** The first entries of a folder, for the approval page. */
export function folderEntries(path: string, max = 40): string[] {
  try {
    const names = readdirSync(path).sort();
    return names.length > max
      ? [...names.slice(0, max), `… and ${names.length - max} more`]
      : names;
  } catch {
    return [];
  }
}
