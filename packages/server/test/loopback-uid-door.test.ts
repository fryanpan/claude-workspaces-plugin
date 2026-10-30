/**
 * `middleware/loopback-uid-door.ts`: loopback TCP from a refused uid (a
 * project machine's lead) is answered 403 before any check that trusts a
 * loopback peer, while that board's shared socket still serves it.
 *
 * A. The table parser finds the caller's row, on IPv4 and IPv6, and answers
 *    null when no single uid does.
 * B. A server with the lead's uid refused: the lead's no-token owner call is
 *    refused, another uid's is served (the control), an unknown caller is
 *    refused, and the shared board socket is mode 666 in a 710 folder.
 * C. On Linux, the real `/proc/net/tcp` reader refuses this process's own
 *    uid, and the same server with nobody refused serves it (the control).
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boardSocketPath } from '../src/board-sockets.ts';
import {
  loopbackUidDoor,
  parseRefusedUids,
  peerUidFromTables,
} from '../src/middleware/loopback-uid-door.ts';
import { resolveServerConfig } from '../src/server-config.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { seedBoardOnHandle } from './workspace-seed.ts';

const LEAD = 10004;
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
    const twice = `${TCP4}\n   3: 0100007F:A028 0100007F:2253 06 00000000:00000000 00:00000000 00000000 10001 0 6 1 0`;
    expect(peerUidFromTables([twice], 41000, 8787)).toBeNull();
    expect(peerUidFromTables([], 41000, 8787)).toBeNull();
  });

  it('reads only digits as uids', () => {
    expect(parseRefusedUids(' 10004, 10005 ')).toEqual([10004, 10005]);
    expect(parseRefusedUids(undefined)).toEqual([]);
    expect(() => parseRefusedUids('lead')).toThrow('not a uid');
    expect(() => parseRefusedUids('10004,-1')).toThrow('not a uid');
  });

  it('judges only loopback TCP, and nothing when no uid is refused', () => {
    let reads = 0;
    const door = loopbackUidDoor([LEAD], () => {
      reads++;
      return LEAD;
    });
    expect(door(null, 8787)).toBeNull();
    expect(door({ address: '192.0.2.7', port: 41000 }, 8787)).toBeNull();
    expect(reads).toBe(0);
    expect(door({ address: '127.0.0.1', port: 41000 }, 8787)).toBe('loopback_caller_refused');
    expect(loopbackUidDoor([], () => LEAD)({ address: '127.0.0.1', port: 1 }, 8787)).toBeNull();
  });
});

describe('B. a server that refuses the lead’s uid', () => {
  let h: ServerHandle;
  let dataDir: string;
  let socketDir: string;
  let ws: string;
  let other: string;
  let caller: number | null = 10001;
  const seen: number[] = [];

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'uid-door-'));
    socketDir = join(mkdtempSync(join(tmpdir(), 'ud-')), 'boards');
    h = createServer({
      port: 0,
      dataDir,
      loopbackRefusedUids: [LEAD],
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
      loopbackRefusedUids: [LEAD],
      peerUid: (peer, serverPort) => {
        seen.push(peer.port, serverPort);
        return caller;
      },
      boardSocketDir: socketDir,
      boardSocketShared: ws,
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

  it('serves another uid’s no-token owner call (the control)', async () => {
    caller = 10001;
    expect((await ownerRead()).status).toBe(200);
    expect(seen.at(-1)).toBe(h.port);
  });

  it('refuses the lead’s no-token owner read and write', async () => {
    caller = LEAD;
    const read = await ownerRead();
    expect(read.status).toBe(403);
    expect(((await read.json()) as { error: string }).error).toBe('loopback_caller_refused');
    expect((await ownerWrite()).status).toBe(403);
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

  it('shares that one socket, and the folder only to its group', () => {
    expect(statSync(boardSocketPath(socketDir, ws)).mode & 0o777).toBe(0o666);
    expect(statSync(boardSocketPath(socketDir, other)).mode & 0o777).toBe(0o600);
    expect(statSync(socketDir).mode & 0o777).toBe(0o710);
  });

  it('is read from CW_LOOPBACK_REFUSED_UIDS and CW_BOARD_SOCKET_SHARED', () => {
    const cfg = resolveServerConfig({
      env: {
        CW_DATA_DIR: '/nonexistent-data',
        CW_LOOPBACK_REFUSED_UIDS: '10004',
        CW_BOARD_SOCKET_SHARED: 'w-riverbend',
      },
      repoRoot: '/nonexistent-repo',
      arg: (_name: string, fallback?: string) => fallback,
    });
    expect(cfg.loopbackRefusedUids).toEqual([LEAD]);
    expect(cfg.boardSocketShared).toBe('w-riverbend');
  });
});

describe.skipIf(process.platform !== 'linux')('C. the kernel’s own tables (Linux)', () => {
  const uid = process.getuid?.() ?? -1;
  const boot = (refused: number[]) => {
    const dataDir = mkdtempSync(join(tmpdir(), 'uid-door-proc-'));
    const h = createServer({ port: 0, dataDir, loopbackRefusedUids: refused });
    return { h, dataDir, ws: seedBoardOnHandle(h) };
  };

  it('refuses this process’s own uid over loopback, and serves it when nobody is refused', async () => {
    const refused = boot([uid]);
    const open = boot([]);
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
