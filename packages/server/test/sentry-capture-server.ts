/**
 * A local stand-in for Sentry's ingest endpoint. Point a DSN at it and read
 * what actually crossed the wire, rather than trusting that a capture call
 * ran. Shared by every server test that asserts on what Sentry was sent.
 */
export type CapturedRequest = { path: string; headers: Record<string, string>; text: string };

export function startCaptureServer(): {
  dsn: string;
  hits: () => CapturedRequest[];
  stop: () => void;
} {
  const hits: CapturedRequest[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const buf = await req.arrayBuffer();
      const bytes = new Uint8Array(buf);
      // Sentry's transport may or may not gzip the envelope body depending
      // on payload size; detect the gzip magic bytes rather than trusting
      // content-encoding, so this test doesn't quietly stop reading bodies
      // if that changes.
      const isGzip = bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
      const text = new TextDecoder().decode(isGzip ? Bun.gunzipSync(bytes) : bytes);
      hits.push({
        path: new URL(req.url).pathname,
        headers: Object.fromEntries(req.headers.entries()),
        text,
      });
      return new Response('{}', { status: 200 });
    },
  });
  return {
    dsn: `http://examplekey@127.0.0.1:${server.port}/1`,
    hits: () => hits,
    stop: () => server.stop(true),
  };
}
