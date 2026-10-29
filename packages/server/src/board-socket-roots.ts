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
 * re-checked (`pathAllowed`, installed as a `slow-fs.ts` path guard).
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

export class BoardSocketRoots {
  private boards: Record<string, string[]> | null = null;
  private binds: Record<string, LeadBindRecord> = {};

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
      const binds: unknown = raw?.binds;
      if (binds && typeof binds === 'object') {
        for (const [setId, b] of Object.entries(binds as Record<string, unknown>)) {
          const { board, root } = (b ?? {}) as Record<string, unknown>;
          if (typeof board === 'string' && typeof root === 'string' && isAbsolute(root))
            this.binds[setId] = { board, root };
        }
      }
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

  /**
   * Whether a bound read, stat or write of `path` may go ahead
   * (`slow-fs.ts` `addPathGuard`). A path under no lead's bind is not this
   * list's business. One under a lead's bind needs the root still registered
   * for that board, still resolving to itself (no link swapped in for it),
   * and the path, where it exists, still landing inside it.
   */
  pathAllowed(path: string): boolean {
    this.load();
    for (const { board, root } of Object.values(this.binds)) {
      if (path !== root && !path.startsWith(`${root}/`)) continue;
      if (!this.rootsOf(board).includes(root)) return false;
      try {
        if (this.realpath(root) !== root) return false;
      } catch {
        return false;
      }
      if (path === root) continue;
      let real: string | null = null;
      try {
        real = this.realpath(path);
      } catch {
        // Not there yet: a write that creates it lands under the root.
      }
      if (real !== null && real !== root && !real.startsWith(`${root}/`)) return false;
    }
    return true;
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify({ boards: this.load(), binds: this.binds }, null, 2), {
      mode: 0o600,
    });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.path);
  }
}
