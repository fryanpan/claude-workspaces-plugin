/**
 * What a mounted folder contains, and how a file that moved between two
 * mounts is recognised as the same file.
 *
 * Two jobs, one file, because the second is defined in terms of the first: a
 * move is a key that left the listing and a key that joined it, holding the
 * same bytes.
 *
 * Everything here is a `stat` walk. Nothing is parsed, nothing is read whole,
 * and no subprocess is spawned — a mount is measured in tens of gigabytes
 * (Weekly Review's run directories are 23 GB), so a listing that read files
 * would be unusable at the size the feature exists for.
 */
import { createHash } from 'node:crypto';
import { closeSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { isSecretShapedName } from './fs-scan.ts';

/** One file in a mount, as the walk found it. */
export interface ScannedFile {
  /** POSIX, relative to the mount ROOT. */
  relPath: string;
  size: number;
  mtimeMs: number;
}

/**
 * Directories a mount walk never descends.
 *
 * `.git` is git's own, and the rest are build output that no project mounts
 * on purpose. Every dotdir is skipped for the same reason `isSecretShapedName`
 * refuses every dotfile: outside a diff review nobody is reviewing
 * configuration through a mount, and a dotdir is where credentials live
 * (`.aws`, `.ssh`, `.config`).
 */
const SKIP_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  'dist',
  'build',
  '.next',
  'coverage',
]);

/**
 * A ceiling on how many files one mount contributes.
 *
 * Not a policy about project size — a bound on the work one request can cause.
 * A mount pointed at a home directory would otherwise walk it, and the walk
 * happens inside a request. Hitting it is reported (`truncated`) rather than
 * swallowed, so a lead sees that the mount is too broad instead of wondering
 * which file is missing.
 */
export const MAX_FILES_PER_MOUNT = 20_000;

export interface MountScan {
  files: ScannedFile[];
  /** True when the walk stopped at `MAX_FILES_PER_MOUNT`. */
  truncated: boolean;
}

/**
 * Every servable file under `root`, sorted by relative path.
 *
 * Symlinks are followed for `stat` but a link that leaves the root is NOT
 * excluded here — containment is checked at the moment a file is served
 * (`isWithinRoot`), which is the check that has to be right, and doing it
 * twice would cost a `realpath` per entry on a walk of hundreds of thousands.
 */
export function scanMount(root: string, maxFiles: number = MAX_FILES_PER_MOUNT): MountScan {
  const files: ScannedFile[] = [];
  const truncated = walk(root, root, files, Math.max(1, maxFiles));
  files.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  return { files, truncated };
}

/** Returns true when the ceiling was hit. */
function walk(root: string, dir: string, out: ScannedFile[], maxFiles: number): boolean {
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    // An unreadable directory is an absent one. A mount that crosses a
    // permission boundary must still list what it can.
    return false;
  }
  // `readdirSync` promises no order, so an unsorted walk would cap on a
  // different subset each run — which is the difference between "these files
  // are over the cap" and "some files are missing today".
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    if (out.length >= maxFiles) return true;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
      if (walk(root, abs, out, maxFiles)) return true;
      continue;
    }
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    if (isSecretShapedName(entry.name)) continue;
    let st: import('node:fs').Stats;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    out.push({
      relPath: relative(root, abs).split(sep).join('/'),
      size: st.size,
      mtimeMs: st.mtimeMs,
    });
  }
  return false;
}

/**
 * Is this a name a mount may serve? The listing's own rule, asked directly.
 *
 * A path is refused when ANY segment is refused, not merely its basename: a
 * mount serves by relative path, so `sub/.env` and `secrets/id_rsa` are
 * reachable spellings and each has to be refused where it is written rather
 * than where it happens to be walked from.
 */
export function isServableRelPath(relPath: string): boolean {
  if (relPath === '' || relPath.startsWith('/')) return false;
  const parts = relPath.split('/');
  for (const part of parts) {
    if (part === '' || part === '.' || part === '..') return false;
  }
  // Directory segments: every dotdir and every heavy build directory, matching
  // the walk. The last segment is the filename and gets the wider rule.
  for (const part of parts.slice(0, -1)) {
    if (part.startsWith('.') || SKIP_DIRS.has(part)) return false;
  }
  const name = parts[parts.length - 1] ?? '';
  return !isSecretShapedName(name);
}

/** How much of each end of a large file the sample hash reads. */
const SAMPLE_BYTES = 64 * 1024;

/**
 * A content fingerprint cheap enough to take on a 20 GB file.
 *
 * The size, the first 64 KiB and the last 64 KiB, hashed together. A file
 * smaller than 128 KiB is hashed WHOLE — the two windows overlap and cover it
 * — so the common case (a screenshot, a note, a PDF page) is an exact hash.
 *
 * The tradeoff is stated rather than hidden: two files that share a size and
 * both ends and differ only in the middle collide, and a move between mounts
 * would then be credited to the wrong one. What that costs is an address
 * pointing at a sibling file in the same project — not a leak, and visible
 * the moment somebody opens it. What a full hash would cost is reading every
 * byte of a mount on every reconcile, which at 23 GB is not a thing a request
 * may do. Only files that DISAPPEARED and files that APPEARED are ever
 * hashed, so the set is bounded by what changed rather than by what exists.
 *
 * Returns null for a file that cannot be read; a file with no fingerprint
 * never matches anything, which is the closed answer.
 */
export function sampleHash(abs: string, size: number): string | null {
  let fd: number;
  try {
    fd = openSync(abs, 'r');
  } catch {
    return null;
  }
  try {
    const h = createHash('sha256');
    h.update(`${size} `);
    const head = Buffer.alloc(Math.min(SAMPLE_BYTES, size));
    if (head.length > 0) {
      const read = readSync(fd, head, 0, head.length, 0);
      h.update(head.subarray(0, read));
    }
    if (size > SAMPLE_BYTES) {
      const tailLen = Math.min(SAMPLE_BYTES, size - SAMPLE_BYTES);
      const tail = Buffer.alloc(tailLen);
      const read = readSync(fd, tail, 0, tailLen, size - tailLen);
      h.update(tail.subarray(0, read));
    }
    return h.digest('hex');
  } catch {
    return null;
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* the descriptor is going away with the process anyway */
    }
  }
}

export interface MoveCandidate {
  /** Key that left the listing. */
  goneKey: string;
  /** Absolute path of the file that appeared. */
  freshAbs: string;
  /** Key that joined the listing. */
  freshKey: string;
  size: number;
}

export interface GoneFile {
  key: string;
  /** The size the file had when it was last seen, or undefined if unrecorded. */
  size?: number;
  /** Its fingerprint when last seen, or undefined if unrecorded. */
  hash?: string;
}

/**
 * Pair each vanished key with the appeared file that holds its bytes.
 *
 * Size first, because a size mismatch is a certain non-match and costs a
 * number comparison; the fingerprint is taken only inside a size bucket. A
 * gone file with no recorded fingerprint cannot be matched at all — its bytes
 * are no longer on disk to hash, so there is nothing to compare, and guessing
 * from the size alone would alias one address onto an unrelated file.
 *
 * One-to-one: a fresh file is claimed by at most one gone key, and the first
 * claim wins. Two identical copies of a moved file are a genuine ambiguity,
 * and picking one arbitrarily is better than aliasing both addresses onto the
 * same path — the loser simply keeps its old key and gets a new address.
 */
export function matchMoves(
  gone: readonly GoneFile[],
  fresh: ReadonlyArray<{ key: string; abs: string; size: number }>,
): MoveCandidate[] {
  const bySize = new Map<number, Array<{ key: string; abs: string; size: number }>>();
  for (const f of fresh) {
    const bucket = bySize.get(f.size);
    if (bucket) bucket.push(f);
    else bySize.set(f.size, [f]);
  }
  const claimed = new Set<string>();
  const out: MoveCandidate[] = [];
  for (const g of gone) {
    if (g.size === undefined || g.hash === undefined) continue;
    const bucket = bySize.get(g.size);
    if (!bucket) continue;
    for (const cand of bucket) {
      if (claimed.has(cand.key)) continue;
      if (sampleHash(cand.abs, cand.size) !== g.hash) continue;
      claimed.add(cand.key);
      out.push({ goneKey: g.key, freshAbs: cand.abs, freshKey: cand.key, size: cand.size });
      break;
    }
  }
  return out;
}
