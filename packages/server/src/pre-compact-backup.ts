/**
 * The one copy of a board doc's pre-compaction bytes.
 *
 * Compacting a `ws:` doc rebuilds it from its own contents and the next
 * debounced save writes that rebuild over the `.ydoc`. The argument that this
 * loses nothing is a good one — the task sidecar is the record, and every
 * trimmed field was measured coming back byte-identical from the detail
 * route — but it is an ARGUMENT, and this repo does not let its durable
 * record be replaced on the strength of one. So the bytes that were on disk
 * before the first compaction are written beside the doc and kept.
 *
 * Two properties carry the whole value of this file, and both are enforced
 * here rather than left to the caller:
 *
 *   - **Written and flushed before the compacted state can reach disk.** The
 *     backup is written, `fsync`ed and closed while the caller still holds
 *     the original bytes, before they are applied to the live doc. A save can
 *     only happen later, off a debounce, so a crash between the two leaves
 *     the backup on disk and the original `.ydoc` untouched — never neither.
 *     `fsync` is the reason this is worth doing synchronously: without it the
 *     bytes sit in the page cache and a power loss takes them.
 *   - **Written in full.** `writeSync` returns a COUNT and POSIX permits it
 *     to be short of what was asked; it does not loop. A short write on a
 *     multi-megabyte buffer leaves a truncated backup that then satisfies
 *     every later check — non-empty, regular, and never replaced because
 *     `wx` refuses to — so the one copy is permanently a partial one while
 *     looking exactly like a working backup. The write loops until every
 *     byte has landed, and the size is read back off the descriptor after
 *     the fsync; a mismatch unlinks the file rather than leaving something
 *     behind that claims to be the backup.
 *   - **Never overwritten.** `wx` fails if the file exists, so a second
 *     compaction cannot replace the pre-compaction bytes with
 *     already-compacted ones. That is the failure that would quietly destroy
 *     the only copy while looking like it was doing its job, and the flag —
 *     not a prior `existsSync` — is what closes it, because the check and the
 *     write would otherwise be two steps with a gap between them.
 *
 * It is safe to delete once someone trusts the compaction; nothing reads it.
 * That is why it is a sibling file rather than an `_archive` entry: it is a
 * one-off safety copy with a name that says what it is, not part of the
 * corpus.
 */
import {
  closeSync,
  fstatSync,
  fsyncSync,
  openSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';

/** Suffix on the backup, appended to the doc's own `.ydoc` path. */
export const PRE_COMPACT_SUFFIX = '.pre-compact';

/**
 * The write syscall, injectable so a test can drive a SHORT write — the
 * failure this module's loop exists for, and one no real filesystem will
 * produce on demand. Production passes `writeSync`.
 */
export type WriteFn = (fd: number, bytes: Uint8Array, offset: number, length: number) => number;

/** What happened, so the caller can log it and a test can assert it. */
export type BackupOutcome = 'written' | 'exists' | 'failed';

/** Where the backup for a given `.ydoc` path lives. */
export function preCompactPath(ydocPath: string): string {
  return `${ydocPath}${PRE_COMPACT_SUFFIX}`;
}

/**
 * Write `bytes` beside `ydocPath`, once, durably.
 *
 * Returns `exists` when a backup is already there — the common case on every
 * restart after the first, and not a failure. Returns `failed` rather than
 * throwing: a backup that cannot be written is a reason to skip the
 * compaction, which is the caller's decision to make, not a reason to fail
 * the whole doc load.
 */
export function writePreCompactBackup(
  ydocPath: string,
  bytes: Uint8Array,
  write: WriteFn = writeSync,
): BackupOutcome {
  const path = preCompactPath(ydocPath);
  let fd: number | undefined;
  // Did WE create the file? Decides whether a failure has a mess to clear up.
  let created = false;
  try {
    // 'wx' — create, and fail if it is already there. One syscall, so there
    // is no window between asking and writing.
    fd = openSync(path, 'wx');
    created = true;
    // Loop: a single writeSync may report fewer bytes than it was handed.
    let written = 0;
    while (written < bytes.length) {
      const n = write(fd, bytes, written, bytes.length - written);
      // A non-positive count would spin forever. Nothing should return one,
      // which is exactly why it must be caught rather than assumed away.
      if (!(n > 0)) throw new Error(`write reported ${n} bytes at offset ${written}`);
      written += n;
    }
    // The point of the whole file: on disk, not in the page cache.
    fsyncSync(fd);
    // Read the size back off the descriptor, after the flush. If the file is
    // not the length it should be, it is not a backup, and leaving it would
    // block every future attempt to write a real one.
    const landed = fstatSync(fd).size;
    if (landed !== bytes.length) {
      closeSync(fd);
      fd = undefined;
      unlinkSync(path);
      console.error(`[doc-store] ${path} came out ${landed} of ${bytes.length} bytes; removed`);
      return 'failed';
    }
    return 'written';
  } catch (err) {
    // Something is already at the path. `EEXIST` alone is not proof it is a
    // GOOD backup: a zero-length file left by a crash, or anything that is
    // not a regular file, would sail through as "already kept" and let the
    // compaction proceed with nothing behind it. So the existing file has to
    // look like bytes before it counts as one.
    if ((err as NodeJS.ErrnoException)?.code === 'EEXIST') {
      try {
        const st = statSync(path);
        if (st.isFile() && st.size > 0) return 'exists';
      } catch {}
      console.error(`[doc-store] ${path} exists but is not a usable backup`);
      return 'failed';
    }
    console.error(`[doc-store] could not write ${path}:`, err);
    // A failure partway through leaves a partial file, and `wx` would refuse
    // to replace it on every future attempt — the truncated copy would become
    // permanent for the same reason a good one is. Clear it.
    if (created) {
      try {
        if (fd !== undefined) {
          closeSync(fd);
          fd = undefined;
        }
        unlinkSync(path);
      } catch {}
    }
    return 'failed';
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {}
    }
  }
}
