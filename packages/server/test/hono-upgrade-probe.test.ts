/**
 * Can a Hono handler own a websocket upgrade on Bun?
 *
 * Bun's `fetch` is meant to return `undefined` after `server.upgrade()`
 * succeeds, and a Hono handler has to return a `Response`. This file reads
 * the raw bytes a client receives when a Hono handler upgrades and then
 * returns an empty `Response`, in two shapes:
 *
 * - the handler's empty `Response` goes all the way back to Bun (what
 *   `hono/bun`'s own `upgradeWebSocket` does);
 * - the adapter around the Hono app sees that the request was upgraded and
 *   hands Bun `undefined`, as `fetch` does today.
 *
 * And a third: the upgrade comes after an await, as an attached app's does.
 * In each, the connection must carry exactly one HTTP status line, the 101,
 * followed by the socket's own frames. The positive control is a plain
 * request on the same server, whose 200 the same reader must see.
 *
 * A fourth case shows why every shape is clean: once `server.upgrade()` has
 * succeeded, Bun writes nothing for whatever `fetch` returns, even a 500 with
 * a body. So the router's `undefined` for an upgraded request is the
 * documented contract kept, not the thing that prevents a second answer.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { Hono } from 'hono';

interface ProbeData {
  greeting: string;
}

/** Requests a handler upgraded, so the adapter can hand Bun `undefined`. */
const upgraded = new WeakSet<Request>();

const app = new Hono();
app.get('/ws-response', (c) => {
  if (!bunServer.upgrade(c.req.raw, { data: { greeting: 'hello-response' } })) {
    return c.text('upgrade failed', 426);
  }
  return new Response(null);
});
app.get('/ws-undefined', (c) => {
  if (!bunServer.upgrade(c.req.raw, { data: { greeting: 'hello-undefined' } })) {
    return c.text('upgrade failed', 426);
  }
  upgraded.add(c.req.raw);
  return new Response(null);
});
// An attached app's socket opens only after its dev server answers, so the
// upgrade comes after an await.
app.get('/ws-later', async (c) => {
  await new Promise<void>((resolve) => setImmediate(resolve));
  if (!bunServer.upgrade(c.req.raw, { data: { greeting: 'hello-later' } })) {
    return c.text('upgrade failed', 426);
  }
  upgraded.add(c.req.raw);
  return new Response(null);
});
// The worst return after an upgrade: a real answer with a body.
app.get('/ws-body', (c) => {
  if (!bunServer.upgrade(c.req.raw, { data: { greeting: 'hello-body' } })) {
    return c.text('upgrade failed', 426);
  }
  return c.text('second answer', 500);
});
app.get('/plain', (c) => c.text('plain-body'));

// Declared after the handlers that read it; they run only once it serves.
const bunServer = Bun.serve<ProbeData>({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(req) {
    const res = await app.fetch(req);
    return upgraded.has(req) ? undefined : res;
  },
  websocket: {
    open(ws) {
      ws.send(ws.data.greeting);
    },
    message(ws, message) {
      if (String(message) === 'ping') ws.send(`pong-${ws.data.greeting}`);
    },
  },
});
const port = bunServer.port ?? 0;

afterAll(() => {
  bunServer.stop(true);
});

/** A client text frame. Masked, as a client's must be, with a zero key. */
const clientFrame = (text: string) =>
  Buffer.concat([Buffer.from([0x81, 0x80 | text.length, 0, 0, 0, 0]), Buffer.from(text)]);

/**
 * Everything the server sends on one raw connection, until `done` says the
 * exchange is over. A plain request ends when the server closes it. A socket
 * ends at the server's reply to a `ping` the client sends once it has the
 * greeting: a round trip that starts after the handler returned, so any
 * response Bun wrote for that return is already in the bytes.
 */
function rawExchange(request: string, greeting?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let pinged = false;
    const text = () => Buffer.concat(chunks).toString('latin1');
    Bun.connect({
      hostname: '127.0.0.1',
      port,
      socket: {
        open(socket) {
          socket.write(request);
        },
        data(socket, data) {
          chunks.push(Buffer.from(data));
          if (greeting === undefined) return;
          if (!pinged && text().includes(greeting)) {
            pinged = true;
            socket.write(clientFrame('ping'));
          }
          if (text().includes(`pong-${greeting}`)) {
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

const handshake = (path: string) =>
  `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\n` +
  'Connection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
  'Sec-WebSocket-Version: 13\r\n\r\n';

const statusLines = (bytes: string) => bytes.match(/HTTP\/1\.1 \d{3}/g) ?? [];

describe('a Hono handler that upgrades on Bun', () => {
  it('sees a plain response on the same reader (positive control)', async () => {
    const bytes = await rawExchange(
      `GET /plain HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`,
    );
    expect(statusLines(bytes)).toEqual(['HTTP/1.1 200']);
    expect(bytes).toContain('plain-body');
  });

  it('writes nothing after the 101 when the empty Response reaches Bun', async () => {
    const bytes = await rawExchange(handshake('/ws-response'), 'hello-response');
    expect(statusLines(bytes)).toEqual(['HTTP/1.1 101']);
    expect(bytes).toContain('pong-hello-response');
  });

  it('writes nothing after the 101 when the adapter hands Bun undefined', async () => {
    const bytes = await rawExchange(handshake('/ws-undefined'), 'hello-undefined');
    expect(statusLines(bytes)).toEqual(['HTTP/1.1 101']);
    expect(bytes).toContain('pong-hello-undefined');
  });

  it('upgrades after an await inside the handler, with the same single 101', async () => {
    const bytes = await rawExchange(handshake('/ws-later'), 'hello-later');
    expect(statusLines(bytes)).toEqual(['HTTP/1.1 101']);
    expect(bytes).toContain('pong-hello-later');
  });

  it('writes nothing for a 500 with a body returned after the upgrade', async () => {
    const bytes = await rawExchange(handshake('/ws-body'), 'hello-body');
    expect(statusLines(bytes)).toEqual(['HTTP/1.1 101']);
    expect(bytes).not.toContain('second answer');
    expect(bytes).toContain('pong-hello-body');
  });
});
