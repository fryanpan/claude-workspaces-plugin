import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve as resolvePath, sep } from 'node:path';
import { repoIdentityAt } from './doc-key.ts';
import { findWorktreeRoot } from './doc-origin-repo.ts';
import {
  type FileEntry,
  type MountRecord,
  MountRegistry,
  type ProjectPrivacy,
  type ProjectRecord,
  makeFileKey,
  parseFileKey,
} from './mount-registry.ts';
import {
  type ScannedFile,
  isServableRelPath,
  matchMoves,
  sampleHash,
  scanMount,
} from './mount-scan.ts';
import type { RepoRegistry } from './repo-registry.ts';
import { isWithinRoot } from './safe-path.ts';

/**
 * Mounted folders as they exist on disk: which repo a path belongs to, what a
 * mount currently holds, which address each file answers at, and when a file
 * that moved between two mounts is the same file.
 *
 * Every decision that needs a `stat` is here; `mount-registry.ts` holds the
 * table and no filesystem at all. A file's address is derived exactly the way
 * a document's identity is (`doc-key.ts`): the repo it belongs to plus its
 * path from the repo root — never the checkout it was reached through, so a
 * folder mounted from a worktree and the same folder in the main checkout are
 * one mount holding one set of addresses.
 */

/** How long a reconcile's verdict is trusted before the walk runs again. */
const RECONCILE_TTL_MS = 5_000;

/** A conventions index is prose. Anything past this is not one, and reading it
 *  into a response would be a way to pull an arbitrary file through a verb
 *  that promises a short note. */
const MAX_CONVENTIONS_BYTES = 64 * 1024;

/** The project a host path belongs to. */
export interface ProjectLocation {
  repoKey: string;
  /** The repo's main checkout — where a mount's relative path is joined. */
  mainRoot: string;
  /** The checkout the caller's path was actually in. */
  checkoutRoot: string;
  /** POSIX, relative to `checkoutRoot`. `''` for the checkout root itself. */
  relPath: string;
}

/** One mounted file, as an answer. */
export interface MountedFile {
  fileId: string;
  mountId: string;
  /** POSIX, relative to the REPO root. */
  relPath: string;
  size: number;
  mtimeMs: number;
}

export type MountError =
  | 'not-a-repo'
  | 'not-a-directory'
  | 'refused-path'
  | 'no-such-mount'
  | 'no-root';

export class MountStore {
  readonly registry: MountRegistry;
  private readonly repos: RepoRegistry;
  private readonly reconciledAt = new Map<string, number>();

  constructor(dataDir: string, repos: RepoRegistry) {
    this.registry = new MountRegistry(dataDir);
    this.repos = repos;
  }

  /**
   * Which project a host path belongs to, and how it is spelled inside it.
   *
   * The repoKey is canonicalised through the repo registry, so a project that
   * changed its remote keeps the mounts it had under the old spelling — the
   * registry's alias table is the only thing that knows about the re-key, and
   * a mount table keyed on the raw derivation would quietly orphan itself.
   */
  locate(absPath: string): ProjectLocation | null {
    if (!isAbsolute(absPath) || absPath.includes('\u0000')) return null;
    const abs = resolvePath(absPath);
    const identity = repoIdentityAt(abs);
    const checkoutRoot = findWorktreeRoot(abs);
    if (!identity || !checkoutRoot) return null;
    const rel = relative(checkoutRoot, abs).split(sep).join('/');
    if (rel.startsWith('../')) return null;
    const canonical = this.repos.repoInfo(identity.repoKey);
    return {
      repoKey: canonical?.repoKey ?? identity.repoKey,
      mainRoot: canonical?.mainRoot ?? identity.mainRoot,
      checkoutRoot,
      relPath: rel,
    };
  }

  /**
   * The directory a repo's relative paths are joined to.
   *
   * The main checkout when it is still there, and otherwise the first live
   * checkout the repo registry knows — a project whose main clone was moved
   * or deleted still serves its mounts from a worktree, which is the same
   * survival rule `resolveLiveCopy` applies to documents.
   */
  rootFor(repoKey: string): string | null {
    const info = this.repos.repoInfo(repoKey);
    if (info && existsSync(info.mainRoot)) return info.mainRoot;
    for (const checkout of this.repos.checkoutsFor(repoKey)) {
      if (existsSync(checkout)) return checkout;
    }
    return info?.mainRoot ?? null;
  }

  // ---- Mount and unmount --------------------------------------------------

  /**
   * Mount a folder as project storage.
   *
   * The folder must be a directory inside a git repo, and its relative path
   * must be one a mount may serve — `.git`, any dotdir and any
   * credential-shaped segment are refused HERE as well as at serve time,
   * because a mount whose whole tree is refused is a mount that silently
   * serves nothing, and a lead should be told at the moment they ask.
   */
  mount(
    absPath: string,
  ):
    | { ok: true; mount: MountRecord; project: ProjectLocation; created: boolean }
    | { ok: false; error: MountError } {
    const at = this.locate(absPath);
    if (!at) return { ok: false, error: 'not-a-repo' };
    let isDir = false;
    try {
      isDir = statSync(resolvePath(absPath)).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) return { ok: false, error: 'not-a-directory' };
    if (at.relPath !== '' && !isMountableRelPath(at.relPath)) {
      return { ok: false, error: 'refused-path' };
    }
    const { mount, created } = this.registry.mount(at.repoKey, at.relPath);
    this.reconciledAt.delete(at.repoKey);
    return { ok: true, mount, project: at, created };
  }

  /** Retire a mount. Soft: nothing on disk is touched, and every address the
   *  mount's files hold keeps resolving through the registry. */
  unmount(repoKey: string, mountId: string): boolean {
    const done = this.registry.unmount(repoKey, mountId);
    if (done) this.reconciledAt.delete(repoKey);
    return done;
  }

  /** The absolute directory a mount names, or null if its repo has no root. */
  absOfMount(repoKey: string, mount: MountRecord): string | null {
    const root = this.rootFor(repoKey);
    if (!root) return null;
    return mount.relPath === '' ? root : join(root, mount.relPath);
  }

  // ---- Listing and reconciling -------------------------------------------

  /**
   * Bring the registry level with the disk for one project, and answer what
   * is mounted.
   *
   * Rate-limited by `RECONCILE_TTL_MS`, following `fs-scan`'s listing cache
   * and for the same reason: the walk is the expensive part of every read,
   * and a hammering caller must not be able to turn one request into one walk.
   * `force` is for the paths that have just changed the answer themselves — a
   * fresh mount, and a serve that found its file missing.
   */
  reconcile(repoKey: string, force = false): MountedFile[] {
    const last = this.reconciledAt.get(repoKey) ?? 0;
    const now = Date.now();
    if (!force && now - last < RECONCILE_TTL_MS) return this.recordedFiles(repoKey);
    this.reconciledAt.set(repoKey, now);

    const root = this.rootFor(repoKey);
    if (!root) return [];
    const live = new Map<string, { file: ScannedFile; mountId: string; abs: string }>();
    for (const mount of this.registry.liveMounts(repoKey)) {
      const mountAbs = this.absOfMount(repoKey, mount);
      if (!mountAbs || !existsSync(mountAbs)) continue;
      for (const file of scanMount(mountAbs).files) {
        const abs = join(mountAbs, file.relPath);
        const repoRel = relative(root, abs).split(sep).join('/');
        if (repoRel.startsWith('../')) continue;
        // A file reachable through two overlapping mounts is ONE file with one
        // address; the first mount that lists it is recorded as its home.
        if (!live.has(repoRel)) live.set(repoRel, { file, mountId: mount.mountId, abs });
      }
    }

    const recorded = this.registry.keysUnderRepo(repoKey);
    const gone: Array<{ key: string; size?: number; hash?: string }> = [];
    for (const { key, entry } of recorded) {
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
      if (this.registry.entryFor(key)) continue;
      fresh.push({ key, abs: found.abs, size: found.file.size });
    }

    // Moves first, so a file that moved keeps its address instead of being
    // minted a second one by the claim pass below.
    for (const move of matchMoves(gone, fresh)) {
      const found = live.get(parseFileKey(move.freshKey)?.relPath ?? '');
      if (!found) continue;
      const hash = sampleHash(found.abs, found.file.size);
      const res = this.registry.aliasKey(move.goneKey, move.freshKey, {
        mountId: found.mountId,
        size: found.file.size,
        mtimeMs: found.file.mtimeMs,
        ...(hash === null ? {} : { hash }),
      });
      if (!res.ok) {
        console.error(
          `[mount-store] ${move.goneKey} could not follow the move: ${res.fileId} already answers at the new path`,
        );
      }
    }

    for (const [repoRel, found] of live) {
      const key = makeFileKey(repoKey, repoRel);
      const held = this.registry.entryFor(key);
      // Only a file whose bytes may have changed is fingerprinted again. A
      // 23 GB mount that nobody touched costs stats and nothing else.
      const unchanged =
        held !== undefined &&
        held.size === found.file.size &&
        held.mtimeMs === found.file.mtimeMs &&
        held.mountId === found.mountId;
      if (unchanged) continue;
      const hash = sampleHash(found.abs, found.file.size);
      this.registry.claim(key, {
        mountId: found.mountId,
        size: found.file.size,
        mtimeMs: found.file.mtimeMs,
        ...(hash === null ? {} : { hash }),
      });
    }
    return this.recordedFiles(repoKey);
  }

  /** What the registry currently records for a project, without walking. */
  private recordedFiles(repoKey: string): MountedFile[] {
    const out: MountedFile[] = [];
    for (const { key, entry } of this.registry.keysUnderRepo(repoKey)) {
      const parsed = parseFileKey(key);
      if (!parsed) continue;
      out.push({
        fileId: entry.fileId,
        mountId: entry.mountId,
        relPath: parsed.relPath,
        size: entry.size,
        mtimeMs: entry.mtimeMs,
      });
    }
    out.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
    return out;
  }

  /** Files of one project, or of one of its mounts, paged by relative path. */
  listFiles(
    repoKey: string,
    opts: { mountId?: string; limit?: number; after?: string } = {},
  ): { files: MountedFile[]; nextAfter?: string } {
    const all = this.reconcile(repoKey).filter(
      (f) =>
        (opts.mountId === undefined || f.mountId === opts.mountId) &&
        (opts.after === undefined || f.relPath > opts.after),
    );
    const limit = Math.max(1, Math.min(opts.limit ?? 200, 1000));
    const files = all.slice(0, limit);
    const last = files[files.length - 1];
    return all.length > files.length && last ? { files, nextAfter: last.relPath } : { files };
  }

  // ---- Addresses ----------------------------------------------------------

  /**
   * The file an address names, checked all the way to the byte.
   *
   * Every one of these tests earns its place, and none of them is implied by
   * another: the key has to still be recorded, its mount has to still be
   * live, its spelling has to be one a mount may serve, and the path it
   * resolves to — after symlinks — has to still be inside that mount. The
   * last is `isWithinRoot` rather than a string prefix, because a symlink
   * planted inside a mounted folder is exactly how a lexical check hands out
   * `~/.ssh/id_rsa`.
   *
   * A miss reconciles ONCE and asks again. That is what turns a move into a
   * redirect rather than a 404: the address was recorded against the old path,
   * the reconcile aliases it forward, and the second lookup finds the file
   * where it now lives.
   */
  resolveFile(
    fileId: string,
    retried = false,
  ): { file: MountedFile; abs: string; repoKey: string } | null {
    const key = this.registry.keyOf(fileId);
    if (!key) return null;
    const parsed = parseFileKey(key);
    const entry = this.registry.entryFor(key);
    if (!parsed || !entry) return null;
    const { repoKey, relPath } = parsed;
    const mount = this.registry.mountById(repoKey, entry.mountId);
    const root = this.rootFor(repoKey);
    if (!root || !mount || mount.removedAt !== undefined) return null;
    const mountAbs = this.absOfMount(repoKey, mount);
    if (!mountAbs) return null;
    const abs = join(root, relPath);
    const inMount = mount.relPath === '' ? relPath : relative(mount.relPath, relPath);
    if (!isServableRelPath(relPath) || inMount.startsWith('..')) return null;
    if (!existsSync(abs) || !isWithinRoot(mountAbs, abs)) {
      if (retried) return null;
      this.reconcile(repoKey, true);
      return this.resolveFile(fileId, true);
    }
    let st: import('node:fs').Stats;
    try {
      st = statSync(abs);
    } catch {
      return null;
    }
    if (!st.isFile()) return null;
    return {
      file: {
        fileId,
        mountId: entry.mountId,
        relPath,
        size: st.size,
        mtimeMs: st.mtimeMs,
      },
      abs,
      repoKey,
    };
  }

  // ---- Privacy and conventions -------------------------------------------

  privacyOf(repoKey: string): ProjectPrivacy {
    return this.registry.privacyOf(repoKey);
  }

  setPrivacy(repoKey: string, privacy: ProjectPrivacy): ProjectRecord {
    return this.registry.setPrivacy(repoKey, privacy);
  }

  /**
   * The project's conventions index: where it is, and what it says.
   *
   * `text` is null when the file is not there — an unwritten index is the
   * normal state of a project nobody has set one for, not an error, and the
   * answer still names the path so an agent can write it.
   */
  conventions(repoKey: string): { relPath: string; abs: string | null; text: string | null } {
    const relPath = this.registry.conventionsPathOf(repoKey);
    const root = this.rootFor(repoKey);
    if (!root) return { relPath, abs: null, text: null };
    const abs = join(root, relPath);
    if (!isWithinRoot(root, abs)) return { relPath, abs: null, text: null };
    try {
      if (statSync(abs).size > MAX_CONVENTIONS_BYTES) {
        return { relPath, abs, text: null };
      }
      return { relPath, abs, text: readFileSync(abs, 'utf8') };
    } catch {
      return { relPath, abs, text: null };
    }
  }

  setConventionsPath(repoKey: string, relPath: string): ProjectRecord {
    return this.registry.setConventionsPath(repoKey, relPath);
  }
}

/**
 * Is this a relative path a mount may be rooted at?
 *
 * Narrower than `isServableRelPath`, which judges a FILE. A mount is a
 * directory, so the whole path is directory segments and every one of them
 * gets the dotdir rule — mounting `.claude/mocks` would otherwise create a
 * mount whose every file the walk then refuses.
 */
export function isMountableRelPath(relPath: string): boolean {
  if (relPath === '' || relPath.startsWith('/')) return false;
  for (const part of relPath.split('/')) {
    if (part === '' || part === '.' || part === '..' || part.startsWith('.')) return false;
  }
  return true;
}

export type { FileEntry, MountRecord, ProjectPrivacy, ProjectRecord };
