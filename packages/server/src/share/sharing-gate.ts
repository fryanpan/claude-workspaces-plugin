/**
 * The master switch for external access.
 *
 * Revoking shares one at a time is the wrong tool when the question is "is
 * this server safe to expose at all?" — you have to enumerate them, you can
 * still mint new ones, and there is no single thing to look at to answer "is
 * anything reachable from outside right now?". This is that single thing.
 *
 * When it is off, EVERY non-local host is refused before authentication runs:
 * a valid share link, a live Access JWT and an unexpired session cookie all
 * get the same 403. Local callers (loopback, tailnet, LAN) are untouched, so
 * the agent's own MCP tools and Bryan's browser keep working — the point is
 * to close the outside door, not to stop work.
 *
 * Two ways to set it:
 *
 *   - At runtime, persisted: `POST /api/share/enabled {enabled:false}` or the
 *     `set_sharing_enabled` MCP tool. Survives restarts, because a switch that
 *     silently flips back on after a crash is worse than no switch.
 *   - `CW_SHARING_DISABLED=1` in the environment: off AND LOCKED — the runtime
 *     call refuses with `env_locked`. That is the one to use while a security
 *     review is in flight, because it cannot be undone by anything short of
 *     editing the service definition, including by this process's own API.
 *
 * Fails closed. A `sharing.json` we cannot parse means we do not know what
 * the operator intended, and for a gate that guards external reach, "don't
 * know" has to mean "no". (Contrast Shares.load, which starts clean on a
 * corrupt registry — losing shares is recoverable; serving them when you
 * meant not to is not.)
 *
 * **One board can be closed without the rest.** `closedBoards` is a second,
 * narrower answer to the same question: while a board is in it, that board's
 * share, share-link and collaboration visitors are refused and nobody new can
 * redeem a link to it. The owner's own hostname (`proxied-local`) and every
 * local caller are untouched, so closing one board as a precaution cannot lock
 * the owner out of any board, which is what throwing the master switch did on
 * 23 September. A board id that does not name a board closes nothing and is
 * refused at the route, not here.
 *
 * **A board can be locked never-shareable.** `lockedBoards` refuses MINTING:
 * `share_workspace` and `share_link` answer `board_never_shareable` for a
 * locked board, so putting sensitive files on it no longer depends on nobody
 * ever minting a link. A locked board is closed to visitors as well — the
 * narrower answer wins, so a link minted before the lock opens nothing — and
 * reopening it with `setBoardEnabled` does not undo the lock. Only a caller on
 * the box can set or clear it (`routes/board-lock.ts`).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const FILENAME = 'sharing.json';

export type SetResult = { ok: true; enabled: boolean } | { ok: false; error: 'env_locked' };

export type BoardSetResult =
  | { ok: true; workspaceId: string; enabled: boolean }
  | { ok: false; error: 'env_locked' };

export type BoardLockResult =
  | { ok: true; workspaceId: string; locked: boolean }
  | { ok: false; error: 'env_locked' };

/** The on-disk shape. `closedBoards` is absent when no board is closed, so a
 *  file written before it existed reads exactly as it did. */
interface SharingFile {
  enabled: boolean;
  closedBoards?: string[];
  /** Boards no share may be minted for. Absent when none is locked. */
  lockedBoards?: string[];
}

export interface SharingGateOptions {
  dataDir: string;
  /** True when CW_SHARING_DISABLED is set — off and not runtime-changeable. */
  envLocked?: boolean;
}

export class SharingGate {
  private readonly path: string;
  private readonly envLocked: boolean;
  private enabled: boolean;
  /** Boards whose outside visitors are refused while the master switch is on. */
  private readonly closed = new Set<string>();
  /** Boards no share may be minted for, and closed to visitors besides. */
  private readonly locked = new Set<string>();
  /** Set when the state on disk was unreadable, so callers can say WHY it's
   *  off rather than leaving the operator to guess at a silent gate. */
  readonly loadError: string | null = null;

  constructor(opts: SharingGateOptions) {
    this.path = join(opts.dataDir, FILENAME);
    this.envLocked = opts.envLocked ?? false;
    if (this.envLocked) {
      this.enabled = false;
      return;
    }
    // Absent is not corrupt: a fresh install has never been configured, and
    // its default is the behaviour everything had before this existed.
    if (!existsSync(this.path)) {
      this.enabled = true;
      return;
    }
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8'));
      if (typeof parsed?.enabled !== 'boolean') throw new Error('missing "enabled" boolean');
      const boards: unknown = parsed.closedBoards;
      if (boards !== undefined) {
        if (!Array.isArray(boards) || boards.some((b) => typeof b !== 'string')) {
          throw new Error('"closedBoards" is not a list of board ids');
        }
        for (const b of boards as string[]) this.closed.add(b);
      }
      const lockedBoards: unknown = parsed.lockedBoards;
      if (lockedBoards !== undefined) {
        if (!Array.isArray(lockedBoards) || lockedBoards.some((b) => typeof b !== 'string')) {
          throw new Error('"lockedBoards" is not a list of board ids');
        }
        for (const b of lockedBoards as string[]) this.locked.add(b);
      }
      this.enabled = parsed.enabled;
    } catch (err) {
      this.enabled = false;
      this.loadError = err instanceof Error ? err.message : 'unreadable sharing.json';
    }
  }

  /** May external (share / link) hosts be served right now? */
  isEnabled(): boolean {
    return this.enabled;
  }

  /** True when the environment pinned this off and the API cannot reopen it. */
  isLocked(): boolean {
    return this.envLocked;
  }

  /**
   * Flip the switch and persist. Returns the resulting state, or `env_locked`
   * when CW_SHARING_DISABLED is in force — a lock the process can talk itself
   * out of is not a lock.
   */
  setEnabled(enabled: boolean): SetResult {
    if (this.envLocked) return { ok: false, error: 'env_locked' };
    this.enabled = enabled;
    this.persist();
    return { ok: true, enabled };
  }

  /** May this one board's outside visitors be served? Independent of the
   *  master switch: the admission gate asks both. */
  isBoardOpen(workspaceId: string): boolean {
    return !this.closed.has(workspaceId) && !this.locked.has(workspaceId);
  }

  /** Is this board locked never-shareable — may no share be minted for it? */
  isBoardLocked(workspaceId: string): boolean {
    return this.locked.has(workspaceId);
  }

  /**
   * Lock or unlock ONE board against minting, and persist. Refused under the
   * env lock for the reason `setBoardEnabled` is: the constructor never read
   * the operator's file, so writing now would overwrite it.
   */
  setBoardLocked(workspaceId: string, locked: boolean): BoardLockResult {
    if (this.envLocked) return { ok: false, error: 'env_locked' };
    if (locked) this.locked.add(workspaceId);
    else this.locked.delete(workspaceId);
    this.persist();
    return { ok: true, workspaceId, locked };
  }

  /**
   * Open or close ONE board to outside visitors, and persist. Never touches
   * the master switch. Refused under the env lock like the master switch is:
   * every outside door is already shut, and a board list written while the
   * process cannot read the operator's file would overwrite it.
   */
  setBoardEnabled(workspaceId: string, enabled: boolean): BoardSetResult {
    if (this.envLocked) return { ok: false, error: 'env_locked' };
    if (enabled) this.closed.delete(workspaceId);
    else this.closed.add(workspaceId);
    this.persist();
    return { ok: true, workspaceId, enabled };
  }

  private persist(): void {
    const file: SharingFile = {
      enabled: this.enabled,
      ...(this.closed.size > 0 ? { closedBoards: [...this.closed].sort() } : {}),
      ...(this.locked.size > 0 ? { lockedBoards: [...this.locked].sort() } : {}),
    };
    writeFileSync(this.path, `${JSON.stringify(file, null, 2)}\n`);
  }

  /** Everything a status view needs, in one object. */
  status(): {
    enabled: boolean;
    locked: boolean;
    closedBoards?: string[];
    lockedBoards?: string[];
    loadError?: string;
  } {
    return {
      enabled: this.enabled,
      locked: this.envLocked,
      ...(this.closed.size > 0 ? { closedBoards: [...this.closed].sort() } : {}),
      ...(this.locked.size > 0 ? { lockedBoards: [...this.locked].sort() } : {}),
      ...(this.loadError ? { loadError: this.loadError } : {}),
    };
  }
}
