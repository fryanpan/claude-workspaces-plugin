/**
 * A websocket upgrade through the real Hono router writes one status line.
 *
 * Since M12 the upgrade-and-stream run is a middleware on the router app
 * (`routes/hono-app.ts`): it upgrades, returns an empty `Response`, and the
 * front door hands Bun `undefined`. `hono-upgrade-probe.test.ts` proves on a
 * bare Hono app that Bun writes nothing after the 101 for any return; this
 * file proves the server's own router reaches the upgrade at all, with the
 * gates in front of it, on the board's socket. With the upgrade run taken out
 * of the router both cases fail.
 *
 * The client reads raw bytes. After the handshake it sends a websocket ping
 * and waits for the pong, a round trip that starts after the handler
 * returned, so anything Bun wrote for that return is already in the bytes.
 * The positive control is a refused upgrade on the same reader, whose single
 * 403 it must see.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';

const PING = 'rt-check';
/** A client ping control frame: masked with a zero key, as a client's must be. */
const pingFrame = Buffer.concat([
  Buffer.from([0x89, 0x80 | PING.length, 0, 0, 0, 0]),
  Buffer.from(PING),
]);
/** The server's pong for it: unmasked, same payload. */
const PONG = `\x8a${String.fromCharCode(PING.length)}${PING}`;

let handle: ServerHandle;
let dataDir = '';
let workspaceId = '';

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'cw-router-upgrade-'));
  handle = createServer({ port: 0, dataDir });
  const res = await fetch(`http://127.0.0.1:${handle.port}/workspaces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', host: `localhost:${handle.port}` },
    body: JSON.stringify({
      name: 'Riverbend',
      author: { id: 'agent-riverbend', name: 'Riverbend', kind: 'agent' },
    }),
  });
  expect(res.status).toBeLessThan(300);
  workspaceId = ((await res.json()) as { workspace: { id: string } }).workspace.id;
});

afterAll(async () => {
  await handle.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

/**
 * Everything the server sends on one raw connection, up to `end`. An
 * upgrade ends at the pong; a refusal ends at its body.
 */
function rawExchange(request: string, upgrade: boolean, end = PONG): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let pinged = false;
    const text = () => Buffer.concat(chunks).toString('latin1');
    Bun.connect({
      hostname: '127.0.0.1',
      port: handle.port,
      socket: {
        open(socket) {
          socket.write(request);
        },
        data(socket, data) {
          chunks.push(Buffer.from(data));
          if (upgrade && !pinged && text().includes('\r\n\r\n')) {
            pinged = true;
            socket.write(pingFrame);
          }
          if (text().includes(end)) {
            resolve(text());
            socket.end();
          }
        },
        close() {
          resolve(text());
        },
        error(_socket, err) {
          reject(err);
        },
      },
    }).catch(reject);
  });
}

const handshake = (path: string, extra = '') =>
  `GET ${path} HTTP/1.1\r\nHost: localhost:${handle.port}\r\nUpgrade: websocket\r\n` +
  'Connection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
  `Sec-WebSocket-Version: 13\r\n${extra}\r\n`;

const statusLines = (bytes: string) => bytes.match(/HTTP\/1\.1 \d{3}/g) ?? [];

describe('a websocket upgrade through the Hono router', () => {
  it('reads a refused upgrade as one 403 (positive control)', async () => {
    const bytes = await rawExchange(
      handshake(`/workspaces/${workspaceId}/y`, 'Origin: https://elsewhere.invalid\r\n'),
      false,
      'origin_not_allowed',
    );
    expect(statusLines(bytes)).toEqual(['HTTP/1.1 403']);
  });

  it('writes exactly one 101 and nothing after it on the board socket', async () => {
    const bytes = await rawExchange(handshake(`/workspaces/${workspaceId}/y`), true);
    expect(statusLines(bytes)).toEqual(['HTTP/1.1 101']);
    expect(bytes).toContain(PONG);
  });
});
