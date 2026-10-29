/**
 * The guarded half of the bound-file reader (`slow-fs.ts` `boundFiles.guards`):
 * the rule a guard answers to, and the read and write that check where a
 * file really is after it is open rather than before.
 *
 * Asking where a path leads and then opening it is two calls, and a folder
 * link swapped in between them carries the open somewhere else. So a guarded
 * read opens first and asks where the open file is (`/dev/fd/<n>` resolves
 * to the file the descriptor holds), and a guarded write opens its temp file
 * first and asks the same before writing a byte.
 */
import { randomBytes } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { constants, realpathSync } from 'node:fs';
import { type FileHandle, open, readFile, realpath, rename, stat, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, sep } from 'node:path';
import { stampOf } from './file-stamp.ts';

/**
 * Home-relative folders whose full paths must not reach a log line. The files
 * most likely to appear in a quarantine line live in a cloud-sync folder, and
 * these logs get pasted into tickets and PR bodies. Only these two are
 * redacted: a bound doc under a checkout is the ordinary case, and its path is
 * what makes the line useful.
 */
const PRIVATE_ROOTS = ['Dropbox', 'Documents'];

/**
 * A path safe to log: the basename alone under a private root, else the path.
 * Exported so the test runs the real function rather than a copy of its rule.
 */
export function redactBoundPath(path: string): string {
  const home = homedir();
  for (const root of PRIVATE_ROOTS) {
    const prefix = `${home}${sep}${root}${sep}`;
    if (path.startsWith(prefix)) return `<${root}>/${basename(path)}`;
  }
  return path;
}

/**
 * A rule for the bound files under some folders (`PathGuards`). `covers`
 * says whether a path is its business; `admits` is asked on the main thread
 * and must be cheap; `landsInside` is asked with where the path really is,
 * resolved off the main thread.
 */
export interface PathGuard {
  covers(path: string, setId?: string): boolean;
  admits(path: string, setId?: string): boolean;
  landsInside(path: string, real: string, setId?: string): boolean;
}

/** A guarded read or write refused because the file is not where its guard
 *  allows. Never retried into a backoff: the file is not sick. */
export class GuardRefused extends Error {
  constructor(path: string) {
    super(
      `a path guard refused ${redactBoundPath(path)}: it no longer lands inside its bound folder`,
    );
  }
}

/** Where `path` really is, or, when it is not there yet, where its nearest
 *  existing folder is. Null when nothing on the way resolves. */
export function nearestRealpathSync(path: string): string | null {
  for (let p = path; ; p = dirname(p)) {
    try {
      return realpathSync(p);
    } catch (err) {
      if (!isEnoent(err) || dirname(p) === p) return null;
    }
  }
}

/** Where an open file really is now, whatever path opened it: `/dev/fd/<n>`
 *  resolves to the file the descriptor holds, so a link swapped in after
 *  the open, or before it, cannot change the answer. */
function realpathOfOpen(fd: number): Promise<string> {
  return realpath(`/dev/fd/${fd}`);
}

/** A missing file, or a missing folder on its way. */
export function isEnoent(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/**
 * Open `path` for a guarded read and judge what was opened: where the
 * descriptor really is, that it is a regular file (a FIFO or a device would
 * hold a pool thread; the open is non-blocking for the same reason), and
 * that it has one name (a hard link made into a root resolves inside it).
 */
async function openChecked(path: string, lands: (real: string) => boolean): Promise<FileHandle> {
  const fh = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const st = await fh.stat();
    if (!st.isFile() || st.nlink > 1 || !lands(await realpathOfOpen(fh.fd))) {
      throw new GuardRefused(path);
    }
    return fh;
  } catch (err) {
    await fh.close();
    throw err;
  }
}

/** A read that, when given `lands`, opens and then judges the open file
 *  (`openChecked`) before reading a byte; unguarded, a plain read. */
export async function readChecked(
  path: string,
  lands: ((real: string) => boolean) | null,
): Promise<{ text: string } & ReturnType<typeof stampOf>> {
  if (!lands) {
    const [text, st] = await Promise.all([readFile(path, 'utf8'), stat(path, { bigint: true })]);
    return { text, ...stampOf(st) };
  }
  const fh = await openChecked(path, lands);
  try {
    const [text, st] = await Promise.all([fh.readFile('utf8'), fh.stat({ bigint: true })]);
    return { text, ...stampOf(st) };
  } finally {
    await fh.close();
  }
}

/** Bytes `start` to `end` (inclusive) of a file judged as `readChecked`
 *  judges one: what a guarded media request is served from. */
export async function readRangeChecked(
  path: string,
  start: number,
  end: number,
  lands: (real: string) => boolean,
): Promise<Uint8Array<ArrayBuffer>> {
  const fh = await openChecked(path, lands);
  try {
    const out = new Uint8Array(end - start + 1);
    let at = 0;
    while (at < out.length) {
      const { bytesRead } = await fh.read(out, at, out.length - at, start + at);
      if (bytesRead === 0) break;
      at += bytesRead;
    }
    return at === out.length ? out : out.subarray(0, at);
  } finally {
    await fh.close();
  }
}

/** The temp file's flags: made new, never through a link at its own name. */
const TEMP_FLAGS = constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;

/**
 * A write through a temp file, then a rename onto the target.
 *
 * The temp file has a random name and is created new (`O_EXCL`), never
 * through a link at that name (`O_NOFOLLOW`), so a link planted where the
 * temp file goes cannot turn the write, or its cleanup, onto another file.
 * Guarded, it is then judged by where it really is before a byte goes in, so
 * a linked parent folder cannot carry the write outside; refused, only that
 * temp path is removed. The rename names the same folder; if a link has been
 * swapped in since, the temp file is not there and the rename fails.
 */
export async function writeChecked(
  path: string,
  text: string,
  lands: ((real: string) => boolean) | null,
): Promise<BigIntStats> {
  let target = path;
  try {
    target = await realpath(path);
  } catch {}
  const tmp = `${target}.cw-pool-write-${randomBytes(6).toString('hex')}~`;
  // Read-write: /dev/fd/<n> refuses an lstat on a write-only descriptor.
  const fh = await open(tmp, TEMP_FLAGS, 0o644);
  try {
    if (lands && !lands(await realpathOfOpen(fh.fd))) throw new GuardRefused(path);
    await fh.writeFile(text);
  } catch (err) {
    await fh.close();
    await unlink(tmp).catch(() => {});
    throw err;
  }
  await fh.close();
  try {
    await rename(tmp, target);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
  return stat(target, { bigint: true });
}

/**
 * The guards installed on the bound-file reader, asked together. Every
 * method takes the set the path is read for, when the caller knows it, so a
 * guard can hold one set's files and leave another set on the same folder
 * alone; a caller that cannot name the set is held to every guard.
 */
export class PathGuards {
  private readonly set = new Set<PathGuard>();

  add(guard: PathGuard): () => void {
    this.set.add(guard);
    return () => {
      this.set.delete(guard);
    };
  }

  allows(path: string, setId?: string): boolean {
    for (const guard of this.set) if (!guard.admits(path, setId)) return false;
    return true;
  }

  covers(path: string, setId?: string): boolean {
    for (const guard of this.set) if (guard.covers(path, setId)) return true;
    return false;
  }

  private landsAll(path: string, real: string, setId?: string): boolean {
    for (const guard of this.set) if (!guard.landsInside(path, real, setId)) return false;
    return true;
  }

  landsAllowedSync(path: string, setId?: string): boolean {
    if (!this.allows(path, setId)) return false;
    if (!this.covers(path, setId)) return true;
    const real = nearestRealpathSync(path);
    return real !== null && this.landsAll(path, real, setId);
  }

  /** Read a bound file, checked where a guard covers it. */
  read(path: string, setId?: string): ReturnType<typeof readChecked> {
    const lands = (real: string) => this.landsAll(path, real, setId);
    return readChecked(path, this.covers(path, setId) ? lands : null);
  }

  /** A byte range of a covered file, judged as `read` judges one; null
   *  when no guard covers it, for the caller's own unguarded read. */
  readRange(
    path: string,
    start: number,
    end: number,
    setId?: string,
  ): Promise<Uint8Array<ArrayBuffer>> | null {
    if (!this.covers(path, setId)) return null;
    return readRangeChecked(path, start, end, (real) => this.landsAll(path, real, setId));
  }

  /** Write a bound file, checked where a guard covers it. */
  write(path: string, text: string, setId?: string): Promise<BigIntStats> {
    const lands = (real: string) => this.landsAll(path, real, setId);
    return writeChecked(path, text, this.covers(path, setId) ? lands : null);
  }
}
