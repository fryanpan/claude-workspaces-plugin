/**
 * What a reader's browser does to an app's socket, for the attached-app socket
 * tests: open one and keep everything it hears, or send the handshake by hand
 * and read the status a refused one is answered with. A `WebSocket` reports
 * only that a handshake failed, and a refusal is what those tests are about.
 */
import { connect } from 'node:net';
import { waitFor } from './wait-for.ts';

export interface OpenedSocket {
  ws: WebSocket;
  heard: Array<string | number[]>;
  /** `<code> <reason>`, once it has closed. */
  closed: () => string | null;
}

/** Open a socket and wait for it. Rejects when the handshake is refused. */
export async function openSocket(
  url: string,
  protocols: string[],
  headers: Record<string, string> = {},
): Promise<OpenedSocket> {
  const ws = new WebSocket(url, { protocols, headers } as unknown as string[]);
  ws.binaryType = 'arraybuffer';
  const heard: Array<string | number[]> = [];
  let closed: string | null = null;
  ws.onmessage = (ev) => {
    heard.push(typeof ev.data === 'string' ? ev.data : [...new Uint8Array(ev.data)]);
  };
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onclose = (ev) => {
      closed = `${ev.code} ${ev.reason}`;
      reject(new Error(`handshake failed: ${closed}`));
    };
  });
  ws.onclose = (ev) => {
    closed = `${ev.code} ${ev.reason}`;
  };
  return { ws, heard, closed: () => closed };
}

/** A socket's next frame, past the `seen` it had already. */
export function nextFrame(s: OpenedSocket, seen = 0): Promise<string | number[]> {
  return waitFor(() => s.heard[seen], { describe: `frame ${seen} on the socket` });
}

/** The HTTP status a handshake is answered with. */
export function handshakeStatus(
  port: number,
  path: string,
  headers: Record<string, string> = {},
): Promise<number> {
  const lines = [
    `GET ${path} HTTP/1.1`,
    `Host: ${headers.host ?? `127.0.0.1:${port}`}`,
    'Connection: Upgrade',
    'Upgrade: websocket',
    'Sec-WebSocket-Version: 13',
    'Sec-WebSocket-Key: aGFyYm9ybGlnaHQtc29ja2V0',
    ...Object.entries(headers)
      .filter(([k]) => k !== 'host')
      .map(([k, v]) => `${k}: ${v}`),
  ];
  return new Promise((resolve, reject) => {
    const sock = connect(port, '127.0.0.1', () => sock.write(`${lines.join('\r\n')}\r\n\r\n`));
    sock.once('data', (chunk) => {
      sock.destroy();
      resolve(Number(chunk.toString('latin1').split(' ')[1]));
    });
    sock.once('error', reject);
  });
}
