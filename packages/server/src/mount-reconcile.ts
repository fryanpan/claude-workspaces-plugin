/**
 * One pass of bringing a project's mount table level with its disk.
 *
 * Split out of `mount-store.ts` because it is the one piece of that file
 * with no policy in it: it takes the directories a project mounts and the
 * table those files are recorded in, and it answers which addresses are
 * present right now. Where a mount's directory IS — which checkout, which
 * fallback when that checkout is gone — stays in the store, because that is
 * a decision; this is the walk that follows from it.
 *
 * The order of the two passes is the whole design. Moves are read first, so
 * a file that moved keeps the address it already had instead of being minted
 * a second one by the claim pass; and moves are read at all only off a scan
 * that reached the end of every mount, because a partial listing makes every
 * unseen file look deleted, and a deleted file whose size and fingerprint
 * match a newcomer is exactly what a move looks like.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { type MountRegistry, makeFileKey, parseFileKey } from './mount-registry.ts';
import { type ScannedFile, matchMoves, sampleHash, scanMount } from './mount-scan.ts';

/** One live mount, already resolved to a place on disk. */
export interface MountedDir {
  mountId: string;
  /** POSIX, relative to the repo root. `''` is the repo root itself. */
  relPath: string;
  /** Absolute, in the checkout the mount is served from; null when there is
   *  no checkout to serve it out of at all. */
  abs: string | null;
}

/** What one pass saw. */
export interface ScanResult {
  /** The file keys the walk found, in their current spelling. This is what a
   *  listing is: the table also holds every address the project ever handed
   *  out, and those are not rows to report. */
  present: Set<string>;
  /** A mount held more than `maxFiles` and the walk stopped there. */
  truncated: boolean;
}

export function reconcileProject(
  registry: MountRegistry,
  repoKey: string,
  mounts: readonly MountedDir[],
  maxFiles: number,
): ScanResult {
  const live = new Map<string, { file: ScannedFile; mountId: string; abs: string }>();
  let truncated = false;
  // COMPLETE only when every live mount was walked to its end. A capped walk,
  // an unreadable directory and a mount whose folder is not there all leave
  // files unseen, and an unseen file is not a removed one.
  let complete = true;
  for (const mount of mounts) {
    if (!mount.abs || !existsSync(mount.abs)) {
      complete = false;
      continue;
    }
    const scan = scanMount(mount.abs, maxFiles);
    if (scan.unreadable) complete = false;
    if (scan.truncated) {
      truncated = true;
      complete = false;
      console.error(
        `[mount-reconcile] ${repoKey} mount ${mount.mountId} holds more than ${maxFiles} files; the scan stopped there`,
      );
    }
    for (const file of scan.files) {
      const abs = join(mount.abs, file.relPath);
      // Repo-relative, built from the mount's own spelling rather than by
      // subtracting a checkout root: the mount may be served from a worktree,
      // and the ADDRESS is the same in every checkout.
      const repoRel = mount.relPath === '' ? file.relPath : `${mount.relPath}/${file.relPath}`;
      // A file reachable through two overlapping mounts is ONE file with one
      // address; the first mount that lists it is recorded as its home.
      if (!live.has(repoRel)) live.set(repoRel, { file, mountId: mount.mountId, abs });
    }
  }

  if (complete) followMoves(registry, repoKey, live);

  const present = new Set<string>();
  for (const [repoRel, found] of live) {
    const key = makeFileKey(repoKey, repoRel);
    const held = registry.entryFor(key);
    // Only a file whose bytes may have changed is fingerprinted again. A
    // 23 GB mount that nobody touched costs stats and nothing else.
    const unchanged =
      held !== undefined &&
      held.size === found.file.size &&
      held.mtimeMs === found.file.mtimeMs &&
      held.mountId === found.mountId;
    if (!unchanged) {
      const hash = sampleHash(found.abs, found.file.size);
      registry.claim(key, {
        mountId: found.mountId,
        size: found.file.size,
        mtimeMs: found.file.mtimeMs,
        ...(hash === null ? {} : { hash }),
      });
    }
    present.add(registry.resolveKey(key));
  }
  return { present, truncated };
}

/**
 * Alias forward every address whose file left one path and turned up at
 * another. Nobody commands a move; it is read off the difference between the
 * table and the walk, and confirmed by the sampled fingerprint.
 */
function followMoves(
  registry: MountRegistry,
  repoKey: string,
  live: ReadonlyMap<string, { file: ScannedFile; mountId: string; abs: string }>,
): void {
  const gone: Array<{ key: string; size?: number; hash?: string }> = [];
  for (const { key, entry } of registry.keysUnderRepo(repoKey)) {
    const parsed = parseFileKey(key);
    if (!parsed || live.has(parsed.relPath)) continue;
    const row: { key: string; size?: number; hash?: string } = { key };
    if (entry.size !== undefined) row.size = entry.size;
    if (entry.hash !== undefined) row.hash = entry.hash;
    gone.push(row);
  }
  const fresh: Array<{ key: string; abs: string; size: number }> = [];
  for (const [repoRel, found] of live) {
    const key = makeFileKey(repoKey, repoRel);
    if (registry.entryFor(key)) continue;
    fresh.push({ key, abs: found.abs, size: found.file.size });
  }

  for (const move of matchMoves(gone, fresh)) {
    const found = live.get(parseFileKey(move.freshKey)?.relPath ?? '');
    if (!found) continue;
    const hash = sampleHash(found.abs, found.file.size);
    const res = registry.aliasKey(move.goneKey, move.freshKey, {
      mountId: found.mountId,
      size: found.file.size,
      mtimeMs: found.file.mtimeMs,
      ...(hash === null ? {} : { hash }),
    });
    if (!res.ok) {
      console.error(
        `[mount-reconcile] ${move.goneKey} could not follow the move: ${res.fileId} already answers at the new path`,
      );
    }
  }
}
