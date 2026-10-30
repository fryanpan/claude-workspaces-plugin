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
 * A root stays covered after it leaves its board's list (`walled`): what a
 * lead planted in a project — git settings that run a program, links, FIFOs
 * — stays when the lead is relaunched with other projects, its board is
 * retired, or the project moves to another lead. Nothing here removes an
 * entry from `walled`; clearing one is an owner's edit of the file, after
 * checking the project.
 *
 * `scripts/lead-sandbox.ts` writes the list when it launches a walled lead,
 * from the projects that lead's profile already opens to it, through
 * `PUT /api/board-sockets/<board>/roots` (`routes/board-socket-roots.ts`),
 * which only a caller on this machine outside any sandbox can reach. The
 * file holds paths, no secret, and is written mode 600.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { lstatSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

/** More than any lead's project list; a bound on what one PUT may write. */
export const MAX_ROOTS = 32;
const MAX_PATH = 1024;

export function boardSocketRootsPath(dataDir: string): string {
  return join(dataDir, 'board-socket-roots.json');
}

/**
 * Folders a walled lead can write that are not roots, given its roots:
 * `~/.claude` (most of it is writable; the wall makes only the parts an
 * unsandboxed session obeys read-only), and the scratch folders Claude Code
 * gives a session launched in a root or a worktree of one
 * (`/private/tmp/claude-<uid>/<slug>`, the same rule as the wall's in
 * `scripts/lead-sandbox-lib.ts`). The server refuses bound reads, bound
 * writes and git under them for every caller: their bytes are the lead's,
 * and the server's own files there (the discovery file, the settings temp)
 * are read and written by name through `@claude-workspaces/core/safe-file`.
 */
export interface LeadShadows {
  home: string;
  uid: number;
  realpath: (p: string) => string;
}

export function defaultLeadShadows(): LeadShadows {
  return { home: homedir(), uid: process.getuid?.() ?? -1, realpath: realpathSync.native };
}

/** Claude Code's name for a folder's transcript and scratch folders. */
export function transcriptSlug(path: string): string {
  return path.replace(/[^a-zA-Z0-9]/g, '-');
}

/** Whether `path` is in a lead-writable folder that is not a root. */
export function inLeadShadow(path: string, roots: readonly string[], s: LeadShadows): boolean {
  if (roots.length === 0) return false;
  const inside = (p: string, dir: string) => p === dir || p.startsWith(`${dir}/`);
  const both = (p: string): string[] => {
    try {
      return [p, s.realpath(p)];
    } catch {
      return [p];
    }
  };
  const claude = both(join(s.home, '.claude'));
  if (claude.some((d) => inside(path, d))) return true;
  const scratch = [`/private/tmp/claude-${s.uid}`, `/tmp/claude-${s.uid}`];
  const at = scratch.find((d) => path.startsWith(`${d}/`));
  if (!at) return false;
  const first = (path.slice(at.length + 1).split('/')[0] ?? '').replace(
    /--claude-worktrees-.*$/,
    '',
  );
  const homes = both(s.home);
  for (const root of roots) {
    const spellings = new Set([root]);
    // A root is stored resolved; the lead may have been launched by its
    // home-spelled name, whose slug differs (`~` linked onto a data volume).
    for (const h of homes)
      for (const other of homes)
        if (h !== other && inside(root, h)) spellings.add(other + root.slice(h.length));
    for (const sp of spellings) if (first === transcriptSlug(sp)) return true;
  }
  return false;
}

export type RootsWrite = { ok: true; roots: string[] } | { ok: false; error: string };

export class BoardSocketRoots {
  private boards: Record<string, string[]> | null = null;
  /** Every folder ever registered for any board: see the header. */
  private walled: string[] = [];
  /** Every board's roots, and every folder once walled, kept beside `boards`. */
  private flat: string[] = [];
  /** Set when the file exists and cannot be read: see `load`. */
  private broken = false;
  /** The broken file's mtime, and when it was last asked: see `load`. */
  private brokenStamp = { mtimeMs: 0, askedAt: 0 };

  /** How often a broken file is asked whether it has changed. */
  static readonly BROKEN_RECHECK_MS = 1_000;

  constructor(
    private readonly path: string,
    private readonly realpath: (p: string) => string = realpathSync.native,
    private readonly now: () => number = Date.now,
    private readonly shadows: LeadShadows = defaultLeadShadows(),
  ) {}

  /** Whether `path` is in a folder a walled lead writes that is no root. */
  private shadowed(path: string): boolean {
    const roots = this.allRoots();
    if (roots.length === 0) return false;
    if (inLeadShadow(path, roots, this.shadows)) return true;
    const spelled = this.spelled(path);
    return spelled !== null && spelled !== path && inLeadShadow(spelled, roots, this.shadows);
  }

  /** Whether the file exists and cannot be read; loads it first. */
  private isBroken(): boolean {
    this.load();
    return this.broken;
  }

  private mtimeOfFile(): number {
    try {
      return statSync(this.path).mtimeMs;
    } catch {
      return -1;
    }
  }

  private load(): Record<string, string[]> {
    if (this.boards && this.broken) {
      // A broken file is asked again at most once a second, and re-read when
      // it has changed, so one bad write does not refuse every board until a
      // restart. A good file is only ever written by `set`, in this process.
      const now = this.now();
      if (now - this.brokenStamp.askedAt >= BoardSocketRoots.BROKEN_RECHECK_MS) {
        this.brokenStamp.askedAt = now;
        if (this.mtimeOfFile() !== this.brokenStamp.mtimeMs) {
          this.boards = null;
          this.broken = false;
        }
      }
    }
    if (this.boards) return this.boards;
    const boards: Record<string, string[]> = Object.create(null);
    const walled: string[] = [];
    try {
      if (existsSync(this.path)) {
        const file: unknown = JSON.parse(readFileSync(this.path, 'utf8'));
        const listed: unknown = (file as { boards?: unknown } | null)?.boards;
        const once: unknown = (file as { walled?: unknown } | null)?.walled ?? [];
        if (!Array.isArray(once) || !once.every((r) => typeof r === 'string' && isAbsolute(r)))
          throw new Error('walled: not a list of absolute paths');
        walled.push(...(once as string[]));
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
      // runs, until the file changes and reads (above). Nothing is written
      // over it, since it may be mid-edit or misread.
      if (existsSync(this.path)) {
        this.broken = true;
        this.brokenStamp = { mtimeMs: this.mtimeOfFile(), askedAt: this.now() };
        console.error(
          `[board-socket-roots] ${this.path} could not be read; refusing every bound file and every git read until it is fixed`,
        );
      }
    }
    this.boards = boards;
    this.walled = unique([...walled, ...Object.values(boards).flat()]);
    this.flat = this.walled;
    this.spellings.clear();
    return boards;
  }

  rootsOf(boardId: string): string[] {
    return [...(this.load()[boardId] ?? [])];
  }

  /** Every board's roots together, and every folder once walled. */
  private allRoots(): string[] {
    this.load();
    return this.flat;
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
    this.walled = unique([...this.walled, ...resolved]);
    this.flat = this.walled;
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

  /** The most path spellings `spell` keeps, least recently used out. */
  static readonly SPELLINGS_MAX = 16_384;
  /** The most links `spell` follows for one path, as the kernel's. */
  private static readonly LINKS_MAX = 32;
  private spellings = new Map<string, string>();

  private under(p: string): boolean {
    return this.allRoots().some((r) => p === r || p.startsWith(`${r}/`));
  }

  /**
   * A path as the roots are spelled, or null when it could not be told.
   * Walked one name at a time from `/`: a name that is a link is replaced by
   * where it points and walked on, any other name takes its on-disk letter
   * case, and the walk stops at the first point at or under a root, taking
   * the rest as typed. So a link above a root (`~/dev` onto a data volume),
   * an owner's link into a project and a case variant all reach the root's
   * spelling, and no link below a root, which the lead can make, is ever
   * followed. Answers are kept until the roots change; only paths off
   * every root or above one are kept, and those are the owner's. A missing
   * name is spelled as typed and not kept, so it is asked again.
   */
  private spell(dir: string, links = 0): string | null {
    if (dir === '/' || this.under(dir)) return dir;
    const hit = this.spellings.get(dir);
    if (hit !== undefined) {
      this.spellings.delete(dir);
      this.spellings.set(dir, hit);
      return hit;
    }
    const parent = this.spell(dirname(dir), links);
    if (parent === null) return null;
    const next = join(parent, basename(dir));
    if (this.under(parent)) return next;
    let out: string | null;
    try {
      if (lstatSync(next).isSymbolicLink()) {
        if (links >= BoardSocketRoots.LINKS_MAX) return null;
        const target = readlinkSync(next);
        out = this.spell(resolve(parent, target), links + 1);
      } else out = this.realpath(next);
    } catch (err) {
      // Not there: spelled as typed, and asked again next time. Any other
      // failure is not an answer, so the path counts as a lead's.
      return (err as NodeJS.ErrnoException).code === 'ENOENT' ? next : null;
    }
    if (out === null) return null;
    if (this.spellings.size >= BoardSocketRoots.SPELLINGS_MAX) {
      const oldest = this.spellings.keys().next().value;
      if (oldest !== undefined) this.spellings.delete(oldest);
    }
    this.spellings.set(dir, out);
    return out;
  }

  /** `path` as the roots are spelled, its last name included, or null when
   *  that could not be told. The first ask for a path, at bind or on load,
   *  pays the lookups; every later ask is answered from `spellings`. A `.`
   *  or `..` name is not spelled: walked as text it would drop a folder the
   *  disk climbs out of through a link, so the path counts as a lead's. */
  private spelled(path: string): string | null {
    if (this.allRoots().length === 0) return path;
    if (path.split('/').some((n) => n === '.' || n === '..')) return null;
    return this.spell(path);
  }

  /** The roots that hold `path`, however it is spelled; null when the
   *  spelling could not be told, which every check reads as refused. */
  private rootsOver(path: string): string[] | null {
    const p = this.spelled(path);
    if (p === null) return null;
    return this.allRoots().filter((root) => p === root || p.startsWith(`${root}/`));
  }

  /** Whether `path` is under a lead's root: the guard's business. With the
   *  file unreadable, every path is. */
  covers(path: string): boolean {
    if (this.isBroken()) return true;
    if (this.shadowed(path)) return true;
    const over = this.rootsOver(path);
    return over === null || over.length > 0;
  }

  /** Whether some root sits at or below `dir`: a repository there holds a
   *  lead's folder (`git-hardening.ts`). With the file unreadable, always. */
  holdsRoot(dir: string): boolean {
    if (this.isBroken()) return true;
    const roots = this.allRoots();
    if (roots.length === 0) return false;
    const holds = (d: string) =>
      d === '/' || roots.some((root) => root === d || root.startsWith(`${d}/`));
    if (holds(dir)) return true;
    const spelled = this.spell(dir);
    return spelled === null || holds(spelled);
  }

  /**
   * The main-thread half of the guard (`bound-path-guard.ts` `PathGuards`).
   * A path under a lead's root needs that root still resolving to itself,
   * so no link has been swapped in for it, and no `node_modules` folder on
   * its way below the root, the one place a walled lead may make links.
   */
  admits(path: string, now = Date.now()): boolean {
    if (this.isBroken()) return false;
    if (this.shadowed(path)) return false;
    const p = this.spelled(path);
    if (p === null) return false;
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
  landsInside(path: string, real: string): boolean {
    if (this.isBroken()) return false;
    if (this.shadowed(path) || this.shadowed(real)) return false;
    const over = this.rootsOver(path);
    if (over === null) return false;
    return over.every((root) => real === root || real.startsWith(`${root}/`));
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    const boards = this.load();
    writeFileSync(tmp, JSON.stringify({ boards, walled: this.walled }, null, 2), {
      mode: 0o600,
    });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.path);
  }
}

function unique(paths: string[]): string[] {
  return [...new Set(paths)];
}
