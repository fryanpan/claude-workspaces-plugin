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
    private readonly realpath: (p: string) => string = realpathSync.native,
  ) {}

  /** Whether the file exists and cannot be read; loads it first. */
  private isBroken(): boolean {
    this.load();
    return this.broken;
  }

  private load(): Record<string, string[]> {
    if (this.boards) return this.boards;
    const boards: Record<string, string[]> = Object.create(null);
    try {
      if (existsSync(this.path)) {
        const listed: unknown = JSON.parse(readFileSync(this.path, 'utf8'))?.boards;
        // Any shape but the one `save` writes is unreadable, not empty: a
        // list read as "no roots" would leave a lead's projects unguarded.
        if (!listed || typeof listed !== 'object' || Array.isArray(listed))
          throw new Error('no boards table');
        for (const [id, roots] of Object.entries(listed as Record<string, unknown>)) {
          if (!Array.isArray(roots) || !roots.every((r) => typeof r === 'string' && isAbsolute(r)))
            throw new Error(`board ${id}: not a list of absolute paths`);
          boards[id] = roots as string[];
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
    this.spellings.clear();
    this.save();
    return { ok: true, roots: [...resolved] };
  }

  /** How long a root's verdict is kept, so a poll stat does not resolve it
   *  on the main thread every time. A swap inside the window is still met
   *  by `landsInside`, which every read and write asks off the main thread. */
  static readonly ROOT_VERDICT_MS = 1_000;
  private verdicts = new Map<string, { at: number; ok: boolean }>();

  /** How long a folder's resolved spelling is kept by `spelled`. */
  static readonly SPELLING_MS = 1_000;
  private static readonly SPELLINGS_MAX = 4_096;
  private spellings = new Map<string, { at: number; real: string | null }>();

  private realOf(dir: string, now: number): string | null {
    const hit = this.spellings.get(dir);
    if (hit && now - hit.at < BoardSocketRoots.SPELLING_MS) return hit.real;
    let real: string | null;
    try {
      real = this.realpath(dir);
    } catch {
      real = null;
    }
    if (this.spellings.size >= BoardSocketRoots.SPELLINGS_MAX) this.spellings.clear();
    this.spellings.set(dir, { at: now, real });
    return real;
  }

  /**
   * `path` as the roots are spelled. Roots are stored resolved, and a bound
   * path is kept as it was typed, which may pass through a link above the
   * root (`~/dev` onto a data volume) or differ in letter case. So each
   * folder on the way is resolved from the top down, and the first that
   * resolves at or under a root gives the spelling: that root followed by
   * the rest of the path as typed. Resolving the whole path instead would
   * follow a link the lead put below the root, and report it outside.
   */
  private spelled(path: string, now = Date.now()): string {
    const roots = this.allRoots();
    const under = (p: string) => roots.some((r) => p === r || p.startsWith(`${r}/`));
    if (roots.length === 0 || under(path)) return path;
    const parts = path.split('/');
    for (let i = 2; i <= parts.length; i++) {
      const prefix = parts.slice(0, i).join('/');
      const real = this.realOf(prefix, now);
      if (real && under(real)) return [real, ...parts.slice(i)].join('/');
    }
    return path;
  }

  /** The roots that hold `path`, however it is spelled. */
  private rootsOver(path: string): string[] {
    const p = this.spelled(path);
    return this.allRoots().filter((root) => p === root || p.startsWith(`${root}/`));
  }

  /** Whether `path` is under a lead's root: the guard's business. With the
   *  file unreadable, every path is. */
  covers(path: string, _setId?: string): boolean {
    if (this.isBroken()) return true;
    return this.rootsOver(path).length > 0;
  }

  /** Whether some root sits at or below `dir`: a repository there holds a
   *  lead's folder (`git-hardening.ts`). With the file unreadable, always. */
  holdsRoot(dir: string): boolean {
    if (this.isBroken()) return true;
    const roots = this.allRoots();
    if (roots.length === 0) return false;
    const holds = (d: string) => roots.some((root) => root === d || root.startsWith(`${d}/`));
    if (holds(dir)) return true;
    const real = this.realOf(dir, Date.now());
    return real !== null && holds(real);
  }

  /**
   * The main-thread half of the guard (`bound-path-guard.ts` `PathGuards`).
   * A path under a lead's root needs that root still resolving to itself,
   * so no link has been swapped in for it, and no `node_modules` folder on
   * its way below the root, the one place a walled lead may make links.
   */
  admits(path: string, _setId?: string, now = Date.now()): boolean {
    if (this.isBroken()) return false;
    const p = this.spelled(path, now);
    const over = this.allRoots().filter((root) => p === root || p.startsWith(`${root}/`));
    for (const root of over) {
      // Lower-cased: the disk ignores case, so `Node_Modules` is the same folder.
      if (p.slice(root.length).toLowerCase().split('/').includes('node_modules')) return false;
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
    if (this.isBroken()) return false;
    const over = this.rootsOver(path);
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
