/**
 * Docs kept as files: one `<id>.ydoc` per doc in the data folder, each the
 * doc's whole Yjs state. A write goes to a temp file first and is renamed
 * over the old one, so a crash mid-write leaves the previous state whole.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type CollabStorage, ROOM_ID } from '@claude-workspaces/app-kit/collab';

export class FileCollabStorage implements CollabStorage {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  /** The file for a doc. The id is checked again here, so no caller can
   *  name a path outside the folder. */
  private path(docId: string): string {
    if (!ROOM_ID.test(docId)) throw new Error(`not a doc id: ${JSON.stringify(docId)}`);
    return join(this.dir, `${docId}.ydoc`);
  }

  read(docId: string): Uint8Array | null {
    const p = this.path(docId);
    return existsSync(p) ? new Uint8Array(readFileSync(p)) : null;
  }

  write(docId: string, state: Uint8Array): void {
    const p = this.path(docId);
    const tmp = `${p}.${process.pid}.tmp`;
    writeFileSync(tmp, state);
    renameSync(tmp, p);
  }
}
