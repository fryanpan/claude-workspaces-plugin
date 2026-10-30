/**
 * The folder scan's walk (`fs-scan.ts` `readdirRecursive`) under a walled
 * lead's root, through descriptors opened with no link on their way
 * (`tree-fs.ts`). A folder swapped for a link after its parent was read is
 * not entered, a link is a skipped entry, and a root the guard refuses lists
 * nothing. Which names are skipped stays `fs-scan.ts`'s rule, passed in.
 */
import { type Stats, lstatSync } from 'node:fs';
import { relative, sep } from 'node:path';
import { GuardRefused } from './guard-refused.ts';
import { boundFiles } from './slow-fs.ts';
import { type Contained, listTreeSync } from './tree-fs.ts';

/** The most entries a walk under a walled lead's root reads. */
export const CONTAINED_WALK_MAX = 200_000;

/** `root` as a walled lead's root holds it, `'refused'` when the guard
 *  refuses it outright, or null for a plain walk. */
export function containedRoot(root: string): Contained | 'refused' | null {
  try {
    return boundFiles.guards.containedOf(root);
  } catch (err) {
    if (err instanceof GuardRefused) return 'refused';
    throw err;
  }
}

export interface ScanSkips<R extends string> {
  /** Why a folder is not walked, or null to walk it. `.git` is never named. */
  skipDir: (name: string) => R | null;
  /** Why a file is not listed, or null to list it. */
  skipFile: (name: string) => R | null;
  /** The reason a link, FIFO or device is skipped with. */
  notRegular: R;
}

/**
 * Every file under `root` the scan lists, as absolute paths spelled from
 * `root`, with the rest pushed onto `skipped` relative to it. Past
 * `CONTAINED_WALK_MAX` entries it lists nothing, as a refusal would.
 */
export function readdirContained<R extends string>(
  root: string,
  c: Contained | 'refused',
  skipped: Array<{ path: string; reason: R }> | null,
  skips: ScanSkips<R>,
): string[] {
  if (c === 'refused') return [];
  const base = c.abs === c.root ? '' : relative(c.root, c.abs).split(sep).join('/');
  const inRoot = (rel: string): string => (base === '' ? rel : rel.slice(base.length + 1));
  const enter = (rel: string, name: string): boolean => {
    const reason = skips.skipDir(name);
    if (reason === null) return true;
    if (name !== '.git') skipped?.push({ path: `${inRoot(rel)}/`, reason });
    return false;
  };
  let listed: ReturnType<typeof listTreeSync>;
  try {
    listed = listTreeSync(c, { maxEntries: CONTAINED_WALK_MAX, enter });
  } catch (err) {
    if (err instanceof GuardRefused) return [];
    throw err;
  }
  if (listed === null) {
    console.error(`[fs-scan] ${c.abs} holds more than ${CONTAINED_WALK_MAX} entries; listing none`);
    return [];
  }
  const out: string[] = [];
  for (const entry of listed) {
    if (entry.kind === 'dir') continue;
    const rel = inRoot(entry.rel);
    const name = rel.split('/').pop() ?? rel;
    const reason = entry.kind === 'file' ? skips.skipFile(name) : skips.notRegular;
    if (reason) skipped?.push({ path: rel, reason });
    else out.push(`${root}/${rel}`);
  }
  return out;
}

/** An `include` entry's stat (`fs-scan.ts` `admitIncluded`), or why it is
 *  skipped. Under a walled lead's root it comes from a descriptor opened
 *  with no link on its way, since `lstat` follows a linked parent. */
export function includedStat(abs: string): Stats | 'not-found' | 'not-a-regular-file' {
  try {
    return boundFiles.guards.containedOf(abs) ? boundFiles.guards.statSync(abs) : lstatSync(abs);
  } catch (err) {
    return err instanceof GuardRefused ? 'not-a-regular-file' : 'not-found';
  }
}
