/**
 * Start the keeper's listeners on both loopback addresses: the request book, the HTTP
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
  /** Folders no fly call may read; the store alone when not given. */
  guarded?: string[];
}): RunningKeeper {
  let handle: ((req: Request, peer: string | null) => Promise<Response>) | null = null;
  const listen = (hostname: string, port: number) => {
    try {
      return Bun.serve({
        hostname,
        port,
        // A held request's poll is short; nothing here streams.
        idleTimeout: 30,
        fetch(req, srv) {
          if (!handle) return new Response('starting', { status: 503 });
          return handle(req, srv.requestIP(req)?.address ?? null);
        },
      });
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      throw new Error(
        `the keeper could not listen on ${hostname.includes(':') ? `[${hostname}]` : hostname}:${port}, so it will not start: another process may be serving its origin (${why})`,
      );
    }
  };
  // `localhost` resolves to either address, so the keeper holds both or none.
  const v4 = listen('127.0.0.1', opts.port);
  const port = v4.port as number;
  let v6: ReturnType<typeof listen>;
  try {
    v6 = listen('::1', port);
  } catch (err) {
    v4.stop(true);
    throw err;
  }
  const origin = `http://localhost:${port}`;
  const requests = createKeeperRequests({
    store: opts.store,
    exec: opts.exec,
    ceremony: { origin, rpId: 'localhost' },
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.log ? { log: opts.log } : {}),
    ...(opts.guarded ? { guarded: opts.guarded } : {}),
  });
  handle = createKeeperHttp({
    requests,
    store: opts.store,
    port,
    ...(opts.now ? { now: opts.now } : {}),
  });
  return {
    port,
    origin,
    requests,
    stop: async () => {
      await Promise.all([v4.stop(true), v6.stop(true)]);
    },
  };
}
