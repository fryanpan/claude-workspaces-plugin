/**
 * Start the keeper's listener on loopback: the request book, the HTTP
 * surface, and `Bun.serve` around them. Split from `keeper-bin.ts` so a test
 * can start the same keeper in-process with stand-in executors.
 */
import { createKeeperHttp } from './keeper-http.ts';
import { type Executors, type KeeperRequests, createKeeperRequests } from './keeper-requests.ts';
import type { KeeperStore } from './keeper-store.ts';

export const DEFAULT_KEEPER_PORT = 8797;

export interface RunningKeeper {
  port: number;
  /** `http://localhost:<port>`: the page origin, and the passkeys' relying party. */
  origin: string;
  requests: KeeperRequests;
  stop(): Promise<void>;
}

export function serveKeeper(opts: {
  store: KeeperStore;
  exec: Executors;
  port: number;
  now?: () => number;
  log?: (line: string) => void;
}): RunningKeeper {
  let handle: ((req: Request, peer: string | null) => Promise<Response>) | null = null;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: opts.port,
    // A held request's poll is short; nothing here streams.
    idleTimeout: 30,
    fetch(req, srv) {
      if (!handle) return new Response('starting', { status: 503 });
      return handle(req, srv.requestIP(req)?.address ?? null);
    },
  });
  const port = server.port as number;
  const origin = `http://localhost:${port}`;
  const requests = createKeeperRequests({
    store: opts.store,
    exec: opts.exec,
    ceremony: { origin, rpId: 'localhost' },
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.log ? { log: opts.log } : {}),
  });
  handle = createKeeperHttp({
    requests,
    store: opts.store,
    port,
    ...(opts.now ? { now: opts.now } : {}),
  });
  return { port, origin, requests, stop: () => server.stop(true) };
}
