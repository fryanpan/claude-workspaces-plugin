/**
 * Board sockets: one unix socket per board, `<dir>/<boardId>.sock`, mode 600.
 *
 * A sandboxed lead's profile may connect to its own board's socket and to no
 * other socket in `dir`, and it denies every board server's TCP port
 * (`scripts/lead-sandbox-wall.ts`). So the socket a request arrived on names
 * its board, and the sandbox, not the lead, decides which one that is. The
 * listener records the board for each request it accepts;
 * `request-admission.ts` reads that record, never the Host header, and
 * `middleware/board-socket-door.ts` holds the request to that board.
 *
 * One board's socket may be shared with the members of one group
 * (`shared`): that socket is given to the group, mode 660, and the folder is
 * mode 710, so a member opens that socket by name and cannot list the folder
 * to find another. Every other user is refused both. The server's user must
 * be a member of the group to give the socket to it. A project machine's lead reaches its board this way
 * (`infra/project-machine/entrypoint.sh`), and `middleware/loopback-uid-door.ts`
 * refuses it every TCP way in.
 *
 * A request here has no peer address (Bun's `requestIP` answers null for a
 * unix socket), so every loopback-only check further down the chain refuses
 * it as well. Websocket upgrades are refused: the upgrade routes call the TCP
 * server's `upgrade`, which cannot take a connection this listener accepted.
 */
import { chmodSync, chownSync, lstatSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

/** A unix socket path, NUL included, must fit `sun_path`: 104 bytes on macOS. */
export const SOCKET_PATH_MAX_BYTES = 103;

/** The longest board id the directory is checked against (`w-` and 12 more is today's). */
const BOARD_ID_BUDGET = 32;

/** A board id that is safe as a file name. */
const BOARD_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Where the sockets go when nothing says: short, so every board's path fits,
 * and not under the home folder, which every lead's profile denies.
 */
export function defaultBoardSocketDir(uid: number): string {
  return `/private/tmp/cw-${uid}-boards`;
}

/** The socket path for one board. */
export function boardSocketPath(dir: string, boardId: string): string {
  return join(dir, `${boardId}.sock`);
}

/** Why `dir` cannot hold the sockets, or null when it can. */
export function boardSocketDirError(dir: string): string | null {
  if (!dir.startsWith('/')) return `board socket folder ${dir} must be absolute`;
  const longest = Buffer.byteLength(boardSocketPath(dir, 'x'.repeat(BOARD_ID_BUDGET)));
  if (longest > SOCKET_PATH_MAX_BYTES)
    return `board socket folder ${dir} is too long: a socket in it would take ${longest} bytes, and a unix socket path is limited to ${SOCKET_PATH_MAX_BYTES}`;
  return null;
}

export interface BoardSockets {
  /** The board whose socket this request arrived on, or null for any other request. */
  boardOf: (req: Request) => string | null;
  /** Open a socket for each board listed that has none, and close the rest. */
  sync: (boardIds: readonly string[]) => void;
  /** The boards with an open socket. */
  open: () => string[];
  /** Close every socket. */
  stop: () => void;
}

export interface BoardSocketsOptions {
  dir: string;
  /** The server's front door, the same one the TCP listener calls. */
  handle: (req: Request) => Promise<Response | undefined>;
  j: (status: number, body: unknown) => Response;
  log?: (line: string) => void;
  /** The one board whose socket the group's members may open (see the header). */
  shared?: { board: string; gid: number };
}

export function openBoardSockets(opts: BoardSocketsOptions): BoardSockets {
  const { dir, handle, j } = opts;
  const log = opts.log ?? ((line: string) => console.error(line));
  const refused = boardSocketDirError(dir);
  if (refused) throw new Error(refused);
  ensurePrivateDir(dir, opts.shared?.gid);
  const boardFor = new WeakMap<Request, string>();
  const listeners = new Map<string, { stop: (closeActive?: boolean) => void }>();

  const openOne = (boardId: string): void => {
    const path = boardSocketPath(dir, boardId);
    if (!BOARD_ID.test(boardId) || Buffer.byteLength(path) > SOCKET_PATH_MAX_BYTES) {
      log(`[board-sockets] no socket for board ${boardId}: ${path} is not a usable socket path`);
      return;
    }
    removeStaleSocket(path);
    try {
      // Bound under umask 077, so the socket is never more open than this
      // user's, even before the mode below is set.
      const umask = process.umask(0o077);
      let server: ReturnType<typeof Bun.serve>;
      try {
        server = Bun.serve({
          unix: path,
          async fetch(req) {
            if (req.headers.get('upgrade')) return j(403, { error: 'board_socket_no_upgrade' });
            boardFor.set(req, boardId);
            return (await handle(req)) ?? j(500, { error: 'board_socket_no_response' });
          },
        });
      } finally {
        process.umask(umask);
      }
      // Only this user may connect, but for the shared board's socket, which
      // its group may too. A sandboxed lead on the Mac runs as the same user;
      // its profile, not the file mode, tells one lead from another.
      // A socket whose mode could not be set is closed, never left open.
      try {
        if (boardId === opts.shared?.board) {
          if (lstatSync(path).gid !== opts.shared.gid) chownSync(path, ownUid(), opts.shared.gid);
          chmodSync(path, 0o660);
        } else {
          chmodSync(path, 0o600);
        }
      } catch (err) {
        server.stop(true);
        removeStaleSocket(path);
        throw err;
      }
      listeners.set(boardId, server);
    } catch (err) {
      log(`[board-sockets] could not open ${path}: ${err instanceof Error ? err.message : err}`);
    }
  };

  const closeOne = (boardId: string): void => {
    listeners.get(boardId)?.stop(true);
    listeners.delete(boardId);
    removeStaleSocket(boardSocketPath(dir, boardId));
  };

  return {
    boardOf: (req) => boardFor.get(req) ?? null,
    sync(boardIds) {
      const want = new Set(boardIds);
      for (const id of [...listeners.keys()]) if (!want.has(id)) closeOne(id);
      for (const id of want) if (!listeners.has(id)) openOne(id);
    },
    open: () => [...listeners.keys()],
    stop() {
      for (const id of [...listeners.keys()]) closeOne(id);
    },
  };
}

/**
 * Make the folder, or take one that exists, only if it is a real folder this
 * user owns; then nobody else may enter it. Another user's folder at a
 * guessable `/private/tmp` path is refused, never used. With a socket shared
 * with group `gid`, the folder is that group's, mode 710: the group may enter
 * and not list. Otherwise it is mode 700.
 */
function ensurePrivateDir(dir: string, gid?: number): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  const uid = process.getuid?.();
  if (!st.isDirectory() || (uid !== undefined && st.uid !== uid))
    throw new Error(`board socket folder ${dir} is not a folder this user owns`);
  if (gid !== undefined && st.gid !== gid) chownSync(dir, ownUid(), gid);
  chmodSync(dir, gid === undefined ? 0o700 : 0o710);
}

/**
 * This user's uid, for a chown that changes only the group: Bun's `chownSync`
 * refuses -1 ("leave it") with EPERM, measured in the project machine's image.
 */
function ownUid(): number {
  return process.getuid?.() ?? -1;
}

/**
 * A socket file left by a process that died is removed, so the bind does not
 * fail. Anything else at the path is left alone and the bind fails on it.
 */
function removeStaleSocket(path: string): void {
  try {
    if (lstatSync(path).isSocket()) unlinkSync(path);
  } catch {
    // Nothing there.
  }
}
