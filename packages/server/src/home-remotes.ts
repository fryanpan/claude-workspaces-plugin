/**
 * Bryan's Home on the Mac, across servers: the pull that brings each project
 * server's review items here.
 *
 * **Pull, not push.** The Mac calls out to every other server; no server
 * ever calls the Mac. Each request goes to the one address, under
 * `/workspaces/<board>/home-feed`, so the board router Worker sends it to the
 * server that holds that board, and Access admits it on the service token
 * this file sends for that server (one token per server, never shared).
 *
 * **One table.** Which server holds which board is the Worker's own
 * `BOARD_ORIGINS`, read with the Worker's own parser (`parseBoardOrigins`).
 * Every board listed under another origin is pulled; the Mac's own origin
 * (`self`) is skipped, since its boards are already on Home.
 *
 * **Live.** For each remote board the Mac holds one event stream open
 * (`…/home-feed/events:stream`). Its frames carry no content: each one makes
 * the Mac re-read that board's feed, and a feed that changed tells open Home
 * pages to redraw (`onChange`, which the server wires to `landing.changed`).
 * The stream is read again from scratch whenever it reopens, so nothing
 * missed while it was down stays missed. A stream that drops is reopened
 * with a doubling wait, 1s to 30s.
 *
 * Everything a remote answers goes through `readHomeFeed` before it is kept.
 */
import { readFileSync, statSync } from 'node:fs';
import { parseBoardOrigins } from '../../../infra/board-router-worker/worker.js';
import { type HomeFeedRow, readHomeFeed } from './home-feed.ts';

export interface ServiceToken {
  clientId: string;
  clientSecret: string;
}

export interface HomeRemotesConfig {
  /** The one address, as an https origin. */
  address: string;
  /** This machine's origin hostname in the table, or '' for none. */
  self: string;
  /** Board id → the origin hostname that holds it. */
  table: Map<string, string>;
  /** Origin hostname → the Access service token the Mac sends it. */
  tokens: Map<string, ServiceToken>;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** One remote board, as Home draws it. */
export interface RemoteBoardView {
  boardId: string;
  boardName: string;
  rows: HomeFeedRow[];
  /** Rows refused whole on the last read. */
  dropped: number;
  /** Links removed from kept rows on the last read. */
  linksRefused: number;
  /** null before the first read finishes; false when the last read failed,
   *  in which case `rows` are the last ones read. */
  reached: boolean | null;
}

const TOKEN_PART = /^[A-Za-z0-9._-]{1,256}$/;
/** The most bytes one feed answer may be. */
const MAX_FEED_BYTES = 1_000_000;
/** The most bytes of stream held while waiting for a frame to end. */
const MAX_FRAME_BYTES = 64_000;
const FEED_TIMEOUT_MS = 10_000;

/**
 * The config file's contents, or a reason it was refused. Fails closed: any
 * bad part refuses the whole file, so a typo pulls nothing rather than
 * something unintended.
 *
 * ```json
 * {"address": "https://<one address>",
 *  "self": "<this machine's origin hostname>",
 *  "boardOrigins": {"<origin hostname>": ["<board id>", ...]},
 *  "serviceTokens": {"<origin hostname>": {"clientId": "…", "clientSecret": "…"}}}
 * ```
 */
export function parseHomeRemotesConfig(raw: string): HomeRemotesConfig | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: 'not JSON' };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: 'not a JSON object' };
  }
  const c = parsed as Record<string, unknown>;
  let address: URL;
  try {
    address = new URL(String(c.address));
  } catch {
    return { error: 'address is not a URL' };
  }
  if (address.protocol !== 'https:' || address.origin !== String(c.address).replace(/\/$/, '')) {
    return { error: 'address must be a bare https origin' };
  }
  const self = typeof c.self === 'string' ? c.self : '';
  const table = parseBoardOrigins(JSON.stringify(c.boardOrigins ?? null));
  if (!table) return { error: 'boardOrigins is not a valid routing table' };
  const tokens = new Map<string, ServiceToken>();
  const rawTokens = c.serviceTokens;
  if (rawTokens === null || typeof rawTokens !== 'object' || Array.isArray(rawTokens)) {
    return { error: 'serviceTokens must be an object' };
  }
  for (const origin of new Set(table.values())) {
    if (origin === self) continue;
    const t = (rawTokens as Record<string, unknown>)[origin] as Record<string, unknown> | undefined;
    const clientId = t?.clientId;
    const clientSecret = t?.clientSecret;
    if (
      typeof clientId !== 'string' ||
      typeof clientSecret !== 'string' ||
      !TOKEN_PART.test(clientId) ||
      !TOKEN_PART.test(clientSecret)
    ) {
      return { error: `no valid service token for ${origin}` };
    }
    tokens.set(origin, { clientId, clientSecret });
  }
  return { address: address.origin, self, table, tokens };
}

/**
 * The config `CW_HOME_REMOTES_FILE` names, or null when it is unset. A file
 * anyone but its owner can read is refused, since it holds service token
 * secrets. Every refusal is logged and pulls nothing.
 */
export function homeRemotesFromEnv(
  env: Record<string, string | undefined>,
): HomeRemotesConfig | null {
  const path = env.CW_HOME_REMOTES_FILE?.trim();
  if (!path) return null;
  try {
    if ((statSync(path).mode & 0o077) !== 0) {
      console.error(`[home-remotes] IGNORING ${path}: readable by others; chmod 600 it.`);
      return null;
    }
    const config = parseHomeRemotesConfig(readFileSync(path, 'utf8'));
    if ('error' in config) {
      console.error(`[home-remotes] IGNORING ${path}: ${config.error}.`);
      return null;
    }
    return config;
  } catch {
    console.error(`[home-remotes] IGNORING ${path}: it could not be read.`);
    return null;
  }
}

export interface HomeRemotes {
  /** Open every stream. Called once the server is bound. */
  start(): void;
  /** Every remote board, in table order. */
  boards(): RemoteBoardView[];
  dispose(): void;
}

/** Origin hostname → the boards it holds: where that remote's links may point. */
function boardsByOrigin(table: Map<string, string>): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const [board, origin] of table) {
    const set = out.get(origin) ?? new Set<string>();
    set.add(board);
    out.set(origin, set);
  }
  return out;
}

export function createHomeRemotes(opts: {
  config: HomeRemotesConfig;
  fetch?: FetchLike;
  /** A remote board's view changed: tell open Home pages. */
  onChange: () => void;
  retryMs?: number;
  maxRetryMs?: number;
}): HomeRemotes {
  const { config, onChange } = opts;
  const fetchFn: FetchLike = opts.fetch ?? ((input, init) => fetch(input, init));
  const retryMs = opts.retryMs ?? 1000;
  const maxRetryMs = opts.maxRetryMs ?? 30_000;
  const held = boardsByOrigin(config.table);
  const views = new Map<string, RemoteBoardView>();
  for (const [boardId, origin] of config.table) {
    if (origin === config.self || !config.tokens.has(origin)) continue;
    views.set(boardId, {
      boardId,
      boardName: boardId,
      rows: [],
      dropped: 0,
      linksRefused: 0,
      reached: null,
    });
  }
  const controllers = new Set<AbortController>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let disposed = false;

  const headersFor = (boardId: string, accept: string): Record<string, string> => {
    const token = config.tokens.get(config.table.get(boardId) ?? '');
    return {
      accept,
      ...(token
        ? { 'cf-access-client-id': token.clientId, 'cf-access-client-secret': token.clientSecret }
        : {}),
    };
  };
  const feedUrl = (boardId: string, tail = ''): string =>
    `${config.address}/workspaces/${encodeURIComponent(boardId)}/home-feed${tail}`;

  const keep = (boardId: string, next: RemoteBoardView): void => {
    const was = views.get(boardId);
    views.set(boardId, next);
    if (JSON.stringify(was) !== JSON.stringify(next)) onChange();
  };

  const readFeed = async (boardId: string): Promise<void> => {
    const prior = views.get(boardId);
    if (!prior) return;
    const origin = config.table.get(boardId) ?? '';
    try {
      const res = await fetchFn(feedUrl(boardId), {
        headers: headersFor(boardId, 'application/json'),
        redirect: 'manual',
        signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
      });
      if (res.status !== 200) throw new Error(`status ${res.status}`);
      if (Number(res.headers.get('content-length') ?? 0) > MAX_FEED_BYTES) throw new Error('large');
      const body = await res.text();
      if (body.length > MAX_FEED_BYTES) throw new Error('large');
      const feed = readHomeFeed(JSON.parse(body), boardId, held.get(origin) ?? new Set());
      if (!feed) throw new Error('not a feed');
      if (feed.dropped > 0 || feed.linksRefused > 0) {
        console.error(
          `[home-remotes] ${boardId}: ${feed.dropped} row(s) refused, ${feed.linksRefused} link(s) removed`,
        );
      }
      keep(boardId, { boardId, ...feed, reached: true });
    } catch {
      if (!disposed) keep(boardId, { ...prior, reached: false });
    }
  };

  // One read at a time per board; a frame during a read asks for one more.
  const reading = new Map<string, Promise<void>>();
  const again = new Set<string>();
  const refresh = (boardId: string): Promise<void> => {
    const inflight = reading.get(boardId);
    if (inflight) {
      again.add(boardId);
      return inflight;
    }
    const run = (async () => {
      do {
        again.delete(boardId);
        await readFeed(boardId);
      } while (again.has(boardId) && !disposed);
      reading.delete(boardId);
    })();
    reading.set(boardId, run);
    return run;
  };

  const readFrames = async (
    body: ReadableStream<Uint8Array>,
    boardId: string,
    signal: AbortSignal,
  ): Promise<void> => {
    const reader = body.getReader();
    // A remote that ignores the abort still lets go of this reader.
    signal.addEventListener('abort', () => void reader.cancel().catch(() => {}), { once: true });
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buf += decoder.decode(value, { stream: true });
      let sep = buf.indexOf('\n\n');
      while (sep >= 0) {
        if (/^event: landing\.changed$/m.test(buf.slice(0, sep))) void refresh(boardId);
        buf = buf.slice(sep + 2);
        sep = buf.indexOf('\n\n');
      }
      if (buf.length > MAX_FRAME_BYTES) throw new Error('frame too long');
    }
  };

  const wait = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const t = setTimeout(() => {
        timers.delete(t);
        resolve();
      }, ms);
      timers.add(t);
    });

  const follow = async (boardId: string): Promise<void> => {
    let delay = retryMs;
    while (!disposed) {
      const ctrl = new AbortController();
      controllers.add(ctrl);
      try {
        const res = await fetchFn(feedUrl(boardId, '/events:stream'), {
          headers: headersFor(boardId, 'text/event-stream'),
          redirect: 'manual',
          signal: ctrl.signal,
        });
        if (res.status !== 200 || !res.body) throw new Error(`status ${res.status}`);
        delay = retryMs;
        void refresh(boardId);
        await readFrames(res.body, boardId, ctrl.signal);
      } catch {
        // Unreachable, refused, or dropped: read once so Home says so.
        if (!disposed) await refresh(boardId);
      } finally {
        controllers.delete(ctrl);
      }
      if (disposed) return;
      await wait(delay);
      delay = Math.min(delay * 2, maxRetryMs);
    }
  };

  return {
    start() {
      for (const boardId of views.keys()) void follow(boardId);
    },
    boards: () => [...views.values()],
    dispose() {
      disposed = true;
      for (const c of controllers) c.abort();
      for (const t of timers) clearTimeout(t);
      controllers.clear();
      timers.clear();
    },
  };
}
