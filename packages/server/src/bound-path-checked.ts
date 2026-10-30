/**
 * The plain-path checks behind a guarded read or write (`bound-path-guard.ts`):
 * resolve, open with no link allowed anywhere, then judge where the open
 * file really is. On macOS a path under a walled lead's root is handled by
 * `tree-fs.ts` instead; these answer every other guarded path, and every
 * guarded path off macOS.
 *
 * Asking where a path leads and then opening it is two calls, and a folder
 * link swapped in between them carries the open somewhere else. So a guarded
 * read opens first and asks where the open file is (`/dev/fd/<n>` resolves
 * to the file the descriptor holds), and a guarded write opens its temp file
 * first and asks the same before writing a byte.
 */
import { randomBytes } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import {
  constants,
  closeSync,
  fstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { type FileHandle, open, readFile, realpath, rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { stampOf } from './file-stamp.ts';
import { GuardRefused } from './guard-refused.ts';

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

/** Darwin's `O_NOFOLLOW_ANY`: the open fails if any component is a link. */
const O_NOFOLLOW_ANY = 0x20000000;
const CHECKED_OPEN = constants.O_RDONLY | constants.O_NONBLOCK | O_NOFOLLOW_ANY;
export const UTF8 = new TextDecoder('utf-8', { ignoreBOM: true }); // keeps a BOM, as readFileSync does
/** The most text a guarded read returns. Past it a file is not a doc. */
export const GUARDED_TEXT_MAX = 16 * 1024 * 1024;

/**
 * Open `path` for a guarded read and judge what was opened: where the
 * descriptor really is, that it is a regular file (a FIFO or a device would
 * hold a pool thread; the open is non-blocking for the same reason), and
 * that it has one name (a hard link made into a root resolves inside it).
 * The path is resolved first and opened with no link allowed anywhere, so a
 * link swapped in after the resolve fails the open instead of being followed.
 */
async function openChecked(path: string, lands: (real: string) => boolean): Promise<FileHandle> {
  const fh = await open(await realpath(path), CHECKED_OPEN);
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
    const st = await fh.stat({ bigint: true });
    if (st.size > BigInt(GUARDED_TEXT_MAX)) throw new GuardRefused(path);
    return { text: await fh.readFile('utf8'), ...stampOf(st) };
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

/** A whole file judged as `readChecked` judges one, as bytes with its
 *  stat, or `'too-large'` past `max` bytes: a guarded image answer. */
export async function readBytesChecked(
  path: string,
  max: number,
  lands: (real: string) => boolean,
): Promise<{ bytes: Uint8Array<ArrayBuffer>; st: BigIntStats } | 'too-large'> {
  const fh = await openChecked(path, lands);
  try {
    const st = await fh.stat({ bigint: true });
    if (st.size > BigInt(max)) return 'too-large';
    const out = new Uint8Array(Number(st.size));
    let at = 0;
    while (at < out.length) {
      const { bytesRead } = await fh.read(out, at, out.length - at, at);
      if (bytesRead === 0) break;
      at += bytesRead;
    }
    return { bytes: at === out.length ? out : out.subarray(0, at), st };
  } finally {
    await fh.close();
  }
}

/** A file's stat, judged as `readChecked` judges one: from the descriptor,
 *  so a link is never stat'd for where it points and a FIFO never blocks. */
export async function statChecked(
  path: string,
  lands: (real: string) => boolean,
): Promise<BigIntStats> {
  const fh = await openChecked(path, lands);
  try {
    return await fh.stat({ bigint: true });
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
  // Judge the folder first, so a refused write makes no file outside at all;
  // the check after the open is the one a swap cannot get past.
  if (lands && !lands(join(await realpath(dirname(target)), basename(target)))) {
    throw new GuardRefused(path);
  }
  const tmp = tempBeside(target, 'pool-write');
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

/** The temp file's name beside `target`, for one writer's lane: random,
 *  so nothing can be planted at it ahead of the write. */
function tempBeside(target: string, lane: 'pool-write' | 'flush' | 'export'): string {
  return `${target}.cw-${lane}-${randomBytes(6).toString('hex')}~`;
}

/** `openChecked` on the calling thread, for the synchronous reads. */
export function openCheckedSync(path: string, lands: (real: string) => boolean): number {
  const fd = openSync(realpathSync(path), CHECKED_OPEN);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink > 1 || !lands(realpathSync(`/dev/fd/${fd}`))) {
      throw new GuardRefused(path);
    }
    return fd;
  } catch (err) {
    closeSync(fd);
    throw err;
  }
}

/** `readChecked` on the calling thread: the attach without a preread, the
 *  reparse and the synchronous reconcile. Unguarded, a plain read. */
export function readCheckedSync(path: string, lands: ((real: string) => boolean) | null): string {
  if (!lands) return readFileSync(path, 'utf8');
  const fd = openCheckedSync(path, lands);
  try {
    if (fstatSync(fd).size > GUARDED_TEXT_MAX) throw new GuardRefused(path);
    return readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
}

/** `writeChecked` on the calling thread, through a temp file of `lane`'s
 *  own: the shutdown flush and the export of a file not there yet. */
export function writeCheckedSync(
  path: string,
  text: string,
  lane: 'flush' | 'export',
  lands: ((real: string) => boolean) | null,
): void {
  let target = path;
  try {
    target = realpathSync(path);
  } catch {}
  if (lands && !lands(join(realpathSync(dirname(target)), basename(target)))) {
    throw new GuardRefused(path);
  }
  const tmp = tempBeside(target, lane);
  const fd = openSync(tmp, TEMP_FLAGS, 0o644);
  try {
    if (lands && !lands(realpathSync(`/dev/fd/${fd}`))) throw new GuardRefused(path);
    const bytes = Buffer.from(text, 'utf8');
    let at = 0;
    while (at < bytes.length) at += writeSync(fd, bytes, at, bytes.length - at);
    closeSync(fd);
    renameSync(tmp, target);
  } catch (err) {
    try {
      closeSync(fd);
    } catch {}
    try {
      unlinkSync(tmp);
    } catch {}
    throw err;
  }
}
