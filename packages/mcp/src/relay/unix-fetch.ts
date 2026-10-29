/**
 * A fetch that goes over one unix socket: what the node relay dials for a
 * walled lead (`CW_BOARD_SOCKET`), whose profile refuses every board server
 * port and lets it connect to its own board's socket and no other
 * (packages/server/src/board-sockets.ts).
 *
 * Built on `node:http` because node's global fetch takes no socket path, and
 * the relay runs under node or bun. The URL's host is ignored; its path and
 * query are sent. The response body streams, so the relay's GET reads each
 * event as it arrives, and an abort ends it.
 */
import { type IncomingMessage, request } from 'node:http';

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export function unixSocketFetch(socketPath: string): Fetch {
  return (url, init = {}) =>
    new Promise<Response>((resolve, reject) => {
      const target = new URL(url);
      const headers: Record<string, string> = {};
      new Headers(init.headers).forEach((value, name) => {
        headers[name] = value;
      });
      const body = init.body == null ? undefined : String(init.body);
      if (body !== undefined) headers['content-length'] = String(Buffer.byteLength(body));
      const req = request(
        {
          socketPath,
          path: `${target.pathname}${target.search}`,
          method: init.method ?? 'GET',
          headers,
          ...(init.signal ? { signal: init.signal } : {}),
        },
        (res) => resolve(toResponse(res)),
      );
      req.on('error', reject);
      if (body !== undefined) req.write(body);
      req.end();
    });
}

function toResponse(res: IncomingMessage): Response {
  const headers = new Headers();
  for (const [name, value] of Object.entries(res.headers)) {
    if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  const status = res.statusCode ?? 502;
  if (status === 204 || status === 304) {
    res.resume();
    return new Response(null, { status, headers });
  }
  let done = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      res.on('data', (chunk: Buffer) => {
        if (!done) controller.enqueue(new Uint8Array(chunk));
      });
      res.on('end', () => {
        if (done) return;
        done = true;
        controller.close();
      });
      // An abort or a dropped socket: the reader sees an error, as with fetch.
      res.on('close', () => {
        if (done) return;
        done = true;
        controller.error(new Error('the board socket closed the response'));
      });
    },
    cancel() {
      done = true;
      res.destroy();
    },
  });
  return new Response(body, { status, headers });
}
