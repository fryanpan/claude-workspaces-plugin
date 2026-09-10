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
import { closeSync, fsyncSync, openSync, statSync, writeSync } from 'node:fs';

/** Suffix on the backup, appended to the doc's own `.ydoc` path. */
export const PRE_COMPACT_SUFFIX = '.pre-compact';

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
export function writePreCompactBackup(ydocPath: string, bytes: Uint8Array): BackupOutcome {
  const path = preCompactPath(ydocPath);
  let fd: number | undefined;
  try {
    // 'wx' — create, and fail if it is already there. One syscall, so there
    // is no window between asking and writing.
    fd = openSync(path, 'wx');
    writeSync(fd, bytes);
    // The point of the whole file: on disk, not in the page cache.
    fsyncSync(fd);
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
    return 'failed';
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {}
    }
  }
}
