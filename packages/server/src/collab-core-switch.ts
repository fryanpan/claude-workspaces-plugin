/**
 * Which boards' doc and board sockets the collab core serves (D1 step 5).
 *
 * Two settings, and a board takes the core path only when both are on:
 *
 *   - Per board: `collab-core-boards.json` in the data folder, the ids of the
 *     boards switched on. Set by `POST /workspaces/<id>/collab-core`
 *     (`{ on }`). Every board starts off.
 *   - Server-wide: `collab-core-server.json` beside it, set by the same route
 *     (`{ serverWide }`) so the owner can turn it on from a board without an
 *     edit to the server's launch environment. Off until somebody turns it
 *     on. Off returns every board to the current code for every socket opened
 *     afterwards, and leaves the per-board file alone so those settings come
 *     back when it is turned on again.
 *
 * `CW_COLLAB_CORE` (or `ServerOptions.collabCore`) still decides the
 * server-wide setting when it is set: `on`, `1` or `true` fixes it on, any
 * other value fixes it off, and a fixed setting cannot be changed at
 * runtime. So an operator can always force the core off with one variable.
 * Unset, the file decides.
 *
 * Read at connect: a socket keeps the path it opened on for its life, so a
 * change reaches a board's pages at their next reconnect. Both paths sync the
 * same live doc the doc store persists, so switching loses nothing
 * (`collab-core-path.ts`).
 */
import { join } from 'node:path';
import { readSmallFile, replaceFile } from '@claude-workspaces/core/safe-file';

/** A board id this file will hold: what a workspace id may be. */
const BOARD_ID = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,99}$/;

export function collabCoreBoardsPath(dataDir: string): string {
  return join(dataDir, 'collab-core-boards.json');
}

export function collabCoreServerPath(dataDir: string): string {
  return join(dataDir, 'collab-core-server.json');
}

/**
 * `CW_COLLAB_CORE`: unset or blank leaves the setting to the runtime switch
 * (`undefined`); `on`, `1` or `true` fixes it on; anything else fixes it off.
 */
export function parseCollabCoreEnv(value: string | undefined): boolean | undefined {
  const v = (value ?? '').trim().toLowerCase();
  if (v === '') return undefined;
  return v === 'on' || v === '1' || v === 'true';
}

/** The server-wide setting was fixed by the environment and cannot change. */
export class CollabCoreFixedError extends Error {
  constructor(readonly fixedOn: boolean) {
    super(`the collab core is fixed ${fixedOn ? 'on' : 'off'} by CW_COLLAB_CORE`);
  }
}

export interface CollabCoreSwitchOptions {
  dataDir: string;
  /** The server-wide setting as the environment fixes it, or `undefined`
   *  when it leaves it to the runtime switch. */
  fixed?: boolean | undefined;
}

export class CollabCoreSwitch {
  /** The environment's fixed server-wide setting, if it set one. */
  readonly fixed: boolean | undefined;
  private readonly path: string;
  private readonly serverPath: string;
  private readonly boards: Set<string>;
  private runtimeOn: boolean;
  private readonly listeners = new Set<(workspaceId: string) => void>();

  constructor(opts: CollabCoreSwitchOptions) {
    this.fixed = opts.fixed;
    this.path = collabCoreBoardsPath(opts.dataDir);
    this.serverPath = collabCoreServerPath(opts.dataDir);
    this.boards = new Set(readBoards(this.path));
    this.runtimeOn = readServerWide(this.serverPath);
  }

  /** The server-wide setting in force: the environment's, else the runtime one. */
  get serverWide(): boolean {
    return this.fixed ?? this.runtimeOn;
  }

  /** The board's own setting, whatever the server-wide one is. */
  boardOn(workspaceId: string): boolean {
    return this.boards.has(workspaceId);
  }

  /** Whether a socket opened now on this board takes the core path. */
  usesCore(workspaceId: string): boolean {
    return this.serverWide && this.boards.has(workspaceId);
  }

  /** Whether any board is switched on, whatever the server-wide setting. */
  anyBoardOn(): boolean {
    return this.boards.size > 0;
  }

  /** Every board switched on, sorted. */
  boardsOn(): string[] {
    return [...this.boards].sort();
  }

  /** Switch one board on or off, and save. Throws on a bad id or a failed save. */
  set(workspaceId: string, on: boolean): void {
    if (!BOARD_ID.test(workspaceId)) throw new Error(`not a board id: ${workspaceId}`);
    if (this.boards.has(workspaceId) === on) return;
    const next = new Set(this.boards);
    if (on) next.add(workspaceId);
    else next.delete(workspaceId);
    replaceFile(this.path, `${JSON.stringify({ boards: [...next].sort() })}\n`, 0o600);
    const before = this.usesCore(workspaceId);
    if (on) this.boards.add(workspaceId);
    else this.boards.delete(workspaceId);
    if (this.usesCore(workspaceId) !== before) this.tell(workspaceId);
  }

  /**
   * Turn the server-wide setting on or off, and save. Throws
   * `CollabCoreFixedError` when the environment fixed it to the other value,
   * and on a failed save. Every board switched on hears the change.
   */
  setServerWide(on: boolean): void {
    if (this.fixed !== undefined) {
      if (this.fixed !== on) throw new CollabCoreFixedError(this.fixed);
      return;
    }
    if (this.runtimeOn === on) return;
    replaceFile(this.serverPath, `${JSON.stringify({ on })}\n`, 0o600);
    this.runtimeOn = on;
    for (const ws of this.boardsOn()) this.tell(ws);
  }

  /** Be told which board's path changed, after it does. Returns the
   *  unsubscribe. A call that changes no board's path tells nobody. */
  onChange(fn: (workspaceId: string) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private tell(workspaceId: string): void {
    for (const fn of this.listeners) fn(workspaceId);
  }
}

/** What a board page is told about its board: whether its sockets take the
 *  core (`active`), the two settings behind that, and whether the
 *  environment fixed the server-wide one. */
export interface CollabCoreView {
  active: boolean;
  on: boolean;
  serverWide: boolean;
  fixed: 'on' | 'off' | null;
}

export function collabCoreView(sw: CollabCoreSwitch, workspaceId: string): CollabCoreView {
  return {
    active: sw.usesCore(workspaceId),
    on: sw.boardOn(workspaceId),
    serverWide: sw.serverWide,
    fixed: sw.fixed === undefined ? null : sw.fixed ? 'on' : 'off',
  };
}

/** The ids the file names. A missing, unreadable or malformed file is every
 *  board off, which is the current code: the safe reading. */
function readBoards(path: string): string[] {
  const text = readSmallFile(path);
  if (text === null) return [];
  try {
    const parsed = JSON.parse(text) as { boards?: unknown };
    if (!Array.isArray(parsed.boards)) return [];
    return parsed.boards.filter((b): b is string => typeof b === 'string' && BOARD_ID.test(b));
  } catch {
    console.error(`[collab-core] ${path} is not JSON; every board takes the current code`);
    return [];
  }
}

/** On only when the file says exactly `{"on": true}`; anything else is off. */
function readServerWide(path: string): boolean {
  const text = readSmallFile(path);
  if (text === null) return false;
  try {
    return (JSON.parse(text) as { on?: unknown }).on === true;
  } catch {
    console.error(`[collab-core] ${path} is not JSON; the collab core stays off`);
    return false;
  }
}
