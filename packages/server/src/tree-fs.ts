/**
 * Reading, listing, making folders in and writing a file tree a walled lead
 * controls, without ever following a link the lead made.
 *
 * The server runs as the owner, outside the lead's wall, and acts on files
 * under the lead's registered roots (`board-socket-roots.ts`). The rule here:
 * every call on such a path either refuses a link in every component
 * (`O_NOFOLLOW_ANY`, `RENAME_NOFOLLOW_ANY`) or is an `*at` call on a folder
 * descriptor that was itself opened that way. The kernel checks each name as
 * it resolves the path, so no gap opens between a check and a use.
 *
 * A path here is a `Contained`: a root as stored (resolved, so no link above
 * it) and the absolute path under it, with no empty, `.` or `..` name. After
 * every open the descriptor is judged:
 *
 * - the root is still the folder that was registered (`pinRoot`: its device
 *   and inode), opened with no link on its path;
 * - the descriptor is on the root's device, so a volume mounted inside a
 *   root is not entered;
 * - a file is a regular file with one name (a hard link made into a root
 *   names an outside inode); a folder is a folder;
 * - where the descriptor really is (`/dev/fd/<n>`) is under the root, which
 *   catches a folder moved out of the root while the kernel was resolving it.
 *
 * A file whose bytes are in the cloud (`SF_DATALESS`) is refused before it is
 * opened: this server turns materialization on (`dataless-policy.ts`), so
 * opening one waits for its download, and most callers here are synchronous.
 *
 * macOS only: a walled lead exists only there. Elsewhere `treeFsMode()` is
 * `'legacy'` and callers keep the plain path checks of `bound-path-guard.ts`.
 * On macOS without the native calls it is `'refuse'`, and every covered path
 * is refused rather than handled with less.
 */
import { randomBytes } from 'node:crypto';
import type { BigIntStats, Stats } from 'node:fs';
import {
  constants,
  closeSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  writeSync,
} from 'node:fs';
import { type FileHandle, open } from 'node:fs/promises';
import { GuardRefused } from './guard-refused.ts';
import {
  DT_DIR,
  DT_LNK,
  DT_REG,
  SF_DATALESS,
  type TreeNative,
  treeNative,
} from './tree-fs-native.ts';

/** Darwin's `O_NOFOLLOW_ANY`: the open fails if any component is a link. */
export const O_NOFOLLOW_ANY = 0x20000000;
const DIR_OPEN = constants.O_RDONLY | constants.O_DIRECTORY | O_NOFOLLOW_ANY;
const FILE_OPEN = constants.O_RDONLY | constants.O_NONBLOCK | O_NOFOLLOW_ANY;
const TEMP_OPEN = constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW_ANY;
const EEXIST = 17;

/** A path under a lead's root: `abs` is `root`, or `root/<names>`. */
export interface Contained {
  root: string;
  abs: string;
}

export type TreeFsMode = 'contained' | 'legacy' | 'refuse';

/** How covered paths are handled on this machine (see the header). */
export function treeFsMode(): TreeFsMode {
  if (process.platform !== 'darwin') return 'legacy';
  return treeNative() ? 'contained' : 'refuse';
}

function native(path: string): TreeNative {
  const n = treeNative();
  if (!n) throw new GuardRefused(path, 'the contained file calls are not available');
  return n;
}

/** The names below the root, or a refusal for a path not written as one. */
export function namesOf(c: Contained): string[] {
  if (c.abs === c.root) return [];
  if (!c.abs.startsWith(`${c.root}/`)) throw new GuardRefused(c.abs, 'it is not under its root');
  const names = c.abs.slice(c.root.length + 1).split('/');
  if (names.some((n) => n === '' || n === '.' || n === '..' || n.includes('\0')))
    throw new GuardRefused(c.abs, 'its path has an empty, . or .. name');
  return names;
}

const pins = new Map<string, { dev: number; ino: number }>();

/** Record what `root` is now, so a folder put in its place later is refused.
 *  Called when a root is registered; a root first seen otherwise is pinned
 *  then. */
export function pinRoot(root: string): void {
  if (process.platform !== 'darwin') return;
  const fd = openSync(root, DIR_OPEN);
  try {
    const st = fstatSync(fd);
    pins.set(root, { dev: st.dev, ino: st.ino });
  } finally {
    closeSync(fd);
  }
}

/** The root's device, once the root is shown to be the registered folder. */
function rootDev(root: string): number {
  let fd: number;
  try {
    fd = openSync(root, DIR_OPEN);
  } catch {
    throw new GuardRefused(root, 'its root does not open without a link');
  }
  try {
    const st = fstatSync(fd);
    const pin = pins.get(root);
    if (!pin) pins.set(root, { dev: st.dev, ino: st.ino });
    else if (pin.dev !== st.dev || pin.ino !== st.ino)
      throw new GuardRefused(root, 'its root is not the folder that was registered');
    return st.dev;
  } finally {
    closeSync(fd);
  }
}

/** `openSync` with the kernel's refusal of a link (ELOOP) as a guard's. */
function openNoLink(path: string, flags: number, mode?: number): number {
  try {
    return openSync(path, flags, mode);
  } catch (err) {
    throw linkRefusal(err, path);
  }
}

async function openNoLinkAsync(path: string, flags: number, mode?: number): Promise<FileHandle> {
  try {
    return await open(path, flags, mode);
  } catch (err) {
    throw linkRefusal(err, path);
  }
}

function linkRefusal(err: unknown, path: string): unknown {
  return (err as NodeJS.ErrnoException | undefined)?.code === 'ELOOP'
    ? new GuardRefused(path, 'it, or a folder on its way, is a link')
    : err;
}

/** Called between an open and its judging; a test moves a folder there. */
let seam: ((c: Contained) => void) | null = null;
export function setTreeSeamForTest(fn: ((c: Contained) => void) | null): void {
  seam = fn;
}

function judge(fd: number, c: Contained, dev: number, kind: 'file' | 'dir'): BigIntStats {
  seam?.(c);
  const st = fstatSync(fd, { bigint: true });
  if (Number(st.dev) !== dev) throw new GuardRefused(c.abs, 'it is on another volume');
  if (kind === 'dir' && !st.isDirectory()) throw new GuardRefused(c.abs, 'it is not a folder');
  if (kind === 'file' && (!st.isFile() || st.nlink !== 1n))
    throw new GuardRefused(c.abs, 'it is not a regular file with one name');
  const real = realpathSync(`/dev/fd/${fd}`);
  if (real !== c.root && !real.startsWith(`${c.root}/`))
    throw new GuardRefused(c.abs, 'it is no longer under its root');
  return st;
}

function refuseDataless(c: Contained): void {
  const flags = native(c.abs).flagsAt(c.abs);
  if (flags !== null && (flags & SF_DATALESS) !== 0)
    throw new GuardRefused(c.abs, 'its bytes are not on this disk');
}

/** Close `fd` when `fn` throws, and rethrow. */
function closingOnThrow<T>(fd: number, fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    closeSync(fd);
    throw err;
  }
}

/** A judged descriptor for reading the file at `c`, and its stat. */
export function openFileSync(c: Contained): { fd: number; st: BigIntStats } {
  const dev = rootDev(c.root);
  if (namesOf(c).length === 0) throw new GuardRefused(c.abs, 'a root is not a file');
  refuseDataless(c);
  const fd = openNoLink(c.abs, FILE_OPEN);
  return closingOnThrow(fd, () => ({ fd, st: judge(fd, c, dev, 'file') }));
}

/** `openFileSync` with the open itself on the thread pool, for a caller
 *  that races it against a deadline (`slow-fs.ts`). */
export async function openFile(c: Contained): Promise<{ fh: FileHandle; st: BigIntStats }> {
  const dev = rootDev(c.root);
  if (namesOf(c).length === 0) throw new GuardRefused(c.abs, 'a root is not a file');
  refuseDataless(c);
  const fh = await openNoLinkAsync(c.abs, FILE_OPEN);
  try {
    return { fh, st: judge(fh.fd, c, dev, 'file') };
  } catch (err) {
    await fh.close();
    throw err;
  }
}

/** At most `max` bytes of the file at `c`, or `'too-large'`. */
export function readTreeSync(c: Contained, max: number): Uint8Array<ArrayBuffer> | 'too-large' {
  const { fd, st } = openFileSync(c);
  try {
    if (st.size > BigInt(max)) return 'too-large';
    return new Uint8Array(readFileSync(fd));
  } finally {
    closeSync(fd);
  }
}

/** `readTreeSync` on the thread pool, with the stat it was read under. */
export async function readTree(
  c: Contained,
  max: number,
): Promise<{ bytes: Uint8Array<ArrayBuffer>; st: BigIntStats } | 'too-large'> {
  const { fh, st } = await openFile(c);
  try {
    if (st.size > BigInt(max)) return 'too-large';
    return { bytes: new Uint8Array(await fh.readFile()), st };
  } finally {
    await fh.close();
  }
}

/** Bytes `start` to `end` (inclusive) of the file at `c`. */
export function readTreeRangeSync(
  c: Contained,
  start: number,
  end: number,
): Uint8Array<ArrayBuffer> {
  const { fd } = openFileSync(c);
  try {
    const out = new Uint8Array(Math.max(0, end - start + 1));
    let at = 0;
    while (at < out.length) {
      const got = readSync(fd, out, at, out.length - at, start + at);
      if (got === 0) break;
      at += got;
    }
    return at === out.length ? out : out.subarray(0, at);
  } finally {
    closeSync(fd);
  }
}

/** The stat of the file at `c`, from its judged descriptor. */
export function statTreeSync(c: Contained): Stats {
  const { fd } = openFileSync(c);
  try {
    return fstatSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** `statTreeSync`, with the open on the thread pool. */
export async function statTree(c: Contained): Promise<BigIntStats> {
  const { fh, st } = await openFile(c);
  await fh.close();
  return st;
}

function openDir(c: Contained, dev: number): number {
  const fd = openNoLink(c.abs, DIR_OPEN);
  return closingOnThrow(fd, () => {
    judge(fd, c, dev, 'dir');
    return fd;
  });
}

export interface TreeListed {
  /** Root-relative, `/`-separated. */
  rel: string;
  kind: 'file' | 'dir' | 'link' | 'other';
}

/**
 * Every entry under the folder `c`, walked through judged descriptors: a
 * link is reported as one and never entered, and a folder that no longer
 * opens without one is skipped. `enter` says whether to walk into a folder.
 * Null past `maxEntries`, as a listing too big to give.
 */
export function listTreeSync(
  c: Contained,
  opts: { maxEntries: number; enter?: (rel: string, name: string) => boolean },
): TreeListed[] | null {
  const n = native(c.abs);
  const dev = rootDev(c.root);
  const base = namesOf(c).join('/');
  const out: TreeListed[] = [];
  const dirs: string[] = [base];
  let first = true;
  while (dirs.length > 0) {
    const rel = dirs.pop() ?? '';
    const abs = rel === '' ? c.root : `${c.root}/${rel}`;
    let fd: number;
    try {
      fd = openDir({ root: c.root, abs }, dev);
    } catch (err) {
      if (first) throw err;
      continue;
    }
    first = false;
    const entries = closingOnThrow(fd, () => n.readdirFd(fd, opts.maxEntries - out.length));
    if (entries === null) return null;
    for (const e of entries) {
      const childRel = rel === '' ? e.name : `${rel}/${e.name}`;
      const kind =
        e.type === DT_DIR
          ? 'dir'
          : e.type === DT_REG
            ? 'file'
            : e.type === DT_LNK
              ? 'link'
              : 'other';
      out.push({ rel: childRel, kind });
      if (kind === 'dir' && (opts.enter?.(childRel, e.name) ?? true)) dirs.push(childRel);
    }
  }
  return out;
}

/** `mkdir -p` for `c`, one name at a time, each made with `mkdirat` in the
 *  judged folder above it. */
export function mkdirTreeSync(c: Contained): void {
  const n = native(c.abs);
  const dev = rootDev(c.root);
  let at = c.root;
  let fd = openDir({ root: c.root, abs: at }, dev);
  try {
    for (const name of namesOf(c)) {
      const next = `${at}/${name}`;
      let child: number;
      try {
        child = openDir({ root: c.root, abs: next }, dev);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        const e = n.mkdirat(fd, name, 0o755);
        if (e !== 0 && e !== EEXIST) throw errnoError('mkdirat', e, next);
        child = openDir({ root: c.root, abs: next }, dev);
      }
      closeSync(fd);
      fd = child;
      at = next;
    }
  } finally {
    closeSync(fd);
  }
}

function errnoError(call: string, errno: number, path: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${call} failed with errno ${errno} on ${path}`), { errno });
}

/** Refuse a target that is a link, or that names an inode with another
 *  name: the write would replace a link, or appear to replace a file
 *  somebody else still reads by its other name. A missing target is fine. */
function refuseTarget(c: Contained, dev: number): void {
  let fd: number;
  try {
    refuseDataless(c);
    fd = openNoLink(c.abs, FILE_OPEN);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  try {
    judge(fd, c, dev, 'file');
  } finally {
    closeSync(fd);
  }
}

interface WritePlan {
  n: TreeNative;
  dev: number;
  dir: string;
  name: string;
  tmpName: string;
}

function planWrite(c: Contained, lane: string): WritePlan {
  const n = native(c.abs);
  const dev = rootDev(c.root);
  const names = namesOf(c);
  const name = names.at(-1);
  if (name === undefined) throw new GuardRefused(c.abs, 'a root is not a file');
  refuseTarget(c, dev);
  const dir = names.length === 1 ? c.root : `${c.root}/${names.slice(0, -1).join('/')}`;
  return { n, dev, dir, name, tmpName: tempName(name, lane) };
}

/** The temp file's name beside the target: random, so nothing can be
 *  planted at it ahead of the write. A test fixes it (`setTempNameForTest`). */
let tempName = (name: string, lane: string): string =>
  `${name}.cw-${lane}-${randomBytes(6).toString('hex')}~`;
export function setTempNameForTest(fn: ((name: string, lane: string) => string) | null): void {
  tempName = fn ?? ((name, lane) => `${name}.cw-${lane}-${randomBytes(6).toString('hex')}~`);
}

/** Rename the temp onto the target inside the judged folder, or remove it. */
function commit(p: WritePlan, dirFd: number, target: string): void {
  const e = p.n.renameat(dirFd, p.tmpName, p.name);
  if (e !== 0) {
    p.n.unlinkat(dirFd, p.tmpName);
    throw errnoError('renameatx_np', e, target);
  }
}

/**
 * Write `bytes` to the file at `c` through a temp file in its folder: the
 * temp is created new with no link on its path and judged before a byte
 * goes in, and renamed onto the target in the judged folder with no link
 * allowed in either name. A refusal removes the temp through that folder.
 */
export function writeTreeSync(c: Contained, bytes: Uint8Array, lane: string): BigIntStats {
  const p = planWrite(c, lane);
  const dirFd = openDir({ root: c.root, abs: p.dir }, p.dev);
  try {
    const tmp = { root: c.root, abs: `${p.dir}/${p.tmpName}` };
    const fd = openNoLink(tmp.abs, TEMP_OPEN, 0o644);
    let st: BigIntStats;
    try {
      judge(fd, tmp, p.dev, 'file');
      let at = 0;
      while (at < bytes.length) at += writeSync(fd, bytes, at, bytes.length - at);
      st = fstatSync(fd, { bigint: true });
    } catch (err) {
      closeSync(fd);
      p.n.unlinkat(dirFd, p.tmpName);
      throw err;
    }
    closeSync(fd);
    commit(p, dirFd, c.abs);
    return st;
  } finally {
    closeSync(dirFd);
  }
}

/** `writeTreeSync` with the temp's bytes written on the thread pool. */
export async function writeTree(c: Contained, text: string, lane: string): Promise<BigIntStats> {
  const p = planWrite(c, lane);
  const dirFd = openDir({ root: c.root, abs: p.dir }, p.dev);
  try {
    const tmp = { root: c.root, abs: `${p.dir}/${p.tmpName}` };
    const fh = await openNoLinkAsync(tmp.abs, TEMP_OPEN, 0o644);
    let st: BigIntStats;
    try {
      judge(fh.fd, tmp, p.dev, 'file');
      await fh.writeFile(text);
      st = await fh.stat({ bigint: true });
    } catch (err) {
      await fh.close();
      p.n.unlinkat(dirFd, p.tmpName);
      throw err;
    }
    await fh.close();
    commit(p, dirFd, c.abs);
    return st;
  } finally {
    closeSync(dirFd);
  }
}
