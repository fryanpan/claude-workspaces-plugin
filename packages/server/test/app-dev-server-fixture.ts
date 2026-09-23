/**
 * A stand-in for a site's dev server, bound to a loopback port, for the
 * attached-app tests. It serves a page, a stylesheet, a redirect, a header
 * echo and a reload event stream, and it can be told to announce a reload
 * to every open stream, the way a static site's watcher does on a file
 * change. Fixtures are fictional: the Harborlight events calendar.
 */

export interface DevServerFixture {
  origin: string;
  port: number;
  /** The page body `/` answers; a test changes it to model a file edit. */
  setPage(html: string): void;
  /** Send one `reload` event down every open `/__reload` stream. */
  reload(): void;
  /** How many `/__reload` streams are open right now. */
  openStreams(): number;
  stop(): Promise<void>;
}

export const DEFAULT_PAGE =
  '<!doctype html><html><head><title>Harborlight events</title>' +
  '<link rel="stylesheet" href="site.css"></head>' +
  '<body><h1 id="title">Harborlight events</h1></body></html>';

export function startDevServer(): DevServerFixture {
  let page = DEFAULT_PAGE;
  const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const enc = new TextEncoder();
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    // An event stream stays open for as long as the reader does.
    idleTimeout: 0,
    fetch(req) {
      const url = new URL(req.url);
      switch (url.pathname) {
        case '/':
          return new Response(page, {
            headers: {
              'content-type': 'text/html; charset=utf-8',
              'set-cookie': 'dev_session=1; Path=/',
              'x-frame-options': 'DENY',
              'content-security-policy': "default-src 'self'",
            },
          });
        case '/site.css':
          return new Response('h1{color:#036}', {
            headers: {
              'content-type': 'text/css',
              connection: 'x-dev-hop',
              'x-dev-hop': 'drop me',
              'x-dev-kept': 'keep me',
            },
          });
        case '/about':
          return new Response(null, { status: 301, headers: { location: '/about/' } });
        case '/partial':
          return new Response('<li>Riverbend walk</li>', {
            headers: { 'content-type': 'text/html' },
          });
        case '/echo':
          return Response.json({
            headers: Object.fromEntries(req.headers),
            search: url.search,
            method: req.method,
          });
        case '/__reload': {
          let mine: ReadableStreamDefaultController<Uint8Array> | undefined;
          const body = new ReadableStream<Uint8Array>({
            start(c) {
              mine = c;
              streams.add(c);
              c.enqueue(enc.encode(': open\n\n'));
            },
            cancel() {
              if (mine) streams.delete(mine);
            },
          });
          return new Response(body, {
            headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
          });
        }
        default:
          return new Response('not found', { status: 404 });
      }
    },
  });
  const port = server.port ?? 0;
  return {
    origin: `http://127.0.0.1:${port}`,
    port,
    setPage(html) {
      page = html;
    },
    reload() {
      for (const c of streams) {
        try {
          c.enqueue(enc.encode('event: reload\ndata: 1\n\n'));
        } catch {
          streams.delete(c);
        }
      }
    },
    openStreams: () => streams.size,
    async stop() {
      for (const c of streams) {
        try {
          c.close();
        } catch {
          // already closed by the reader
        }
      }
      await server.stop(true);
    },
  };
}
