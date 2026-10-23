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
 * The check runs again just before `fly` starts, and then `fly` reads a copy
 * the keeper made of each path, never the agent's folder (`keeper-stage.ts`).
 */
import { readdirSync, realpathSync } from 'node:fs';
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
  if (word(0) === 'ssh' && word(1) === 'sftp') {
    const local = word(2) === 'put' ? words[3] : word(2) === 'get' ? words[4] : undefined;
    if (local !== undefined) at.push(local);
  }
  return at;
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
  const at = pathArgIndexes(args);
  for (const i of at) {
    const value = valueAt(args, i);
    if (!isAbsolute(value)) return { error: `name ${value.slice(0, 80)} as a full path` };
    const real = realish(value);
    if (roots.some((root) => within(real, root) || within(root, real))) {
      return { error: `${value.slice(0, 80)} reaches the keeper's own folders` };
    }
    const a = args[i] as string;
    out[i] = a.startsWith('-') ? `${a.slice(0, a.indexOf('=') + 1)}${real}` : real;
    paths.push(real);
  }
  return { args: out, paths, at };
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
