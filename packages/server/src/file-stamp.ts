/**
 * The stamp that tells the disk→doc poll a bound file has changed.
 *
 * The poll cannot read a bound file every tick — that is the syscall it
 * exists to avoid — so it compares a cheap stamp instead: the file's mtime
 * and its size. Whether that stamp can see an edit at all is decided here, by
 * how precisely the mtime is read.
 *
 * `stat().mtimeMs` is whole milliseconds under Bun, so two writes inside one
 * millisecond carry the SAME stamp; if such a write also leaves the file
 * exactly the same length, neither half of the stamp moves and the poll
 * concludes nothing happened — permanently, because the mtime it found is the
 * mtime it left. The disk is not the limit: APFS resolves nanoseconds and
 * gave six distinct stamps for six back-to-back writes where `mtimeMs` gave
 * one. `{ bigint: true }` is what asks the kernel for them.
 *
 * The nanoseconds are handed on as fractional milliseconds rather than as a
 * bigint so every existing comparison stays a number comparison — the
 * `.ydoc`-versus-file arbitration compares this against an ordinary
 * `statSync().mtimeMs` and would throw on a mixed compare. A double holds
 * today's epoch to ~256ns, three orders of magnitude finer than the gap
 * between two consecutive writes (~30µs measured).
 *
 * What the stamp still cannot see, whatever the precision: a same-length
 * write that lands on a filesystem whose own timestamp granularity is coarser
 * than the gap (a network mount, FAT, HFS+ at one second), and a same-length
 * write that deliberately restores the previous mtime (`touch -r`, an archive
 * or an rsync that preserves times). Closing those needs the file's CONTENT,
 * which is the per-tick read the poll is built to skip.
 */
import { type BigIntStats, statSync } from 'node:fs';

/** The stamp itself: a fractional-millisecond mtime and the byte count. */
export interface FileStamp {
  mtimeMs: number;
  size: number;
}

/** The stamp of a file somebody has already stat'ed with `{ bigint: true }`. */
export function stampOf(st: BigIntStats): FileStamp {
  return { mtimeMs: Number(st.mtimeNs) / 1e6, size: Number(st.size) };
}

/** The stamp of a file, read synchronously. Throws exactly like `statSync`. */
export function statStampSync(path: string): FileStamp {
  return stampOf(statSync(path, { bigint: true }));
}
