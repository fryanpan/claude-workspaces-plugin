/**
 * The folders each walled lead works in (`board-socket-roots.json` in the
 * data folder): one list per board, each folder resolved through its links.
 *
 * A lead behind the board wall can write these folders, and the server,
 * which no sandbox holds, reads and writes files in them whenever a doc or
 * folder bound there is open. So a lead could replace a folder on the way
 * to such a file with a link, or set a repository's git settings to name a
 * program, and have the server, acting as the owner, follow it. Installed as
 * a `slow-fs.ts` path guard, this holds every bound read, stat and write
 * under any root of any board to the root (`admits`, `landsInside`), and
 * `git-hardening.ts` runs no git under one or in a repository holding one.
 *
 * A root is a lead's project; its parent is a folder the lead cannot write,
 * so it cannot be swapped, and `admits` checks it still resolves to itself.
 * A walled lead may make no new link in its projects outside `node_modules`
 * (`scripts/lead-sandbox-wall.ts`), and a path through `node_modules` is
 * refused here.
 *
 * `scripts/lead-sandbox.ts` writes the list when it launches a walled lead,
 * from the projects that lead's profile already opens to it, through
 * `PUT /api/board-sockets/<board>/roots` (`routes/board-socket-roots.ts`),
 * which only a caller on this machine outside any sandbox can reach. The
 * file holds paths, no secret, and is written mode 600.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';

/** More than any lead's project list; a bound on what one PUT may write. */
export const MAX_ROOTS = 32;
const MAX_PATH = 1024;

export function boardSocketRootsPath(dataDir: string): string {
  return join(dataDir, 'board-socket-roots.json');
}

export type RootsWrite = { ok: true; roots: string[] } | { ok: false; error: string };

export class BoardSocketRoots {
  private boards: Record<string, string[]> | null = null;
  /** Set when the file exists and cannot be read: see `load`. */
  private broken = false;

  constructor(
    private readonly path: string,
    private readonly realpath: (p: string) => string = realpathSync,
  ) {}

  private load(): Record<string, string[]> {
    if (this.boards) return this.boards;
    const boards: Record<string, string[]> = {};
    try {
      const raw = existsSync(this.path) ? JSON.parse(readFileSync(this.path, 'utf8')) : null;
      const listed: unknown = raw?.boards;
      if (listed && typeof listed === 'object') {
        for (const [id, roots] of Object.entries(listed as Record<string, unknown>)) {
          if (Array.isArray(roots))
            boards[id] = roots.filter((r): r is string => typeof r === 'string' && isAbsolute(r));
        }
      }
    } catch {
      // Unreadable, nobody can say which folders a lead can write. So every
      // path counts as one: each bound read and write is refused and no git
      // runs, until the file reads again. Nothing is written over it, since
      // it may be mid-edit or misread.
      if (existsSync(this.path)) {
        this.broken = true;
        console.error(
          `[board-socket-roots] ${this.path} could not be read; refusing every bound file and every git read until it can`,
        );
      }
    }
    this.boards = boards;
    return boards;
  }

  rootsOf(boardId: string): string[] {
    return [...(this.load()[boardId] ?? [])];
  }

  /** Every board's roots together. */
  private allRoots(): string[] {
    return Object.values(this.load()).flat();
  }

  /**
   * Replace a board's list. Each entry must be an absolute path to a folder
   * that exists, and is stored resolved; `/` is refused, since it would make
   * the list mean nothing.
   */
  set(boardId: string, roots: unknown): RootsWrite {
    if (!Array.isArray(roots)) return { ok: false, error: 'roots must be a list of folders' };
    if (roots.length > MAX_ROOTS) return { ok: false, error: `at most ${MAX_ROOTS} roots` };
    const resolved: string[] = [];
    for (const r of roots) {
      if (typeof r !== 'string' || r.length > MAX_PATH || !isAbsolute(r))
        return { ok: false, error: 'each root must be an absolute path' };
      let real: string;
      try {
        real = this.realpath(r);
        if (!statSync(real).isDirectory()) return { ok: false, error: `${r} is not a folder` };
      } catch {
        return { ok: false, error: `${r} does not exist` };
      }
      if (real === '/') return { ok: false, error: 'a root of / would allow every folder' };
      if (!resolved.includes(real)) resolved.push(real);
    }
    for (const a of resolved)
      for (const b of resolved)
        if (a !== b && b.startsWith(`${a}/`))
          return { ok: false, error: `${b} is inside ${a}; a root may not hold another` };
    const boards = this.load();
    if (this.broken) return { ok: false, error: 'the roots file cannot be read' };
    boards[boardId] = resolved;
    this.verdicts.clear();
    this.save();
    return { ok: true, roots: [...resolved] };
  }

  /** How long a root's verdict is kept, so a poll stat does not resolve it
   *  on the main thread every time. A swap inside the window is still met
   *  by `landsInside`, which every read and write asks off the main thread. */
  static readonly ROOT_VERDICT_MS = 1_000;
  private verdicts = new Map<string, { at: number; ok: boolean }>();

  /** The roots that hold `path`. */
  private rootsOver(path: string): string[] {
    return this.allRoots().filter((root) => path === root || path.startsWith(`${root}/`));
  }

  /** Whether `path` is under a lead's root: the guard's business. With the
   *  file unreadable, every path is. */
  covers(path: string, _setId?: string): boolean {
    const over = this.rootsOver(path);
    return this.broken || over.length > 0;
  }

  /** Whether some root sits at or below `dir`: a repository there holds a
   *  lead's folder (`git-hardening.ts`). With the file unreadable, always. */
  holdsRoot(dir: string): boolean {
    const roots = this.allRoots();
    return this.broken || roots.some((root) => root === dir || root.startsWith(`${dir}/`));
  }

  /**
   * The main-thread half of the guard (`bound-path-guard.ts` `PathGuards`).
   * A path under a lead's root needs that root still resolving to itself,
   * so no link has been swapped in for it, and no `node_modules` folder on
   * its way below the root, the one place a walled lead may make links.
   */
  admits(path: string, _setId?: string, now = Date.now()): boolean {
    const over = this.rootsOver(path);
    if (this.broken) return false;
    for (const root of over) {
      if (path.slice(root.length).split('/').includes('node_modules')) return false;
      const cached = this.verdicts.get(root);
      let ok: boolean;
      if (cached && now - cached.at < BoardSocketRoots.ROOT_VERDICT_MS) ok = cached.ok;
      else {
        try {
          ok = this.realpath(root) === root;
        } catch {
          ok = false;
        }
        this.verdicts.set(root, { at: now, ok });
      }
      if (!ok) return false;
    }
    return true;
  }

  /**
   * The other half, asked with where `path` really lands (resolved off the
   * main thread by the caller): inside every lead root that holds it. For a
   * file not there yet, `real` is its nearest existing folder, resolved, so
   * a write cannot create a file through a linked parent.
   */
  landsInside(path: string, real: string, _setId?: string): boolean {
    const over = this.rootsOver(path);
    if (this.broken) return false;
    return over.every((root) => real === root || real.startsWith(`${root}/`));
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify({ boards: this.load() }, null, 2), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.path);
  }
}
