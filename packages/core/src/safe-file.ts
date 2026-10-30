/**
 * Reading and replacing a small file in a folder somebody else may write.
 *
 * A walled lead runs as the owner's user and can write most of `~/.claude`
 * and its own scratch folder. Anything the server, its supervisor, a hook or
 * an MCP child reads or replaces there may have become a FIFO (a plain read
 * blocks the calling thread forever) or a link (a plain read follows it, a
 * plain write lands at its target). So:
 *
 * - `readSmallFile` opens with `O_NOFOLLOW|O_NONBLOCK`, takes only a regular
 *   file, and refuses one over `max` bytes. It answers null for anything
 *   else, never blocks and never throws.
 * - `replaceFile` writes a temp file with a random name, created new
 *   (`O_EXCL`) and never through a link (`O_NOFOLLOW`), checks the name still
 *   holds the file and the bytes it wrote, then renames it over the target. A link at the
 *   target is replaced, never followed.
 *
 * These guard the LAST name only. A folder on the way that is itself a link
 * is followed, so the folders that matter must be ones the lead cannot
 * write; the wall makes them read-only (`scripts/lead-sandbox-lib.ts`).
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  constants,
  closeSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

/** The most `readSmallFile` reads by default: far above any file it guards. */
export const SMALL_FILE_MAX = 64 * 1024;

/** A regular file's text, or null when it is missing, not a regular file,
 *  a link, or larger than `max`. */
export function readSmallFile(path: string, max = SMALL_FILE_MAX): string | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > max) return null;
    const buf = Buffer.alloc(max + 1);
    let at = 0;
    for (;;) {
      const n = readSync(fd, buf, at, buf.length - at, at);
      if (n === 0) break;
      at += n;
      if (at > max) return null;
    }
    return buf.subarray(0, at).toString('utf8');
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** Whether a regular file (not a link to one) is at `path`. */
export function isPlainFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

const TEMP_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;

/** A temp file written beside its target, not yet renamed into place:
 *  its inode and a digest of what was written to it. */
export interface PendingTemp {
  tmp: string;
  ino: number;
  digest: string;
}

const digestOf = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Write `text` to a new random-named temp file beside `path`: created new
 *  (`O_EXCL`), never through a link (`O_NOFOLLOW`). Throws when it cannot,
 *  leaving nothing behind. */
export function writeTempBeside(path: string, text: string, mode = 0o644): PendingTemp {
  const tmp = join(dirname(path), `.${basename(path)}.${randomBytes(8).toString('hex')}.tmp`);
  const fd = openSync(tmp, TEMP_FLAGS, mode);
  try {
    // The mode as asked, whatever the umask took off it.
    fchmodSync(fd, mode);
    const bytes = Buffer.from(text, 'utf8');
    let at = 0;
    while (at < bytes.length) at += writeSync(fd, bytes, at, bytes.length - at);
    return { tmp, ino: fstatSync(fd).ino, digest: digestOf(bytes) };
  } catch (err) {
    unlinkQuietly(tmp);
    throw err;
  } finally {
    closeSync(fd);
  }
}

/** Rename a pending temp over `path`, if its name still holds the file and
 *  the bytes that were written; otherwise remove whatever is at the name and
 *  throw. The bytes are compared because the inode is no proof: the temp may
 *  be rewritten in place, and Linux gives a new file the inode just freed. */
export function commitTemp(pending: PendingTemp, path: string): void {
  try {
    const st = lstatSync(pending.tmp);
    const text = st.isFile() && st.ino === pending.ino ? readSmallFile(pending.tmp, st.size) : null;
    if (text === null || digestOf(Buffer.from(text, 'utf8')) !== pending.digest)
      throw new Error(`${pending.tmp} was replaced before the rename`);
    renameSync(pending.tmp, path);
  } catch (err) {
    unlinkQuietly(pending.tmp);
    throw err;
  }
}

/** Drop a pending temp without renaming it. */
export function discardTemp(pending: PendingTemp): void {
  unlinkQuietly(pending.tmp);
}

/** Replace `path` with `text` through a random-named temp file beside it.
 *  Throws when it cannot; the target is then untouched. */
export function replaceFile(path: string, text: string, mode = 0o644): void {
  commitTemp(writeTempBeside(path, text, mode), path);
}

function unlinkQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {}
}
