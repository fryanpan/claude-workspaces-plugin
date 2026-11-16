/**
 * The reconnect end of a restart's gap: the first doc or board page socket
 * that opens on a freshly booted server is written into that start's record,
 * once, and later sockets do not move it.
 *
 * Wired the way `bin.ts` wires it — `onFirstClientSocket` straight into
 * `markFirstClientSocket` — over a real `/y` socket. Scratch data dir.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  markFirstClientSocket,
  readServerStarts,
  recordServerStart,
  serverStartsPath,
} from '../src/server-starts.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { type RoomPage, joinRoom } from './room-page.ts';
import { waitFor } from './wait-for.ts';
import { seedBoard } from './workspace-seed.ts';

describe('the first client socket after boot', () => {
  let handle: ServerHandle | null = null;
  let dataDir = '';
  const pages: RoomPage[] = [];

  afterEach(async () => {
    for (const p of pages.splice(0)) p.close();
    await handle?.stop();
    handle = null;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('is recorded on this start, once', async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'cw-first-socket-'));
    const file = serverStartsPath(dataDir);
    const start = recordServerStart(file, { startedAt: Date.now(), pid: process.pid }, []);
    const seen: number[] = [];
    handle = createServer({
      port: 0,
      dataDir,
      requireSignInToWrite: false,
      onFirstClientSocket: (at) => {
        seen.push(at);
        markFirstClientSocket(file, start, at);
      },
    });
    const base = `http://127.0.0.1:${handle.port}`;
    const ws = await seedBoard(base);
    // Nothing has opened a socket yet: booting and REST calls are not a reconnect.
    expect(readServerStarts(file)[0]?.firstClientSocketAt).toBeUndefined();

    const room = `ws://127.0.0.1:${handle.port}/workspaces/${ws}/y?type=workspace`;
    const first = joinRoom(room, base);
    pages.push(first);
    await first.ready;
    const at = await waitFor(() => readServerStarts(file)[0]?.firstClientSocketAt, {
      describe: 'the first socket written into the start record',
    });
    expect(seen).toEqual([at]);

    const second = joinRoom(room, base);
    pages.push(second);
    await second.ready;
    expect(seen).toHaveLength(1);
    expect(readServerStarts(file)[0]?.firstClientSocketAt).toBe(at);
  });
});
