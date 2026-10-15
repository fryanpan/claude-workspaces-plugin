/**
 * The service worker's offline half: which requests it answers, and how.
 *
 * Only two kinds, both of which hold no user data:
 *
 *  - **The doc page's shell** (`/workspaces/<ws>/docs/<id>`), network first.
 *    The server sends it `no-store` because it names the bundle URLs the page
 *    loads, and a browser running an old shell against new bundles never
 *    notices (shells.ts, HTML_SHELL_HEADERS). Network first keeps that: when
 *    the network answers inside `SHELL_TIMEOUT_MS` the page gets the current
 *    shell, exactly as before. Only when it does not — offline, or a link too
 *    slow to answer — does the page get the last shell this worker saw, which
 *    names bundles this worker also kept, so the old version runs whole and
 *    the stale-client notice says "reload" once the server is reachable. The
 *    network answer still lands in the cache for next time. Every doc is
 *    served the same built `index.html`, so one copy serves every doc.
 *  - **`/app/` files.** A content-hashed name never changes bytes, so it is
 *    answered from the cache when present. Any other `/app/` file goes to the
 *    network and falls back to the cache only when the network fails.
 *
 * The doc's content is not here: it is the page's IndexedDB copy
 * (doc-cache.ts), scoped to an identity. Nothing else — no API read, no board,
 * no mock — is answered from a cache.
 */

export const SHELL_CACHE = 'cw-shell-v1';
export const ASSET_CACHE = 'cw-assets-v1';
export const CURRENT_CACHES: readonly string[] = [SHELL_CACHE, ASSET_CACHE];
/** The single key every doc page's shell is stored under. */
export const SHELL_KEY = '/__cw/doc-shell';
/** How long a navigation waits on the network before the kept shell answers. */
export const SHELL_TIMEOUT_MS = 3000;
/** Past this many kept files, the oldest go. */
export const MAX_ASSETS = 400;

const DOC_PAGE = /^\/workspaces\/[^/]+\/docs\/[^/]+\/?$/;
const HASHED = /-[0-9a-z]{8,}\.(?:js|css)$/;

export type OfflineRoute = 'shell' | 'hashed' | 'app' | null;

/** Which way a same-origin GET is answered; null leaves it to the browser. */
export function offlineRoute(url: URL, mode: string, origin: string): OfflineRoute {
  if (url.origin !== origin) return null;
  if (mode === 'navigate') {
    return DOC_PAGE.test(url.pathname) && !url.searchParams.has('mobile') ? 'shell' : null;
  }
  if (!url.pathname.startsWith('/app/')) return null;
  if (url.pathname === '/app/BUILD_INFO.txt' || url.pathname.endsWith('.map')) return null;
  return HASHED.test(url.pathname) ? 'hashed' : 'app';
}

/**
 * Vary is ignored on a match. The server sends `Vary: Origin` on scripts, and
 * a module script's request carries an `Origin` header that the page's own
 * keep-page fetch does not, so an exact match missed every script a reload
 * asked for. The bytes behind one `/app/` URL do not change with either
 * header: the encoding is undone before the response reaches the cache.
 */
const MATCH: CacheQueryOptions = { ignoreVary: true };

/** A response worth keeping: a whole, same-origin 200. */
function keepable(res: Response): boolean {
  return res.ok && res.status === 200 && res.type === 'basic';
}

export interface OfflineDeps {
  caches: CacheStorage;
  fetch: (req: Request | string) => Promise<Response>;
  /** The worker's `event.waitUntil`, so a cache write outlives the response. */
  waitUntil: (p: Promise<unknown>) => void;
  timeoutMs?: number;
}

async function trim(cache: Cache): Promise<void> {
  const keys = await cache.keys();
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_ASSETS))) await cache.delete(key);
}

export async function answerShell(req: Request, d: OfflineDeps): Promise<Response> {
  const net = d.fetch(req).then(async (res) => {
    if (keepable(res)) await (await d.caches.open(SHELL_CACHE)).put(SHELL_KEY, res.clone());
    return res;
  });
  d.waitUntil(net.catch(() => null));
  const timeout = new Promise<null>((resolve) =>
    setTimeout(() => resolve(null), d.timeoutMs ?? SHELL_TIMEOUT_MS),
  );
  const first = await Promise.race([net.catch(() => null), timeout]);
  // A 5xx is the tunnel saying the box is unreachable, which is offline too.
  if (first && first.status < 500) return first;
  const kept = await (await d.caches.open(SHELL_CACHE)).match(SHELL_KEY);
  return kept ?? first ?? net;
}

export async function answerHashed(req: Request, d: OfflineDeps): Promise<Response> {
  const cache = await d.caches.open(ASSET_CACHE);
  const hit = await cache.match(req, MATCH);
  if (hit) return hit;
  const res = await d.fetch(req);
  if (keepable(res)) d.waitUntil(cache.put(req, res.clone()).then(() => trim(cache)));
  return res;
}

export async function answerApp(req: Request, d: OfflineDeps): Promise<Response> {
  const cache = await d.caches.open(ASSET_CACHE);
  try {
    const res = await d.fetch(req);
    if (keepable(res)) d.waitUntil(cache.put(req, res.clone()).then(() => trim(cache)));
    return res;
  } catch (err) {
    const hit = await cache.match(req, MATCH);
    if (hit) return hit;
    throw err;
  }
}

/** What a page posts once it has loaded: the files it fetched before this
 *  worker controlled it, and its own address for the shell. */
export interface KeepPageMessage {
  type: 'keep-page';
  shell: string;
  assets: string[];
}

export function isKeepPage(data: unknown): data is KeepPageMessage {
  const m = data as Partial<KeepPageMessage> | null;
  return (
    !!m &&
    m.type === 'keep-page' &&
    typeof m.shell === 'string' &&
    Array.isArray(m.assets) &&
    m.assets.every((a) => typeof a === 'string')
  );
}

/** Keep what a page loaded before this worker was there to see it. */
export async function keepPage(m: KeepPageMessage, origin: string, d: OfflineDeps): Promise<void> {
  const assets = await d.caches.open(ASSET_CACHE);
  for (const raw of m.assets.slice(0, 50)) {
    let url: URL;
    try {
      url = new URL(raw, origin);
    } catch {
      continue;
    }
    const route = offlineRoute(url, 'no-cors', origin);
    if (route !== 'hashed' && route !== 'app') continue;
    if (await assets.match(url.href, MATCH)) continue;
    try {
      const res = await d.fetch(url.href);
      if (keepable(res)) await assets.put(url.href, res);
    } catch {}
  }
  let shell: URL;
  try {
    shell = new URL(m.shell, origin);
  } catch {
    return;
  }
  if (offlineRoute(shell, 'navigate', origin) !== 'shell') return;
  const shells = await d.caches.open(SHELL_CACHE);
  if (await shells.match(SHELL_KEY)) return;
  try {
    const res = await d.fetch(shell.href);
    if (keepable(res)) await shells.put(SHELL_KEY, res);
  } catch {}
}
