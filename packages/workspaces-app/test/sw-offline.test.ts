/**
 * The service worker's offline half (sw-offline.ts), driven with an in-memory
 * CacheStorage and a fetch the test controls: what is answered from a cache,
 * and that the doc shell still comes from the network whenever it answers.
 */
import { describe, expect, it } from 'vitest';
import {
  ASSET_CACHE,
  type OfflineDeps,
  SHELL_CACHE,
  SHELL_KEY,
  answerApp,
  answerHashed,
  answerShell,
  isKeepPage,
  keepPage,
  offlineRoute,
} from '../src/sw-offline.ts';

const ORIGIN = 'https://board.example';

function memoryCaches(): CacheStorage & { dump(name: string): string[] } {
  const all = new Map<string, Map<string, Response>>();
  const keyOf = (r: RequestInfo | URL): string =>
    new URL(typeof r === 'string' ? r : r instanceof URL ? r.href : r.url, ORIGIN).href;
  const open = async (name: string): Promise<Cache> => {
    let m = all.get(name);
    if (!m) {
      m = new Map();
      all.set(name, m);
    }
    const store = m;
    return {
      match: async (r: RequestInfo | URL) => store.get(keyOf(r))?.clone(),
      put: async (r: RequestInfo | URL, res: Response) => void store.set(keyOf(r), res),
      keys: async () => [...store.keys()].map((u) => new Request(u)),
      delete: async (r: RequestInfo | URL) => store.delete(keyOf(r)),
    } as unknown as Cache;
  };
  return {
    open,
    dump: (name: string) => [...(all.get(name)?.keys() ?? [])],
  } as unknown as CacheStorage & { dump(name: string): string[] };
}

/** A same-origin response, as a real fetch from the worker would type it. */
function basic(body: string, status = 200): Response {
  const res = new Response(body, { status });
  Object.defineProperty(res, 'type', { value: 'basic' });
  const clone = res.clone.bind(res);
  res.clone = () => {
    const c = clone();
    Object.defineProperty(c, 'type', { value: 'basic' });
    return c;
  };
  return res;
}

function deps(
  caches: CacheStorage,
  fetch: OfflineDeps['fetch'],
  timeoutMs = 50,
): OfflineDeps & { settle(): Promise<void> } {
  const pending: Promise<unknown>[] = [];
  return {
    caches,
    fetch,
    timeoutMs,
    waitUntil: (p) => void pending.push(p),
    settle: async () => {
      await Promise.all(pending);
    },
  };
}

const offline: OfflineDeps['fetch'] = () => Promise.reject(new TypeError('Failed to fetch'));
const never: OfflineDeps['fetch'] = () => new Promise(() => {});

describe('offlineRoute', () => {
  const route = (path: string, mode = 'no-cors') =>
    offlineRoute(new URL(path, ORIGIN), mode, ORIGIN);
  it('answers doc page navigations, and only those', () => {
    expect(route('/workspaces/w-1/docs/d-1', 'navigate')).toBe('shell');
    expect(route('/workspaces/w-1/docs/d-1?mobile=1', 'navigate')).toBeNull();
    expect(route('/workspaces/w-1', 'navigate')).toBeNull();
    expect(route('/', 'navigate')).toBeNull();
  });
  it('splits /app/ files into hashed and not', () => {
    expect(route('/app/app-2e921d31b03974c6.js')).toBe('hashed');
    expect(route('/app/app-entry-n5n91mbc.js')).toBe('hashed');
    expect(route('/app/vendor.js')).toBe('app');
    expect(route('/app/BUILD_INFO.txt')).toBeNull();
    expect(route('/app/app-2e921d31b03974c6.js.map')).toBeNull();
  });
  it('leaves API reads, other origins and everything else to the browser', () => {
    expect(route('/workspaces/w-1/docs/d-1?format=json')).toBeNull();
    expect(route('/api/auth/session')).toBeNull();
    expect(
      offlineRoute(new URL('https://cdn.example/app/x-12345678.js'), 'no-cors', ORIGIN),
    ).toBeNull();
  });
});

describe('answerShell', () => {
  const nav = () => new Request(`${ORIGIN}/workspaces/w-1/docs/d-1`);

  it('serves the network shell when the network answers, and keeps it', async () => {
    const caches = memoryCaches();
    const d = deps(caches, async () => basic('<html>current</html>'));
    expect(await (await answerShell(nav(), d)).text()).toBe('<html>current</html>');
    await d.settle();
    expect(caches.dump(SHELL_CACHE)).toEqual([`${ORIGIN}${SHELL_KEY}`]);
  });

  it('serves the network shell over a kept one, so a deploy reaches the page', async () => {
    const caches = memoryCaches();
    await (await caches.open(SHELL_CACHE)).put(SHELL_KEY, basic('<html>old</html>'));
    const d = deps(caches, async () => basic('<html>new</html>'));
    expect(await (await answerShell(nav(), d)).text()).toBe('<html>new</html>');
  });

  it('offline: serves the kept shell', async () => {
    const caches = memoryCaches();
    await (await caches.open(SHELL_CACHE)).put(SHELL_KEY, basic('<html>kept</html>'));
    expect(await (await answerShell(nav(), deps(caches, offline))).text()).toBe(
      '<html>kept</html>',
    );
  });

  it('a link that never answers: the kept shell after the timeout', async () => {
    const caches = memoryCaches();
    await (await caches.open(SHELL_CACHE)).put(SHELL_KEY, basic('<html>kept</html>'));
    expect(await (await answerShell(nav(), deps(caches, never))).text()).toBe('<html>kept</html>');
  });

  it('a 5xx from the tunnel reads as offline; a 4xx does not', async () => {
    const caches = memoryCaches();
    await (await caches.open(SHELL_CACHE)).put(SHELL_KEY, basic('<html>kept</html>'));
    const bad = deps(caches, async () => basic('bad gateway', 502));
    expect(await (await answerShell(nav(), bad)).text()).toBe('<html>kept</html>');
    const gone = deps(caches, async () => basic('not found', 404));
    expect((await answerShell(nav(), gone)).status).toBe(404);
  });

  it('offline with nothing kept: the network failure stands', async () => {
    await expect(answerShell(nav(), deps(memoryCaches(), offline))).rejects.toThrow();
  });
});

describe('answerHashed and answerApp', () => {
  const asset = (p: string) => new Request(`${ORIGIN}${p}`);

  it('a hashed file is answered from the cache without asking the network', async () => {
    const caches = memoryCaches();
    await (await caches.open(ASSET_CACHE)).put(asset('/app/a-12345678.js'), basic('kept'));
    let asked = 0;
    const d = deps(caches, async () => {
      asked++;
      return basic('net');
    });
    expect(await (await answerHashed(asset('/app/a-12345678.js'), d)).text()).toBe('kept');
    expect(asked).toBe(0);
  });

  it('a hashed miss is fetched and kept', async () => {
    const caches = memoryCaches();
    const d = deps(caches, async () => basic('net'));
    await answerHashed(asset('/app/a-12345678.js'), d);
    await d.settle();
    expect(caches.dump(ASSET_CACHE)).toEqual([`${ORIGIN}/app/a-12345678.js`]);
  });

  it('an unhashed file prefers the network and falls back offline', async () => {
    const caches = memoryCaches();
    await (await caches.open(ASSET_CACHE)).put(asset('/app/vendor.js'), basic('kept'));
    const online = deps(caches, async () => basic('net'));
    expect(await (await answerApp(asset('/app/vendor.js'), online)).text()).toBe('net');
    await online.settle();
    // Offline, the latest network answer is what comes back.
    expect(await (await answerApp(asset('/app/vendor.js'), deps(caches, offline))).text()).toBe(
      'net',
    );
    await expect(answerApp(asset('/app/other.js'), deps(caches, offline))).rejects.toThrow();
  });
});

describe('keepPage', () => {
  it('keeps the listed /app/ files and the shell, skipping anything else', async () => {
    const caches = memoryCaches();
    const fetched: string[] = [];
    const d = deps(caches, async (r) => {
      fetched.push(typeof r === 'string' ? r : r.url);
      return basic('x');
    });
    await keepPage(
      {
        type: 'keep-page',
        shell: '/workspaces/w-1/docs/d-1',
        assets: ['/app/a-12345678.js', '/api/auth/session', '/app/BUILD_INFO.txt'],
      },
      ORIGIN,
      d,
    );
    expect(caches.dump(ASSET_CACHE)).toEqual([`${ORIGIN}/app/a-12345678.js`]);
    expect(caches.dump(SHELL_CACHE)).toEqual([`${ORIGIN}${SHELL_KEY}`]);
    expect(fetched).not.toContain(`${ORIGIN}/api/auth/session`);
  });

  it('keeps no shell for a page that is not a doc page', async () => {
    const caches = memoryCaches();
    await keepPage(
      { type: 'keep-page', shell: '/workspaces/w-1', assets: [] },
      ORIGIN,
      deps(caches, async () => basic('x')),
    );
    expect(caches.dump(SHELL_CACHE)).toEqual([]);
  });

  it('only a well-formed message is a keep-page', () => {
    expect(isKeepPage({ type: 'keep-page', shell: '/', assets: ['/app/a.js'] })).toBe(true);
    expect(isKeepPage({ type: 'keep-page', shell: '/', assets: [1] })).toBe(false);
    expect(isKeepPage({ type: 'other' })).toBe(false);
    expect(isKeepPage(null)).toBe(false);
  });
});
