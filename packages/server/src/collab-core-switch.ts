/**
 * Which boards' doc and board sockets the collab core serves (D1 step 5).
 *
 * Two settings, and a board takes the core path only when both are on:
 *
 *   - Per board: `collab-core-boards.json` in the data folder, the ids of the
 *     boards switched on. Set by `POST /workspaces/<id>/collab-core`. Every
 *     board starts off.
 *   - Server-wide: `CW_COLLAB_CORE`, read once at boot. Off unless it says
 *     `on`. Off returns every board to the current code on the next start,
 *     whatever the file says, and leaves the file alone so the per-board
 *     settings come back when it is turned on again.
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

/** `CW_COLLAB_CORE`: on for `on`, `1` or `true`; off for anything else. */
export function parseCollabCoreDefault(value: string | undefined): boolean {
  const v = (value ?? '').trim().toLowerCase();
  return v === 'on' || v === '1' || v === 'true';
}

export interface CollabCoreSwitchOptions {
  dataDir: string;
  /** The server-wide setting, decided at boot. */
  serverWide: boolean;
}

export class CollabCoreSwitch {
  readonly serverWide: boolean;
  private readonly path: string;
  private readonly boards: Set<string>;

  constructor(opts: CollabCoreSwitchOptions) {
    this.serverWide = opts.serverWide;
    this.path = collabCoreBoardsPath(opts.dataDir);
    this.boards = new Set(readBoards(this.path));
  }

  /** The board's own setting, whatever the server-wide one is. */
  boardOn(workspaceId: string): boolean {
    return this.boards.has(workspaceId);
  }

  /** Whether a socket opened now on this board takes the core path. */
  usesCore(workspaceId: string): boolean {
    return this.serverWide && this.boards.has(workspaceId);
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
    if (on) this.boards.add(workspaceId);
    else this.boards.delete(workspaceId);
  }
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
