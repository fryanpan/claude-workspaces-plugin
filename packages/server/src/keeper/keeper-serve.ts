/**
 * Start the keeper: the request book, the HTTP surface, and `Bun.serve`
 * around them. Split from `keeper-bin.ts` so a test can start the same keeper
 * in-process with stand-in executors.
 *
 * Two ways to listen. Given `unix`, the keeper serves a unix socket and
 * launchd's port job holds the TCP port (`keeper-launchd.ts`); this is how
 * it runs in production, because then the port is never free. Without it the
 * keeper listens on both loopback addresses itself.
 */
import { lstatSync, statSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { RELAYED_PEER, createKeeperHttp } from './keeper-http.ts';
import { type Executors, type KeeperRequests, createKeeperRequests } from './keeper-requests.ts';
import type { KeeperStore } from './keeper-store.ts';

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
  /** The user whose files a fly call may not read; this process's by default. */
  keeperUid?: number;
  /** Serve this unix socket instead; `port` is then the port launchd holds. */
  unix?: string;
}): RunningKeeper {
  let handle: ((req: Request, peer: string | null) => Promise<Response>) | null = null;
  if (opts.unix) return serveRelayed({ ...opts, unix: opts.unix });
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
  const wired = wire(opts, port);
  handle = wired.handle;
  const { requests } = wired;
  return {
    port,
    origin: `http://localhost:${port}`,
    requests,
    stop: async () => {
      await Promise.all([v4.stop(true), v6.stop(true)]);
    },
  };
}

type ServeOpts = Parameters<typeof serveKeeper>[0];

function wire(opts: ServeOpts, port: number) {
  const origin = `http://localhost:${port}`;
  const requests = createKeeperRequests({
    store: opts.store,
    exec: opts.exec,
    ceremony: { origin, rpId: 'localhost' },
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.log ? { log: opts.log } : {}),
    ...(opts.guarded ? { guarded: opts.guarded } : {}),
    ...(opts.keeperUid !== undefined ? { keeperUid: opts.keeperUid } : {}),
  });
  const handle = createKeeperHttp({
    requests,
    store: opts.store,
    port,
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.log ? { log: opts.log } : {}),
  });
  return { requests, handle };
}

/**
 * Serve the unix socket launchd relays to. Its folder must belong to this
 * user and be closed to everyone else, or another process could put its own
 * socket at the path and answer as the keeper.
 */
function serveRelayed(opts: ServeOpts & { unix: string }): RunningKeeper {
  if (!opts.port) throw new Error('a relayed keeper needs the port launchd holds');
  const folder = dirname(opts.unix);
  const st = statSync(folder);
  // sockaddr_un holds 104 bytes on macOS, the terminator included.
  if (Buffer.byteLength(opts.unix) > 103) throw new Error(`${opts.unix} is too long for a socket`);
  if (st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0) {
    throw new Error(`${folder} must belong to the keeper's user with mode 700`);
  }
  try {
    if (lstatSync(opts.unix).isSocket()) unlinkSync(opts.unix);
  } catch {
    // no stale socket
  }
  const { requests, handle } = wire(opts, opts.port);
  const server = Bun.serve({
    unix: opts.unix,
    fetch: (req) => handle(req, RELAYED_PEER),
  });
  return {
    port: opts.port,
    origin: `http://localhost:${opts.port}`,
    requests,
    stop: async () => {
      await server.stop(true);
    },
  };
}
