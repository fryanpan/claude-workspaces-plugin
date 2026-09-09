import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import {
  DEFAULT_CONVENTIONS_PATH,
  type FileEntry,
  MOUNT_REGISTRY_FILE,
  type MountRecord,
  type MountRegistryFile,
  type ProjectPrivacy,
  type ProjectRecord,
  readMountRegistryFile,
  writeMountRegistryFile,
} from './mount-registry-file.ts';

/**
 * Which folders of a project are mounted as its attachment storage, what
 * address each file in them has, and whether any of it may leave the machine.
 *
 * The table only. Nothing here touches the filesystem or knows what a repo
 * root is — `mount-store.ts` holds every decision that needs a `stat`, and
 * this holds the decisions that need only the record. That split is what lets
 * the alias rules below be tested without a fixture tree.
 *
 * **Alias semantics are copied from `repo-registry.ts` deliberately**, and
 * for the same reason: a claim NEVER repoints, so an address that has been
 * written into somebody's comment cannot silently start resolving to another
 * file; a move records the old key as an alias of the new one, so the address
 * and the comments on it follow the file while every link ever written
 * against the old spelling keeps working. What is not shared is the TABLE —
 * a mounted file is not a document, has no `.ydoc`, and must not be able to
 * collide with a doc key for the same path.
 *
 * Nothing here ever deletes. An unmounted folder keeps its row with a
 * `removedAt`, and no key is ever dropped: retention is the project's, and
 * workspaces deletes nothing it did not create.
 */

/** A bounded walk, so a hand-edited cycle in the alias table terminates. */
const MAX_ALIAS_HOPS = 8;

export {
  DEFAULT_CONVENTIONS_PATH,
  type FileEntry,
  MOUNT_REGISTRY_FILE,
  type MountRecord,
  type MountRegistryFile,
  type ProjectPrivacy,
  type ProjectRecord,
} from './mount-registry-file.ts';

export type AliasResult =
  | { ok: true; aliased: boolean }
  /** The new key is already an address of its own. Nothing is written: the
   *  two files each keep the address they have. */
  | { ok: false; error: 'held-by-other'; fileId: string; otherFileId: string };

/** `f-` plus 96 bits, the shape `newDocId` uses for `d-`. */
export function newFileId(): string {
  return `f-${randomBytes(9).toString('base64url')}`;
}

/** `m-` plus 96 bits. */
export function newMountId(): string {
  return `m-${randomBytes(9).toString('base64url')}`;
}

/** The one place a file key's shape is written down. Same separator as a
 *  docKey: a NUL appears in neither half, so the split is unambiguous. */
export const FILE_KEY_SEP = '\u0000';

export function makeFileKey(repoKey: string, relPath: string): string {
  return `${repoKey}${FILE_KEY_SEP}${relPath}`;
}

export function parseFileKey(key: string): { repoKey: string; relPath: string } | null {
  const i = key.indexOf(FILE_KEY_SEP);
  if (i <= 0 || i === key.length - 1) return null;
  return { repoKey: key.slice(0, i), relPath: key.slice(i + FILE_KEY_SEP.length) };
}

export class MountRegistry {
  private readonly path: string;
  private data: MountRegistryFile;
  /** A failed write leaves the registry dirty, so the next write rewrites the
   *  whole file: the file is written whole every time, so a retry repairs. */
  private dirty = false;
  /** fileId → its current key. Built on first use, dropped on every write. */
  private byFileId: Map<string, string> | null = null;

  constructor(dataDir: string) {
    this.path = join(dataDir, MOUNT_REGISTRY_FILE);
    this.data = readMountRegistryFile(this.path);
  }

  /**
   * Persist, logging rather than throwing.
   *
   * This runs on the serve path: a full disk must not turn every read of a
   * mounted file into an exception when the bytes are fine and the next write
   * will carry the claim.
   */
  private persist(): void {
    this.byFileId = null;
    this.dirty = !writeMountRegistryFile(this.path, this.data);
  }

  /** The whole file, cloned. Tests and diagnostics. */
  snapshot(): MountRegistryFile {
    return JSON.parse(JSON.stringify(this.data)) as MountRegistryFile;
  }

  /** True when the last write failed and the file is behind memory. */
  get writePending(): boolean {
    return this.dirty;
  }

  // ---- Projects -----------------------------------------------------------

  /** The row for a repo, or undefined. Never creates. */
  projectFor(repoKey: string): ProjectRecord | undefined {
    return this.data.projects.find((p) => p.repoKey === repoKey);
  }

  /** The row for a repo, created at its defaults if it has none. */
  private ensureProject(repoKey: string): ProjectRecord {
    const found = this.projectFor(repoKey);
    if (found) return found;
    const record: ProjectRecord = {
      repoKey,
      privacy: 'workspace',
      conventionsPath: DEFAULT_CONVENTIONS_PATH,
      mounts: [],
    };
    this.data.projects.push(record);
    return record;
  }

  listProjects(): ProjectRecord[] {
    return this.snapshot().projects;
  }

  /**
   * Whether this project's files may leave the machine.
   *
   * A repo with no row answers `workspace`, the default: a project nobody has
   * marked is not private, and the alternative — treating an unknown repo as
   * private — would make the setting unobservable, since an unmounted repo
   * serves nothing either way.
   */
  privacyOf(repoKey: string): ProjectPrivacy {
    return this.projectFor(repoKey)?.privacy ?? 'workspace';
  }

  setPrivacy(repoKey: string, privacy: ProjectPrivacy): ProjectRecord {
    const project = this.ensureProject(repoKey);
    project.privacy = privacy;
    this.persist();
    return project;
  }

  conventionsPathOf(repoKey: string): string {
    return this.projectFor(repoKey)?.conventionsPath ?? DEFAULT_CONVENTIONS_PATH;
  }

  setConventionsPath(repoKey: string, relPath: string): ProjectRecord {
    const project = this.ensureProject(repoKey);
    project.conventionsPath = relPath;
    this.persist();
    return project;
  }

  // ---- Mounts -------------------------------------------------------------

  /**
   * Mount a folder, or revive the row it already has.
   *
   * Idempotent by RELATIVE PATH, which is the point of keying on the repo
   * rather than on a checkout: mounting `docs/mocks` from a worktree and then
   * from the main checkout is one mount, so the files under it keep one
   * address. Re-mounting an unmounted folder clears its `removedAt` and keeps
   * its `mountId`, so every address inside it survives the round trip.
   */
  mount(
    repoKey: string,
    relPath: string,
    checkoutRoot?: string,
  ): { mount: MountRecord; created: boolean } {
    const project = this.ensureProject(repoKey);
    const index = project.mounts.findIndex((m) => m.relPath === relPath);
    const existing = index === -1 ? undefined : project.mounts[index];
    if (existing) {
      const revived = existing.removedAt !== undefined;
      // Rebuilt without `removedAt` rather than deleted off: `delete` on a hot
      // object deoptimises it, and an `undefined` left in place would be
      // written back as an absent key by `JSON.stringify` anyway — so the
      // shape on disk is the same and the shape in memory stays monomorphic.
      //
      // A re-mount from a DIFFERENT checkout moves the row's checkoutRoot:
      // the address set is the same either way, and the lead pointing at a
      // working copy is them saying which one they mean.
      const nextRoot = checkoutRoot ?? existing.checkoutRoot;
      const revivedMount: MountRecord = {
        mountId: existing.mountId,
        relPath: existing.relPath,
        addedAt: existing.addedAt,
        ...(nextRoot === undefined ? {} : { checkoutRoot: nextRoot }),
      };
      project.mounts[index] = revivedMount;
      this.persist();
      return { mount: revivedMount, created: revived };
    }
    const mount: MountRecord = {
      mountId: newMountId(),
      relPath,
      addedAt: Date.now(),
      ...(checkoutRoot === undefined ? {} : { checkoutRoot }),
    };
    project.mounts.push(mount);
    this.persist();
    return { mount, created: true };
  }

  /**
   * Retire a mount. Soft, always: the row keeps its dates, every file keeps
   * its address, and nothing on disk is touched. Answers false when there was
   * no live mount to retire.
   */
  unmount(repoKey: string, mountId: string): boolean {
    const mount = this.projectFor(repoKey)?.mounts.find((m) => m.mountId === mountId);
    if (!mount || mount.removedAt !== undefined) return false;
    mount.removedAt = Date.now();
    this.persist();
    return true;
  }

  /** The mounts a project serves right now. */
  liveMounts(repoKey: string): MountRecord[] {
    return (this.projectFor(repoKey)?.mounts ?? []).filter((m) => m.removedAt === undefined);
  }

  /** Every mount row, retired ones included. */
  allMounts(repoKey: string): MountRecord[] {
    return this.projectFor(repoKey)?.mounts ?? [];
  }

  mountById(repoKey: string, mountId: string): MountRecord | undefined {
    return this.projectFor(repoKey)?.mounts.find((m) => m.mountId === mountId);
  }

  // ---- File addresses -----------------------------------------------------

  /** Follow the alias chain to the key that is current. */
  resolveKey(fileKey: string): string {
    let key = fileKey;
    for (let hop = 0; hop < MAX_ALIAS_HOPS; hop++) {
      const next = this.data.fileKeyAliases[key];
      if (next === undefined || next === key) return key;
      key = next;
    }
    console.error(`[mount-registry] alias chain from "${fileKey}" is too deep; stopping`);
    return key;
  }

  entryFor(fileKey: string): FileEntry | undefined {
    return this.data.fileKeys[this.resolveKey(fileKey)];
  }

  fileIdFor(fileKey: string): string | undefined {
    return this.entryFor(fileKey)?.fileId;
  }

  /**
   * The key a fileId currently answers at, or undefined.
   *
   * Served from a reverse index rather than a scan of the table: this is the
   * FIRST thing every read of a mounted file asks, and a project with several
   * hundred thousand mounted files would otherwise walk them all per request.
   * The index is rebuilt from the table rather than persisted, so it cannot
   * drift from the file it describes.
   */
  keyOf(fileId: string): string | undefined {
    if (!this.byFileId) {
      const index = new Map<string, string>();
      for (const [key, entry] of Object.entries(this.data.fileKeys)) index.set(entry.fileId, key);
      this.byFileId = index;
    }
    return this.byFileId.get(fileId);
  }

  /**
   * Give this key an address, unless it has one.
   *
   * First writer wins, and there is no repoint — the rule `RepoRegistry.claim`
   * states. A rewritten file arrives here with the same key and keeps its
   * fileId; what changes is the size, mtime and fingerprint recorded beside
   * it, which is how the next reconcile knows the bytes moved on.
   */
  claim(fileKey: string, seen: Omit<FileEntry, 'fileId'>): FileEntry {
    const key = this.resolveKey(fileKey);
    const held = this.data.fileKeys[key];
    if (held) {
      const updated: FileEntry = { ...held, ...seen, fileId: held.fileId };
      this.data.fileKeys[key] = updated;
      this.persist();
      return updated;
    }
    const entry: FileEntry = { ...seen, fileId: newFileId() };
    this.data.fileKeys[key] = entry;
    this.persist();
    return entry;
  }

  /**
   * Record that the file at `oldKey` is now at `newKey` — a detected move.
   *
   * The fileId does not move; the KEY does. The new key inherits the address,
   * and the old key keeps resolving through the alias, so a link written
   * before the move opens the same file with the same comments.
   *
   * **Refused when the two keys are two different files.** Writing the alias
   * anyway would repoint every address saved against the old key at another
   * file — the repoint `claim` exists to refuse, arriving by the back door.
   */
  aliasKey(oldKey: string, newKey: string, seen?: Omit<FileEntry, 'fileId'>): AliasResult {
    if (oldKey === newKey) return { ok: true, aliased: false };
    const from = this.resolveKey(oldKey);
    if (from === newKey) return { ok: true, aliased: false };
    // A key that already resolves BACK to this one would close a cycle — a
    // file moved out and moved back. Both spellings already reach one
    // address, so there is nothing to add.
    if (this.resolveKey(newKey) === from) return { ok: true, aliased: false };
    const entry = this.data.fileKeys[from];
    const heldByNew = this.data.fileKeys[newKey];
    if (entry && heldByNew && heldByNew.fileId !== entry.fileId) {
      return {
        ok: false,
        error: 'held-by-other',
        fileId: heldByNew.fileId,
        otherFileId: entry.fileId,
      };
    }
    this.data.fileKeyAliases[from] = newKey;
    if (entry && !heldByNew) {
      this.data.fileKeys[newKey] = seen ? { ...entry, ...seen, fileId: entry.fileId } : entry;
    }
    this.persist();
    return { ok: true, aliased: true };
  }

  /** Every key currently pointing at this fileId, current and aliased. */
  keysFor(fileId: string): string[] {
    const set = new Set(
      Object.keys(this.data.fileKeys).filter((k) => this.data.fileKeys[k]?.fileId === fileId),
    );
    for (const from of Object.keys(this.data.fileKeyAliases)) {
      if (set.has(this.resolveKey(from))) set.add(from);
    }
    return [...set].sort();
  }

  /** Every recorded key under one repo, current spellings only. */
  keysUnderRepo(repoKey: string): Array<{ key: string; entry: FileEntry }> {
    const prefix = `${repoKey}${FILE_KEY_SEP}`;
    const out: Array<{ key: string; entry: FileEntry }> = [];
    for (const [key, entry] of Object.entries(this.data.fileKeys)) {
      if (key.startsWith(prefix)) out.push({ key, entry });
    }
    return out;
  }
}
