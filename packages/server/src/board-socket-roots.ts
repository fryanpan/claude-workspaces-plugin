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
import { type Dirent, realpathSync, statSync } from 'node:fs';
import { lstat, readdir, readlink, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { shortHash } from './bind-meta.ts';

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
      // Unreadable: no root is registered, so every lead bind is refused, and
      // the records of the sets leads already bound are lost with it. So the
      // guard fails closed on every lead set id (`isLeadSetId`), and nothing
      // is written over the file, which may only be mid-edit or misread.
      if (existsSync(this.path)) {
        this.broken = true;
        console.error(
          `[board-socket-roots] ${this.path} could not be read; refusing every lead's set until it can`,
        );
      }
    }
    this.boards = boards;
    return boards;
  }

  /** Set when the file exists and cannot be read: see `load`. */
  private broken = false;

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
    if (this.broken) return { ok: false, error: 'the roots file cannot be read' };
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
    if (this.broken) return;
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
    if (this.broken) return;
    const record = from[setId];
    if (record === undefined) return;
    to[setId] = record;
    delete from[setId];
    this.save();
  }

  /**
   * Every lead record, live or archived, whose root holds `path`, whatever
   * set the path is read for. Containment is judged over all of them: a set
   * the owner bound in a folder the lead can write is exposed to the same
   * swapped links, and an owner's file lands inside the root anyway.
   */
  private recordsOver(path: string): LeadBindRecord[] {
    this.load();
    const under = ({ root }: LeadBindRecord) => path === root || path.startsWith(`${root}/`);
    return [...Object.values(this.binds), ...Object.values(this.archived)].filter(under);
  }

  /** Whether `path` is under a root a lead bound: the guard's business.
   *  With the file unreadable, every lead set is, wherever it is. */
  covers(path: string, setId?: string): boolean {
    this.load();
    if (this.broken && setId !== undefined && isLeadSetId(setId)) return true;
    return this.recordsOver(path).length > 0;
  }

  /**
   * The main-thread half of the guard (`bound-path-guard.ts` `PathGuards`).
   * A path under a lead's root needs that root still resolving to itself,
   * so no link has been swapped in for it, and no `node_modules` folder on
   * its way below the root, the one place a walled lead may make links
   * (`scripts/lead-sandbox-wall.ts`). A lead's own set also needs its root
   * still registered for the board; that check alone is keyed by the set,
   * so dropping a root stops the lead's set and leaves serving an owner's
   * set and an owner's lone doc, which names no set, on the same folder.
   */
  admits(path: string, setId?: string, now = Date.now()): boolean {
    this.load();
    if (this.broken && setId !== undefined && isLeadSetId(setId)) return false;
    for (const record of this.recordsOver(path)) {
      const { root } = record;
      if (path.slice(root.length).split('/').includes('node_modules')) return false;
      const own = setId !== undefined && this.binds[setId] === record;
      if (own && !this.rootsOf(record.board).includes(root)) return false;
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
    this.load();
    if (this.broken && setId !== undefined && isLeadSetId(setId)) return false;
    return this.recordsOver(path).every(({ root }) => real === root || real.startsWith(`${root}/`));
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

/** The most entries `linkOutOf` will look at before it gives up. */
/** Every set a lead binds has an id of this shape (`leadSetId`). */
const LEAD_SET_PREFIX = 'lead-';

/** The set id a lead's bind of `root` gets: `lead-`, the folder's name, and
 *  a hash of the root AND the board, so no other board's set shares it. */
export function leadSetId(root: string, board: string): string {
  const base = basename(root).replace(/[^a-zA-Z0-9_.\-]/g, '-') || 'workspace';
  return `${LEAD_SET_PREFIX}${base}-${shortHash(`${root}\0${board}`)}`;
}

/** Whether `setId` has the shape only a lead's bind gives. */
export function isLeadSetId(setId: string): boolean {
  return setId.startsWith(LEAD_SET_PREFIX);
}

export const LINK_SCAN_MAX = 200_000;

/**
 * The first symlink under `root` a lead could turn outward, as a path
 * relative to the root; `'too-many'` past {@link LINK_SCAN_MAX} entries;
 * null when there is none. A link is refused when it leads outside the
 * root or nowhere, and also when its target is absolute or climbs with
 * `..`: the lead may rename the folders around a relative link, which
 * creates no link and so is not refused by its profile, and a `../x` that
 * lands inside today can land outside after one `mv`. A link whose target
 * only descends stays inside whatever folder it is moved with. Links are
 * not followed, and `node_modules` folders are not walked: a walled lead
 * may make links there (`scripts/lead-sandbox-wall.ts`), and the guard
 * refuses every path through one. A file with a second name is refused
 * too, since a hard link resolves inside the root wherever its other name
 * is; inside `.git`, where a local clone shares object files, that is left
 * to the guard, which refuses a read of one.
 */
export async function linkOutOf(root: string): Promise<string | 'too-many' | null> {
  const inside = (p: string) => p === root || p.startsWith(`${root}/`);
  const queue = [root];
  const inGit = (p: string) => p.slice(root.length).split('/').includes('.git');
  let seen = 0;
  for (let dir = queue.pop(); dir !== undefined; dir = queue.pop()) {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (++seen > LINK_SCAN_MAX) return 'too-many';
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') queue.push(path);
      } else if (entry.isSymbolicLink()) {
        let target = '';
        let real: string | null = null;
        try {
          target = await readlink(path);
          real = await realpath(path);
        } catch {}
        const climbs = isAbsolute(target) || target.split('/').includes('..');
        if (real === null || !inside(real) || climbs) return path.slice(root.length + 1);
      } else if (entry.isFile() && !inGit(path)) {
        try {
          if ((await lstat(path)).nlink > 1) return path.slice(root.length + 1);
        } catch {}
      }
    }
  }
  return null;
}
