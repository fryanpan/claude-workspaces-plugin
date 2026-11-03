/**
 * `middleware/loopback-uid-door.ts`: loopback TCP is admitted only from the
 * uids a project machine names (root and the server's own), the tunnel's uid
 * only for a request the edge stamped with `cf-ray`, and every other uid (the
 * lead, the backup upload, a builder) is answered 403 before any check that
 * trusts a loopback peer, while the lead's board's shared socket still
 * serves it.
 *
 * A. The table parser finds the caller's row, on IPv4 and IPv6, and answers
 *    null when no single uid does.
 * B. A server admitting root and `cw`: their no-token owner calls are served
 *    (the control); the lead's, cwbackup's and an unlisted builder's are
 *    refused; the tunnel's is refused without `cf-ray`; an unknown caller is
 *    refused; and the shared board socket is mode 660 in a 710 folder.
 * C. On Linux, the real `/proc/net/tcp` reader refuses this process's own
 *    uid when it is not listed, and serves it when it is (the control).
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { chownSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boardSocketPath } from '../src/board-sockets.ts';
import {
  loopbackUidDoor,
  parseUidList,
  peerUidFromTables,
} from '../src/middleware/loopback-uid-door.ts';
import { resolveServerConfig } from '../src/server-config.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { seedBoardOnHandle } from './workspace-seed.ts';

const CW = 10001;
const TUNNEL = 10002;
const BACKUP = 10003;
const LEAD = 10004;
const BUILDER = 10020;
const MACHINE = { allowed: [0, CW], edge: [TUNNEL] };
// A group this user may give its files to, other than its own where one
// exists, so giving the socket to it is a change the test can see.
const GROUP = (() => {
  const probe = join(mkdtempSync(join(tmpdir(), 'ud-gid-')), 'f');
  writeFileSync(probe, '');
  const own = process.getgid?.() ?? 0;
  for (const g of process.getgroups?.() ?? []) {
    if (g === own) continue;
    try {
      chownSync(probe, -1, g);
      return g;
    } catch {
      // Not one this user may give a file to.
    }
  }
  return own;
})();
const HEADER =
  '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode';
// 127.0.0.1:41000 -> 127.0.0.1:8787 owned by the lead; the server's own end
// (127.0.0.1:8787 -> 127.0.0.1:41000) owned by uid 10001; a listener.
const TCP4 = [
  HEADER,
  '   0: 0100007F:2253 00000000:0000 0A 00000000:00000000 00:00000000 00000000 10001        0 1 1 0',
  '   1: 0100007F:A028 0100007F:2253 01 00000000:00000000 00:00000000 00000000 10004        0 2 1 0',
  '   2: 0100007F:2253 0100007F:A028 01 00000000:00000000 00:00000000 00000000 10001        0 3 1 0',
].join('\n');
// [::1]:41001 -> [::1]:8787, and ::ffff:127.0.0.1:41002 -> the same, by uid 10003.
const TCP6 = [
  HEADER,
  '   0: 00000000000000000000000001000000:A029 00000000000000000000000001000000:2253 01 00000000:00000000 00:00000000 00000000 10004 0 4 1 0',
  '   1: 0000000000000000FFFF00000100007F:A02A 0000000000000000FFFF00000100007F:2253 01 00000000:00000000 00:00000000 00000000 10003 0 5 1 0',
].join('\n');

describe('A. finding the caller in the kernel tables', () => {
  it('names the uid that owns the caller’s end, not the server’s', () => {
    expect(peerUidFromTables([TCP4, TCP6], 41000, 8787)).toBe(LEAD);
    expect(peerUidFromTables([TCP4, TCP6], 41001, 8787)).toBe(LEAD);
    expect(peerUidFromTables([TCP4, TCP6], 41002, 8787)).toBe(10003);
  });

  it('answers null for no row, a row to another port, a non-loopback row, or two uids', () => {
    expect(peerUidFromTables([TCP4], 41999, 8787)).toBeNull();
    expect(peerUidFromTables([TCP4], 41000, 8788)).toBeNull();
    const remote = TCP4.replace('0100007F:A028 0100007F:2253', '0A00000A:A028 0100007F:2253');
    expect(peerUidFromTables([remote], 41000, 8787)).toBeNull();
    const twice = `${TCP4}\n   3: 0100007F:A028 0100007F:2253 01 00000000:00000000 00:00000000 00000000 10001 0 6 1 0`;
    expect(peerUidFromTables([twice], 41000, 8787)).toBeNull();
  });

  it('reads no uid from a socket no process holds, which the kernel lists as uid 0', () => {
    // The lead wrote its request and closed: its end is TIME_WAIT (or an
    // orphan), printed with uid 0 and inode 0. Root's 0 must not answer.
    const closed = [
      HEADER,
      '   0: 0100007F:A028 0100007F:2253 06 00000000:00000000 03:00001770 00000000     0        0 0 3 0',
      '   1: 0100007F:A02B 0100007F:2253 05 00000000:00000000 00:00000000 00000000     0        0 0 2 0',
    ].join('\n');
    expect(peerUidFromTables([closed], 41000, 8787)).toBeNull();
    expect(peerUidFromTables([closed], 41003, 8787)).toBeNull();
    // A leftover TIME_WAIT row beside a live connection on the same ports
    // is ignored, so the live one still answers.
    expect(peerUidFromTables([TCP4, closed], 41000, 8787)).toBe(LEAD);
    expect(peerUidFromTables([], 41000, 8787)).toBeNull();
  });

  it('reads only digits as uids', () => {
    expect(parseUidList('X', ' 0, 10001 ')).toEqual([0, CW]);
    expect(parseUidList('X', undefined)).toEqual([]);
    expect(() => parseUidList('X', 'cw')).toThrow('X: "cw" is not a uid');
    expect(() => parseUidList('X', '0,-1')).toThrow('not a uid');
  });

  it('judges only loopback TCP, and nothing when no uid is allowed', () => {
    let reads = 0;
    const door = loopbackUidDoor(MACHINE, () => {
      reads++;
      return LEAD;
    });
    expect(door(null, 8787, false)).toBeNull();
    expect(door({ address: '192.0.2.7', port: 41000 }, 8787, false)).toBeNull();
    expect(reads).toBe(0);
    expect(door({ address: '127.0.0.1', port: 41000 }, 8787, false)).toBe(
      'loopback_caller_refused',
    );
    const off = loopbackUidDoor({ allowed: [] }, () => LEAD);
    expect(off({ address: '127.0.0.1', port: 1 }, 8787, false)).toBeNull();
  });

  it('admits only the listed uids, and the tunnel’s only through the edge', () => {
    const at = (uid: number | null, viaEdge = false) =>
      loopbackUidDoor(MACHINE, () => uid)({ address: '127.0.0.1', port: 41000 }, 8787, viaEdge);
    expect(at(0)).toBeNull();
    expect(at(CW)).toBeNull();
    expect(at(TUNNEL, true)).toBeNull();
    expect(at(TUNNEL)).toBe('loopback_caller_refused');
    // cf-ray is the edge's stamp for the tunnel's uid only; on anyone else's
    // request it admits nothing.
    for (const uid of [BACKUP, LEAD, BUILDER]) {
      expect(at(uid)).toBe('loopback_caller_refused');
      expect(at(uid, true)).toBe('loopback_caller_refused');
    }
    expect(at(null, true)).toBe('loopback_caller_unknown');
  });
});

describe('B. a server that admits only root, itself and the tunnel', () => {
  let h: ServerHandle;
  let dataDir: string;
  let socketDir: string;
  let ws: string;
  let other: string;
  let caller: number | null = CW;
  const seen: number[] = [];

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'uid-door-'));
    socketDir = join(mkdtempSync(join(tmpdir(), 'ud-')), 'boards');
    h = createServer({
      port: 0,
      dataDir,
      loopbackAllowedUids: MACHINE.allowed,
      loopbackEdgeUids: MACHINE.edge,
      peerUid: (peer, serverPort) => {
        seen.push(peer.port, serverPort);
        return caller;
      },
      boardSocketDir: socketDir,
    });
    ws = seedBoardOnHandle(h);
    const res = await fetch(`http://127.0.0.1:${h.port}/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Riverbend' }),
    });
    other = ((await res.json()) as { workspace: { id: string } }).workspace.id;
    await h.stop();
    // The same data, now with the first board's socket shared.
    h = createServer({
      port: 0,
      dataDir,
      loopbackAllowedUids: MACHINE.allowed,
      loopbackEdgeUids: MACHINE.edge,
      peerUid: (peer, serverPort) => {
        seen.push(peer.port, serverPort);
        return caller;
      },
      boardSocketDir: socketDir,
      boardSocketShared: ws,
      boardSocketGroup: GROUP,
    });
  });

  afterAll(async () => {
    await h.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const ownerRead = () => fetch(`http://127.0.0.1:${h.port}/workspaces/${ws}?format=json`);
  const ownerWrite = () =>
    fetch(`http://127.0.0.1:${h.port}/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Saltmarsh' }),
    });

  it('serves root’s and the server’s own no-token owner call (the control)', async () => {
    for (const uid of [0, CW]) {
      caller = uid;
      expect((await ownerRead()).status).toBe(200);
      expect(seen.at(-1)).toBe(h.port);
    }
  });

  it('refuses the lead’s, the backup upload’s and an unlisted builder’s owner read and write', async () => {
    for (const uid of [LEAD, BACKUP, BUILDER]) {
      caller = uid;
      const read = await ownerRead();
      expect(read.status, `uid ${uid}`).toBe(403);
      expect(((await read.json()) as { error: string }).error).toBe('loopback_caller_refused');
      expect((await ownerWrite()).status, `uid ${uid}`).toBe(403);
    }
  });

  it('refuses the tunnel’s request without cf-ray, and leaves one with it to the edge’s gates', async () => {
    caller = TUNNEL;
    const bare = await ownerRead();
    expect(bare.status).toBe(403);
    expect(((await bare.json()) as { error: string }).error).toBe('loopback_caller_refused');
    // With cf-ray the door lets it on, and the host guard, which never
    // classifies an edge request local, is what answers.
    const edge = await fetch(`http://127.0.0.1:${h.port}/workspaces/${ws}?format=json`, {
      headers: { 'cf-ray': '8f00000000000000-SJC' },
    });
    expect(((await edge.json()) as { error?: string }).error ?? '').not.toMatch(/^loopback_caller/);
    expect(edge.status).not.toBe(200);
  });

  it('refuses a caller whose uid cannot be found', async () => {
    caller = null;
    const res = await ownerRead();
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('loopback_caller_unknown');
  });

  it('still serves the lead its own board through the shared socket', async () => {
    caller = LEAD;
    const res = await fetch(`http://board/workspaces/${ws}/tasks`, {
      unix: boardSocketPath(socketDir, ws),
    } as RequestInit);
    expect(res.status, await res.clone().text()).toBe(200);
  });

  it('gives that one socket to its group, mode 660, and nothing to any other user', () => {
    const shared = statSync(boardSocketPath(socketDir, ws));
    expect(shared.mode & 0o777).toBe(0o660);
    expect(shared.gid).toBe(GROUP);
    expect(statSync(boardSocketPath(socketDir, other)).mode & 0o777).toBe(0o600);
    const folder = statSync(socketDir);
    expect(folder.mode & 0o777).toBe(0o710);
    expect(folder.gid).toBe(GROUP);
  });

  it('is read from CW_LOOPBACK_ALLOWED_UIDS, CW_LOOPBACK_EDGE_UIDS and CW_BOARD_SOCKET_SHARED', () => {
    const config = (env: Record<string, string>) =>
      resolveServerConfig({
        env: { CW_DATA_DIR: '/nonexistent-data', ...env },
        repoRoot: '/nonexistent-repo',
        arg: (_name: string, fallback?: string) => fallback,
      });
    const cfg = config({
      CW_LOOPBACK_ALLOWED_UIDS: '0,10001',
      CW_LOOPBACK_EDGE_UIDS: '10002',
      CW_BOARD_SOCKET_SHARED: 'w-riverbend',
      CW_BOARD_SOCKET_GROUP: '10010',
    });
    expect(cfg.loopbackAllowedUids).toEqual([0, CW]);
    expect(cfg.loopbackEdgeUids).toEqual([TUNNEL]);
    expect(cfg.boardSocketShared).toBe('w-riverbend');
    expect(cfg.boardSocketGroup).toBe(10010);
    // The retired denylist would leave the door off, so it stops the boot.
    expect(() => config({ CW_LOOPBACK_REFUSED_UIDS: '10004' })).toThrow('retired');
    // A box with other users and no allowlist does not boot with the door off.
    expect(() => config({ CW_BOARD_SOCKET_GROUP: '10010' })).toThrow('CW_LOOPBACK_ALLOWED_UIDS');
  });
});

describe.skipIf(process.platform !== 'linux')('C. the kernel’s own tables (Linux)', () => {
  const uid = process.getuid?.() ?? -1;
  const boot = (allowed: number[]) => {
    const dataDir = mkdtempSync(join(tmpdir(), 'uid-door-proc-'));
    const h = createServer({ port: 0, dataDir, loopbackAllowedUids: allowed });
    return { h, dataDir, ws: seedBoardOnHandle(h) };
  };

  it('refuses this process’s own uid over loopback when unlisted, and serves it when listed', async () => {
    const refused = boot([uid + 1]);
    const open = boot([uid]);
    try {
      const no = await fetch(
        `http://127.0.0.1:${refused.h.port}/workspaces/${refused.ws}?format=json`,
      );
      expect(no.status).toBe(403);
      expect(((await no.json()) as { error: string }).error).toBe('loopback_caller_refused');
      const yes = await fetch(`http://127.0.0.1:${open.h.port}/workspaces/${open.ws}?format=json`);
      expect(yes.status).toBe(200);
    } finally {
      for (const s of [refused, open]) {
        await s.h.stop();
        rmSync(s.dataDir, { recursive: true, force: true });
      }
    }
  });
});
