/**
 * The folders whose git-ignored files the owner let component builds read
 * (design decision 5: a source git does not list needs the owner's grant).
 *
 * An agent asks with `request_component_grant`, which files an access card
 * (`share/access-proposals.ts`, op `component-folder`); only the owner's
 * Approve at the access door (`routes/task-access.ts`) calls `grant`. Nothing
 * else writes here. A grant covers every file under its folder, on every
 * board, because a build reads a file and not a board; it is read by the
 * resolver in `component-build.ts` only for a file git ignores, after every
 * other check has passed.
 *
 * One small JSON file (`component-grants.json`, mode 600), rewritten whole
 * through a temp file. A file that exists and cannot be read grants nothing
 * and is never written over, so a bad read can neither widen nor lose what
 * the owner chose.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';

const FILENAME = 'component-grants.json';

export interface ComponentGrant {
  folder: string;
  by: string;
  at: number;
}

export class ComponentGrants {
  private folders: ComponentGrant[] = [];
  private unreadable = false;
  private seq = 0;

  constructor(private readonly dataDir: string) {
    const file = join(dataDir, FILENAME);
    if (!existsSync(file)) return;
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as { folders?: unknown };
      if (!Array.isArray(raw.folders)) throw new Error('no folders list');
      this.folders = raw.folders.filter(
        (g): g is ComponentGrant =>
          !!g &&
          typeof g === 'object' &&
          typeof (g as ComponentGrant).folder === 'string' &&
          (g as ComponentGrant).folder.startsWith('/') &&
          typeof (g as ComponentGrant).by === 'string' &&
          typeof (g as ComponentGrant).at === 'number',
      );
    } catch {
      this.unreadable = true;
      this.folders = [];
    }
  }

  /** Moves on every grant, so a build sweep knows to try refused tags again. */
  get version(): number {
    return this.seq;
  }

  /** Whether `path`, a real absolute path, is under a granted folder. */
  covers(path: string): boolean {
    return this.folders.some((g) => path.startsWith(g.folder + sep));
  }

  list(): ComponentGrant[] {
    return this.folders.map((g) => ({ ...g }));
  }

  /** Grant `folder`, an absolute real path. Throws when the file cannot be read. */
  grant(folder: string, by: string, at = Date.now()): void {
    if (!folder.startsWith('/')) throw new Error('a granted folder must be an absolute path');
    if (this.unreadable) {
      throw new Error(`${FILENAME} cannot be read, so no grant is written over it`);
    }
    const trimmed = folder.replace(/\/+$/, '');
    if (!this.folders.some((g) => g.folder === trimmed)) {
      this.folders.push({ folder: trimmed, by, at });
      mkdirSync(this.dataDir, { recursive: true });
      const file = join(this.dataDir, FILENAME);
      writeFileSync(`${file}.tmp`, `${JSON.stringify({ folders: this.folders }, null, 2)}\n`, {
        mode: 0o600,
      });
      renameSync(`${file}.tmp`, file);
    }
    this.seq++;
  }
}
