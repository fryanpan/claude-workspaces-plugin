/**
 * The folder scan's walks (`fs-scan.ts` `readdirRecursive` and its async
 * twin): a plain recursive readdir, and the walk under a walled lead's root
 * through descriptors opened with no link on their way (`tree-fs.ts`). There
 * a folder swapped for a link after its parent was read is not entered, a
 * link is a skipped entry, and a root the guard refuses lists nothing. Which
 * names are skipped stays `fs-scan.ts`'s rule, passed in.
 *
 * Each walk is a generator that yields after every folder it reads, so one
 * body serves both callers: the sync driver runs it to the end, and the
 * async one gives the event loop a turn every `WALK_SLICE.entries` entries.
 * A Library load on a 200k-entry tree held the loop 5.7s in one walk.
 */
import { type Dirent, type Stats, lstatSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { GuardRefused } from './guard-refused.ts';
import { boundFiles } from './slow-fs.ts';
import { type Contained, type TreeListed, walkTree } from './tree-fs.ts';

/** The most entries a walk under a walled lead's root reads. An object so a
 *  test can lower it rather than build a 200k-entry tree. */
export const CONTAINED_WALK = { max: 200_000 };

/** How many entries the async walk reads between turns of the event loop.
 *  An object so a test can lower it. */
export const WALK_SLICE = { entries: 1_000 };

type Walk<T> = Generator<number, T>;

function runSync<T>(walk: Walk<T>): T {
  for (let step = walk.next(); ; step = walk.next()) if (step.done) return step.value;
}

async function runSliced<T>(walk: Walk<T>): Promise<T> {
  let since = 0;
  for (let step = walk.next(); ; step = walk.next()) {
    if (step.done) return step.value;
    since += step.value;
    if (since >= WALK_SLICE.entries) {
      since = 0;
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
}

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

type Skipped<R extends string> = Array<{ path: string; reason: R }> | null;

/**
 * Every file under `root` the scan lists, as absolute paths spelled from
 * `root`, with the rest pushed onto `skipped` relative to it. Past
 * `CONTAINED_WALK.max` entries it lists nothing, as a refusal would.
 */
export function readdirContained<R extends string>(
  root: string,
  c: Contained | 'refused',
  skipped: Skipped<R>,
  skips: ScanSkips<R>,
): string[] {
  return runSync(walkContained(root, c, skipped, skips));
}

/** `readdirContained`, giving the event loop a turn between slices. */
export function readdirContainedAsync<R extends string>(
  root: string,
  c: Contained | 'refused',
  skipped: Skipped<R>,
  skips: ScanSkips<R>,
): Promise<string[]> {
  return runSliced(walkContained(root, c, skipped, skips));
}

function* walkContained<R extends string>(
  root: string,
  c: Contained | 'refused',
  skipped: Skipped<R>,
  skips: ScanSkips<R>,
): Walk<string[]> {
  if (c === 'refused') return [];
  const base = c.abs === c.root ? '' : relative(c.root, c.abs).split(sep).join('/');
  const inRoot = (rel: string): string => (base === '' ? rel : rel.slice(base.length + 1));
  const enter = (rel: string, name: string): boolean => {
    const reason = skips.skipDir(name);
    if (reason === null) return true;
    if (name !== '.git') skipped?.push({ path: `${inRoot(rel)}/`, reason });
    return false;
  };
  let listed: TreeListed[] | null;
  try {
    listed = yield* walkTree(c, { maxEntries: CONTAINED_WALK.max, enter });
  } catch (err) {
    if (err instanceof GuardRefused) return [];
    throw err;
  }
  if (listed === null) {
    console.error(`[fs-scan] ${c.abs} holds more than ${CONTAINED_WALK.max} entries; listing none`);
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

/**
 * Every file under `dir` the plain walk lists, as absolute paths, with the
 * rest pushed onto `skipped` relative to `root`. An unreadable folder lists
 * nothing. Not capped, as it never was.
 */
export function readdirPlain<R extends string>(
  root: string,
  dir: string,
  skipped: Skipped<R>,
  skips: ScanSkips<R>,
): string[] {
  const out: string[] = [];
  runSync(walkPlain(root, dir, skipped, skips, out));
  return out;
}

/** `readdirPlain`, giving the event loop a turn between slices. */
export async function readdirPlainAsync<R extends string>(
  root: string,
  dir: string,
  skipped: Skipped<R>,
  skips: ScanSkips<R>,
): Promise<string[]> {
  const out: string[] = [];
  await runSliced(walkPlain(root, dir, skipped, skips, out));
  return out;
}

function* walkPlain<R extends string>(
  root: string,
  dir: string,
  skipped: Skipped<R>,
  skips: ScanSkips<R>,
  out: string[],
): Walk<void> {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  yield entries.length;
  for (const entry of entries) {
    const name = entry.name;
    const abs = join(dir, name);
    const rel = (): string => relative(root, abs).split(sep).join('/');
    if (entry.isDirectory()) {
      const reason = skips.skipDir(name);
      // `.git` is the repository's own store, not a file anybody left out.
      if (reason === null) yield* walkPlain(root, abs, skipped, skips, out);
      else if (name !== '.git') skipped?.push({ path: `${rel()}/`, reason });
    } else if (entry.isFile()) {
      const reason = skips.skipFile(name);
      if (reason) skipped?.push({ path: rel(), reason });
      else out.push(abs);
    } else {
      skipped?.push({ path: rel(), reason: skips.notRegular });
    }
  }
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
