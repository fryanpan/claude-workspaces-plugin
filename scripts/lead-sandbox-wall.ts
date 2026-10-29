/**
 * The board wall: the rules that hold a sandboxed lead to its own board.
 *
 * Without them a lead's `curl 127.0.0.1:8787` is a trusted-local caller and
 * reads every board. So each board server's TCP port is denied at every
 * address (`*:<port>`), which covers `localhost`, `::1` and this machine's LAN
 * and tailnet addresses too. The ports are `BOARD_SERVER_PORTS`, which
 * `scripts/staging.ts` also enforces, so a staging server cannot listen where
 * the wall does not look.
 *
 * What is left is the board sockets (`packages/server/src/board-sockets.ts`):
 * one per board in one folder, and the socket a request arrives on names its
 * board. A walled lead may connect to its own board's socket and to no other
 * socket in that folder, and may write nothing there, so it can neither
 * reach another board's socket nor link one in under its own name. Its other
 * local sockets are not touched.
 *
 * In its own projects (`board-socket-roots.ts` holds the server to them),
 * it may make no new symlink or hard link outside a `node_modules` folder,
 * since the server reads and writes through what it finds there. A package
 * manager needs links in `node_modules`; the server refuses every path
 * through one, and a `node_modules` folder may not be renamed or removed,
 * so nothing made in it moves out. The server runs no git in a repository
 * holding one of its projects (`packages/server/src/git-hardening.ts`), so git's settings
 * files are left writable.
 *
 * Off unless a lead's config sets `boardWall`. A walled lead is launched with
 * `CW_BOARD_SOCKET` naming its own board's socket, which its MCP relay dials
 * (`lead-sandbox.ts`, `boardSocketEnv`).
 */
import { defaultBoardSocketDir } from '../packages/server/src/board-sockets.ts';
import { BOARD_SERVER_PORTS } from '../packages/server/src/reserved-ports.ts';

export { BOARD_SERVER_PORTS, defaultBoardSocketDir };

/** What the wall needs to know about a lead. */
export interface WalledLead {
  boardWall: boolean;
  /** The board it works on; required when `boardWall` is set. */
  boardId?: string;
  /** Its own project folders, which the server may read and write for it. */
  projects?: readonly string[];
  /** The other paths its config opens to it for writing, which the server
   *  also holds as its roots (`lead-sandbox-roots.ts` `leadRoots`). */
  allow?: readonly string[];
}

/**
 * The lines for a lead, or none when its config leaves the wall off. Each
 * rule on the socket folder is written at both ends of every symlink above
 * it (`/tmp` is `/private/tmp`), since a connect may name either.
 */
export function boardWallRules(
  lead: WalledLead,
  socketDir: string,
  realpath: (path: string) => string = (p) => p,
  ports: readonly number[] = BOARD_SERVER_PORTS,
): string[] {
  if (!lead.boardWall) return [];
  if (!lead.boardId) throw new Error('a walled lead needs a boardId');
  const ends = socketDirEnds(socketDir, realpath);
  return [
    ...ports.map(
      (port) => `(deny network-outbound (remote ip "*:${port}")) ; a board server's port`,
    ),
    ...ends.map(
      (d) =>
        `(deny network-outbound (remote unix-socket (subpath ${sbQuote(d)}))) ; every board's socket`,
    ),
    ...ends.map(
      (d) =>
        `(allow network-outbound (remote unix-socket (path-literal ${sbQuote(`${d}/${lead.boardId}.sock`)}))) ; its own board's socket`,
    ),
    ...ends.map(
      (d) => `(deny file-write* (subpath ${sbQuote(d)})) ; no link to another board's socket`,
    ),
    // Every path it can write, so no link appears under a root the server
    // holds. An `allow` file or missing folder is named too: no link can
    // then be made at that name.
    ...[...(lead.projects ?? []), ...(lead.allow ?? [])].flatMap((p) => projectRules(p, realpath)),
  ];
}

/** Outside `node_modules`, at any depth. */
const NOT_NODE_MODULES = '(require-not (regex #"/node_modules(/|$)"))';

/** The rules for one folder it can write, at each of its spellings. */
function projectRules(project: string, realpath: (path: string) => string): string[] {
  return socketDirEnds(project, realpath).flatMap((d) => {
    sbQuote(d);
    const re = d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return [
      `(deny file-write-create (require-all (vnode-type SYMLINK) (subpath ${sbQuote(d)}) ${NOT_NODE_MODULES})) ; no new symlink in a project`,
      `(deny file-link (require-all (subpath ${sbQuote(d)}) ${NOT_NODE_MODULES})) ; no new hard link in a project`,
      `(deny file-write-unlink (regex #"^${re}(/.*)?/node_modules$")) ; node_modules stays where it is`,
    ];
  });
}

/** The folder, resolved, and its other spelling across `/tmp` and `/private/tmp`. */
export function socketDirEnds(dir: string, realpath: (path: string) => string): string[] {
  const out = new Set<string>();
  for (const d of [dir, realpath(dir)]) {
    out.add(d);
    if (d === '/private/tmp' || d.startsWith('/private/tmp/')) out.add(d.slice('/private'.length));
    else if (d === '/tmp' || d.startsWith('/tmp/')) out.add(`/private${d}`);
  }
  return [...out];
}

function sbQuote(path: string): string {
  if (/["\\\n\r]/.test(path)) throw new Error(`${path} must not hold a quote or a backslash`);
  return `"${path}"`;
}

/**
 * What a TCP connect answers, from `node -e` or `bun -e`: `connected`, or
 * the error code. Under the wall the code is `EPERM`, which a port with
 * nothing listening (`ECONNREFUSED`) cannot be mistaken for.
 */
export const CONNECT_PROBE = `const s = require('node:net').connect({ host: process.env.HOST, port: Number(process.env.PORT) });
s.setTimeout(3000);
s.on('connect', () => { console.log('connected'); s.destroy(); });
s.on('timeout', () => { console.log('timeout'); s.destroy(); });
s.on('error', (e) => console.log(e.code ?? 'error'));`;

/** The same for a unix socket at `SOCK`. */
export const SOCKET_CONNECT_PROBE = `const s = require('node:net').connect(process.env.SOCK);
s.setTimeout(3000);
s.on('connect', () => { console.log('connected'); s.destroy(); });
s.on('timeout', () => { console.log('timeout'); s.destroy(); });
s.on('error', (e) => console.log(e.code ?? 'error'));`;

/**
 * Every address a lead could reach this machine's board server at: both
 * loopbacks, and each LAN and tailnet address the interfaces report.
 * IPv6 link-local addresses are left out; they need a zone to connect to.
 */
export function wallHosts(
  interfaces: NodeJS.Dict<Array<{ address: string; family: string; internal: boolean }>>,
): string[] {
  const out = new Set(['127.0.0.1', '::1']);
  for (const list of Object.values(interfaces))
    for (const i of list ?? [])
      if (!i.internal && !i.address.toLowerCase().startsWith('fe80:')) out.add(i.address);
  return [...out];
}
