import {
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { preCompactPath, writePreCompactBackup } from '../pre-compact-backup.ts';
import { archiveDirPath, ensureArchiveDir } from '../review-archive.ts';
import type { DocStateArea, DocStateStore, KeepOutcome } from './store.ts';

const SUFFIX = '.ydoc';
/** A staged delete's name does not end in `.ydoc`, so `list` skips it. */
const STAGED_SUFFIX = '.deleting';

/**
 * Doc state as `<dataDir>/<docId>.ydoc`, archived state under
 * `<dataDir>/_archive/`. This is byte for byte what the server wrote before
 * the interface existed: the whole V1 update, written in place.
 *
 * The data dir belongs to this process and no cloud-sync provider sits
 * between it and the disk, so the synchronous reads here are the same ones
 * `DocStore` always made. Bound paths go through `slow-fs.ts`, never here.
 */
export class DiskDocStateStore implements DocStateStore {
  readonly kind = 'disk';

  constructor(private readonly dataDir: string) {}

  /** The live `.ydoc` path. Disk-only callers (offline tools, tests) use it. */
  pathOf(docId: string): string {
    return join(this.dataDir, `${docId}${SUFFIX}`);
  }

  private pathIn(docId: string, area: DocStateArea): string {
    return area === 'live'
      ? this.pathOf(docId)
      : join(archiveDirPath(this.dataDir), `${docId}${SUFFIX}`);
  }

  has(docId: string, area: DocStateArea = 'live'): boolean {
    return existsSync(this.pathIn(docId, area));
  }

  read(docId: string): Uint8Array | null {
    const path = this.pathOf(docId);
    if (!existsSync(path)) return null;
    return new Uint8Array(readFileSync(path));
  }

  write(docId: string, state: Uint8Array): void {
    writeFileSync(this.pathOf(docId), state);
  }

  savedAt(docId: string): number | undefined {
    const path = this.pathOf(docId);
    if (!existsSync(path)) return undefined;
    return statSync(path).mtimeMs;
  }

  list(): string[] {
    return readdirSync(this.dataDir)
      .filter((name) => name.endsWith(SUFFIX))
      .map((name) => name.slice(0, -SUFFIX.length))
      .filter((docId) => docId.length > 0);
  }

  move(docId: string, from: DocStateArea, to: DocStateArea): boolean {
    if (from === to) return true;
    if (to === 'archive') ensureArchiveDir(this.dataDir);
    const src = this.pathIn(docId, from);
    try {
      if (existsSync(src)) renameSync(src, this.pathIn(docId, to));
      return true;
    } catch (err) {
      console.error(`[doc-store] failed to move ${docId}.ydoc to ${to}:`, err);
      return false;
    }
  }

  stageDelete(docId: string): boolean {
    const path = this.pathOf(docId);
    if (!existsSync(path)) return true;
    try {
      renameSync(path, `${path}${STAGED_SUFFIX}`);
      return true;
    } catch (err) {
      console.error(`[doc-store] failed to stage ${docId} for deletion:`, err);
      return false;
    }
  }

  unstageDelete(docId: string): void {
    const staged = `${this.pathOf(docId)}${STAGED_SUFFIX}`;
    if (!existsSync(staged)) return;
    try {
      renameSync(staged, this.pathOf(docId));
    } catch (err) {
      console.error(`[doc-store] failed to restore staged ${docId}:`, err);
    }
  }

  dropStaged(docId: string): void {
    try {
      rmSync(`${this.pathOf(docId)}${STAGED_SUFFIX}`, { force: true });
    } catch (err) {
      console.error(`[doc-store] failed to remove staged ${docId}:`, err);
    }
  }

  remove(docId: string): boolean {
    const path = this.pathOf(docId);
    if (existsSync(path)) rmSync(path);
    return !existsSync(path);
  }

  keepBeforeCompaction(docId: string, original: Uint8Array): KeepOutcome {
    return writePreCompactBackup(this.pathOf(docId), original);
  }

  keptCopyLabel(docId: string): string {
    return preCompactPath(this.pathOf(docId));
  }
}
