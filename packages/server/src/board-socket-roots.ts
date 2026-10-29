/**
 * The folders a board's lead may bind (`board-socket-roots.json` in the data
 * folder): one list per board, each folder resolved through its links.
 *
 * A lead behind the board wall asks for a folder bind over its board's
 * socket (`middleware/lead-scope.ts`), and the server, which no sandbox
 * holds, is what reads the files. So without this list a lead could have the
 * server publish onto its board a folder its own profile denies it: another
 * lead's project, or a key folder. A bind from a lead is refused unless the
 * folder, resolved, IS one of these, and it is bound by that resolved path.
 *
 * Not a folder inside one: the lead can write inside its projects, so it
 * could bind `<project>/x` and then replace `x` with a link to `~/.ssh`, and
 * every later read would follow the link. A root itself sits in a folder the
 * lead cannot write, so it cannot be swapped; `include` narrows a bind to a
 * subfolder instead. For the same reason one root may not sit inside
 * another. With no list for a board, every lead bind is refused.
 *
 * And a root can still be swapped by whoever CAN write its parent, or
 * dropped from the list at the next launch, so every set a lead bound is
 * recorded here (`recordBind`) and every read, stat and write under it is
 * re-checked (`admits` and `landsInside`, installed as a `slow-fs.ts` path
 * guard).
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

/** A set a lead bound: its board and the root it was bound by. */
export interface LeadBindRecord {
  board: string;
  root: string;
}

function readBinds(listed: unknown, into: Record<string, LeadBindRecord>): void {
  if (!listed || typeof listed !== 'object') return;
  for (const [setId, b] of Object.entries(listed as Record<string, unknown>)) {
    const { board, root } = (b ?? {}) as Record<string, unknown>;
    if (typeof board === 'string' && typeof root === 'string' && isAbsolute(root))
      into[setId] = { board, root };
  }
}

export class BoardSocketRoots {
  private boards: Record<string, string[]> | null = null;
  private binds: Record<string, LeadBindRecord> = {};
  /** Lead binds whose set is archived, kept so an unarchive restores them. */
  private archived: Record<string, LeadBindRecord> = {};

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
      readBinds(raw?.binds, this.binds);
      readBinds(raw?.archived, this.archived);
    } catch {
      // Unreadable is the same as empty: every lead bind is refused.
    }
    this.boards = boards;
    return boards;
  }

  rootsOf(boardId: string): string[] {
    return [...(this.load()[boardId] ?? [])];
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
    boards[boardId] = resolved;
    this.save();
    return { ok: true, roots: [...resolved] };
  }

  /** The root `folderPath` resolves to, when it is one of the board's; else null. */
  rootFor(boardId: string, folderPath: string): string | null {
    if (!isAbsolute(folderPath)) return null;
    let real: string;
    try {
      real = this.realpath(folderPath);
    } catch {
      return null;
    }
    return this.rootsOf(boardId).includes(real) ? real : null;
  }

  /** Remember a set a lead bound, so every later use of it is re-checked. */
  recordBind(setId: string, board: string, root: string): void {
    this.load();
    const had = this.binds[setId];
    if (had?.board === board && had.root === root) return;
    this.binds[setId] = { board, root };
    this.save();
  }

  /** How long a root's verdict is kept, so a poll stat does not resolve it
   *  on the main thread every time. A swap inside the window is still met
   *  by `landsInside`, which every read and write asks off the main thread. */
  static readonly ROOT_VERDICT_MS = 1_000;
  private verdicts = new Map<string, { at: number; ok: boolean }>();

  /** Set a lead's bind aside when its set is archived, so the list holds
   *  only live sets; `restoreBind` puts it back with the set. */
  archiveBind(setId: string): void {
    this.move(setId, this.binds, this.archived);
  }

  restoreBind(setId: string): void {
    this.move(setId, this.archived, this.binds);
  }

  private move(
    setId: string,
    from: Record<string, LeadBindRecord>,
    to: Record<string, LeadBindRecord>,
  ): void {
    this.load();
    const record = from[setId];
    if (record === undefined) return;
    to[setId] = record;
    delete from[setId];
    this.save();
  }

  /**
   * The lead binds that hold `path`. Asked for a set, only that set's own
   * record, so a set the owner bound on the same folder is never held to a
   * lead's root. Asked without one, every record whose root holds the path:
   * a caller that cannot name the set is held to all of them.
   */
  private bindsOver(path: string, setId?: string): LeadBindRecord[] {
    this.load();
    const under = ({ root }: LeadBindRecord) => path === root || path.startsWith(`${root}/`);
    if (setId !== undefined) {
      const own = this.binds[setId];
      return own && under(own) ? [own] : [];
    }
    return Object.values(this.binds).filter(under);
  }

  /** Whether `path` (of `setId`, when the caller knows it) is under a
   *  root a lead bound: the guard's business. */
  covers(path: string, setId?: string): boolean {
    return this.bindsOver(path, setId).length > 0;
  }

  /**
   * The main-thread half of the guard (`bound-path-guard.ts` `PathGuards`): a path
   * under a lead's bind needs the root still registered for that board and
   * still resolving to itself, so no link has been swapped in for it.
   */
  admits(path: string, setId?: string, now = Date.now()): boolean {
    for (const { board, root } of this.bindsOver(path, setId)) {
      if (!this.rootsOf(board).includes(root)) return false;
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
  landsInside(path: string, real: string, setId?: string): boolean {
    return this.bindsOver(path, setId).every(
      ({ root }) => real === root || real.startsWith(`${root}/`),
    );
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(
      tmp,
      JSON.stringify({ boards: this.load(), binds: this.binds, archived: this.archived }, null, 2),
      {
        mode: 0o600,
      },
    );
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.path);
  }
}
