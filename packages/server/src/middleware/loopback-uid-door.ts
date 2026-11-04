/**
 * Admit loopback TCP only from users this machine names.
 *
 * On a project machine the server, its tunnel, its backup upload and its lead
 * agent run as separate users (`infra/project-machine/entrypoint.sh`), and
 * more users (builders) may join them. A loopback caller is trusted as the
 * owner in several places (`isLoopbackAddress`, `CW_LOOPBACK_SKIPS_ACCESS`),
 * which is right for the server calling itself and wrong for everyone else.
 * So the door is an allowlist, in two lists:
 *
 * - `allowed` (`CW_LOOPBACK_ALLOWED_UIDS`): the operator. On a project
 *   machine that is `cw` alone, the server itself: its hosted MCP connector
 *   calls its own REST over loopback (`connector/host.ts`), and a process
 *   running as `cw` can read the data dir and its keys anyway, so refusing it
 *   would buy nothing. Root is not on it (security review M3): the
 *   supervisor keeps only the power to switch users, so a machine tool run
 *   over `fly ssh console` that calls the REST runs as `cw`
 *   (`asCw`, `infra/project-machine/mac-ops.ts`). The health check counts
 *   any answer, the 403 this door gives root included, as alive.
 * - `edge` (`CW_LOOPBACK_EDGE_UIDS`): cloudflared, which carries the edge's
 *   requests to the server and must keep doing so. Its requests are admitted
 *   only when they carry `cf-ray`, which Cloudflare stamps on everything it
 *   proxies and which the host guard never classifies local
 *   (`host-guard.ts`), so they are gated by Access like any edge visitor. A
 *   request from that uid without `cf-ray` is refused: a steered cloudflared
 *   cannot pass for the box.
 *
 * Every other uid is refused: root, the lead, the backup upload, a builder
 * added next month. A request whose TCP peer is refused is answered 403 before
 * anything else reads it; the lead reaches its own board through that
 * board's socket (`board-sockets.ts`).
 *
 * The uid comes from the kernel. On Linux `/proc/net/tcp` and `/proc/net/tcp6`
 * list every socket with its owner's uid; the caller's end of this connection
 * is the row whose local port is the peer's port and whose remote port is the
 * server's. A caller cannot choose that uid. When no single row answers — the
 * tables cannot be read, no live row matches (the caller closed its socket:
 * see `peerUidFromTables`), or rows of several uids match — the request is
 * refused: this door fails closed, and is only switched on where the users
 * exist (a non-empty `CW_LOOPBACK_ALLOWED_UIDS`).
 *
 * A request with no TCP peer (a board socket's) or a non-loopback peer is not
 * this door's to judge.
 */
import { readFileSync } from 'node:fs';
import { isLoopbackAddress } from './host-guard.ts';

export interface TcpPeer {
  address: string;
  port: number;
}

/** The uid that owns the caller's end of a loopback connection, or null. */
export type PeerUidReader = (peer: TcpPeer, serverPort: number) => number | null;

const NET_TABLES = ['/proc/net/tcp', '/proc/net/tcp6'];

/** Whether a `/proc/net/tcp*` address (hex, as the kernel prints it) is loopback. */
function hexIsLoopback(hex: string): boolean {
  if (hex.length === 8) return hex.slice(6, 8).toUpperCase() === '7F';
  if (hex.length !== 32) return false;
  // Four 32-bit words, each in host (little-endian) byte order.
  const bytes: number[] = [];
  for (let w = 0; w < 4; w++)
    for (let b = 3; b >= 0; b--)
      bytes.push(Number.parseInt(hex.slice(w * 8 + b * 2, w * 8 + b * 2 + 2), 16));
  const zeroTo = (n: number) => bytes.slice(0, n).every((x) => x === 0);
  if (zeroTo(15) && bytes[15] === 1) return true; // ::1
  // ::ffff:127.x.x.x
  return zeroTo(10) && bytes[10] === 0xff && bytes[11] === 0xff && bytes[12] === 127;
}

/**
 * The uid in the tables' one row for the caller's end of the connection
 * from `peerPort` to `serverPort`, or null when no single uid answers.
 *
 * Only a row with an inode counts: a socket no process holds any more (one
 * in TIME_WAIT, or an orphan the caller closed straight after writing its
 * request) is listed with uid 0 and inode 0, and reading that 0 as root
 * would let a closed-early request from any user through as root's.
 */
export function peerUidFromTables(
  tables: readonly string[],
  peerPort: number,
  serverPort: number,
): number | null {
  const uids = new Set<number>();
  for (const table of tables) {
    for (const line of table.split('\n')) {
      const f = line.trim().split(/\s+/);
      const local = f[1]?.split(':');
      const remote = f[2]?.split(':');
      const uid = Number(f[7]);
      const inode = f[9];
      if (local?.length !== 2 || remote?.length !== 2 || !Number.isInteger(uid)) continue;
      if (inode === undefined || !/^\d+$/.test(inode) || /^0+$/.test(inode)) continue;
      const [localAddr = '', localPort = ''] = local;
      const [remoteAddr = '', remotePort = ''] = remote;
      if (Number.parseInt(localPort, 16) !== peerPort) continue;
      if (Number.parseInt(remotePort, 16) !== serverPort) continue;
      if (!hexIsLoopback(localAddr) || !hexIsLoopback(remoteAddr)) continue;
      uids.add(uid);
    }
  }
  return uids.size === 1 ? ([...uids][0] ?? null) : null;
}

/** The reader for this machine: the kernel's own tables. */
export const procPeerUid: PeerUidReader = (peer, serverPort) => {
  const tables: string[] = [];
  for (const path of NET_TABLES) {
    try {
      tables.push(readFileSync(path, 'utf8'));
    } catch {
      // An IPv4-only or IPv6-only kernel has one table.
    }
  }
  return peerUidFromTables(tables, peer.port, serverPort);
};

/**
 * A comma-separated uid list from `name`. Anything else is an error, so a
 * typo stops the boot rather than opening the door.
 */
export function parseUidList(name: string, raw: string | undefined): number[] {
  const text = (raw ?? '').trim();
  if (text === '') return [];
  return text.split(',').map((part) => {
    const s = part.trim();
    if (!/^\d{1,10}$/.test(s)) throw new Error(`${name}: ${JSON.stringify(s)} is not a uid`);
    return Number(s);
  });
}

export interface LoopbackUids {
  /** Uids whose loopback requests go on as the operator's. Empty: the door is off. */
  allowed: readonly number[];
  /** Uids admitted only for a request carrying `cf-ray` (the tunnel's). */
  edge?: readonly number[];
}

/**
 * The door: null when the request may go on, the reason when it may not.
 * With no allowed uids it lets everything through and reads nothing.
 */
export function loopbackUidDoor(
  uids: LoopbackUids,
  readUid: PeerUidReader = procPeerUid,
): (peer: TcpPeer | null | undefined, serverPort: number, viaEdge: boolean) => string | null {
  const allowed = new Set(uids.allowed);
  const edge = new Set(uids.edge ?? []);
  return (peer, serverPort, viaEdge) => {
    if (allowed.size === 0 || !peer || !isLoopbackAddress(peer.address)) return null;
    const uid = readUid(peer, serverPort);
    if (uid === null) return 'loopback_caller_unknown';
    if (allowed.has(uid)) return null;
    if (edge.has(uid) && viaEdge) return null;
    return 'loopback_caller_refused';
  };
}
