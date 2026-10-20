/**
 * A TCP relay that gives a local server a phone's network: a fixed bandwidth
 * each way and a fixed round trip.
 *
 * Chrome's own network emulation is not used, because it was measured wrong:
 * at a nominal 50 Mbps it delivered a 254 KB websocket frame in 1,328 ms, a
 * rate thirty times too low, and the error grew with the payload so every
 * number it produced looked consistent. A relay paces the real bytes on the
 * real socket, and `measureRate` below is the control that says the pace it
 * set is the pace a browser got.
 *
 * Each direction is a queue. A chunk leaves when the link has finished
 * sending everything before it (its size at `bitsPerSecond`, credited per
 * elapsed millisecond rather than per timer tick) and arrives half a round
 * trip later. Order is kept because both terms only ever move forward.
 */
import { type Server, type Socket, connect, createServer } from 'node:net';

export interface LinkShape {
  downBitsPerSecond: number;
  upBitsPerSecond: number;
  roundTripMs: number;
}

/** A 5G link on a phone, as the board task names it: ~9 Mbps down, 150 ms. */
export const PHONE_5G: LinkShape = {
  downBitsPerSecond: 9_000_000,
  upBitsPerSecond: 4_500_000,
  roundTripMs: 150,
};

/** Big writes are cut so the pace is smooth rather than one long stall. */
const SLICE = 16 * 1024;

/** One direction of the link: `send` returns once the bytes are scheduled. */
function pacedPipe(to: Socket, bitsPerSecond: number, oneWayMs: number) {
  let linkFreeAt = 0;
  let lastArrival = 0;
  let ended = false;
  const send = (chunk: Buffer): void => {
    for (let at = 0; at < chunk.length; at += SLICE) {
      const piece = chunk.subarray(at, at + SLICE);
      const start = Math.max(performance.now(), linkFreeAt);
      linkFreeAt = start + (piece.length * 8 * 1000) / bitsPerSecond;
      lastArrival = linkFreeAt + oneWayMs;
      setTimeout(
        () => {
          if (!to.destroyed) to.write(piece);
        },
        Math.max(0, lastArrival - performance.now()),
      );
    }
  };
  const end = (): void => {
    if (ended) return;
    ended = true;
    setTimeout(() => to.end(), Math.max(0, lastArrival - performance.now()) + 1);
  };
  return { send, end };
}

export interface Relay {
  port: number;
  close: () => Promise<void>;
}

/** Listen on a free loopback port and relay every connection to `target`. */
export async function startRelay(targetPort: number, shape: LinkShape): Promise<Relay> {
  const oneWay = shape.roundTripMs / 2;
  const sockets = new Set<Socket>();
  const server: Server = createServer((client) => {
    const upstream = connect(targetPort, '127.0.0.1');
    sockets.add(client);
    sockets.add(upstream);
    const down = pacedPipe(client, shape.downBitsPerSecond, oneWay);
    const up = pacedPipe(upstream, shape.upBitsPerSecond, oneWay);
    client.on('data', (b: Buffer) => up.send(b));
    upstream.on('data', (b: Buffer) => down.send(b));
    client.on('end', up.end);
    upstream.on('end', down.end);
    const drop = (): void => {
      client.destroy();
      upstream.destroy();
    };
    client.on('error', drop);
    upstream.on('error', drop);
    client.on('close', () => sockets.delete(client));
    upstream.on('close', () => sockets.delete(upstream));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('relay has no port');
  return {
    port: address.port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

/**
 * The positive control: fetch `url` through the relay with no compression
 * and answer the rate the body actually arrived at, in bits per second,
 * counted from its first byte so the round trip is not charged to it.
 */
export async function measureRate(url: string): Promise<{ bytes: number; bitsPerSecond: number }> {
  const res = await fetch(url, { headers: { 'accept-encoding': 'identity' } });
  const reader = res.body?.getReader();
  if (!reader) throw new Error(`no body from ${url}`);
  let bytes = 0;
  let first = 0;
  let firstChunk = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (first === 0) {
      first = performance.now();
      firstChunk = value.length;
    }
    bytes += value.length;
  }
  const seconds = (performance.now() - first) / 1000;
  return { bytes, bitsPerSecond: ((bytes - firstChunk) * 8) / seconds };
}
