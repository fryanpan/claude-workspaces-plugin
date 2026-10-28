#!/usr/bin/env bun
/**
 * A service worker planted on the keeper's origin while its port was free,
 * then the real keeper started on that port, in headless Chromium.
 *
 * A squatter listens on both loopback addresses and serves a page that
 * registers a worker for the whole origin. The squatter stops, the keeper
 * starts on the same port, and the owner opens the approval page three
 * times. Spawned by `keeper-service-worker-browser.test.ts`, which reads the
 * JSON this prints last.
 *
 *   bun scripts/keeper-service-worker-driver.ts [passthrough|quiet]
 *
 * `passthrough` is the worker an attack needs to show a real page: it
 * fetches each navigation from the keeper and rewrites what it shows.
 * `quiet` never reaches the keeper: it is registered with
 * `updateViaCache: 'all'` from a script cached for a day, and answers every
 * navigation itself. It is the known limit in security.md.
 *
 * audit: no-text — every value it returns came from the page and the keeper.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serveKeeper } from '../packages/server/src/keeper/keeper-serve.ts';
import { openKeeperStore } from '../packages/server/src/keeper/keeper-store.ts';
import { Cdp, launchChrome, pageSocketUrl, sleep, stopBrowser } from './headless-chrome.ts';
import { STARTUP_TIMEOUT_MS, chromeLaunchArgs, resolveChromeBin } from './ui-shot-lib.ts';

export interface ServiceWorkerReading {
  plant: string;
  planted: string;
  /**
   * Per navigation to the approval page: who answered, and how many workers
   * were registered 2.5s later (null when the page did not answer).
   */
  navigations: { answeredBy: 'worker' | 'keeper' | 'nothing'; workersAfter: number | null }[];
  alarm: string | null;
  /** The keeper's answer to the owner's page asking for a challenge afterwards. */
  challengeStatus: number;
}

const plant = process.argv[2] === 'quiet' ? 'quiet' : 'passthrough';
const MARK = 'PLANTED-WORKER';

const WORKER =
  plant === 'quiet'
    ? `self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => e.respondWith(new Response(
  '<link rel=icon href="data:,"><p id=t>${MARK}</p>', { headers: { 'content-type': 'text/html' } })));`
    : `self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  if (e.request.mode !== 'navigate') return;
  e.respondWith(fetch(e.request).then((r) => r.text()).then((t) => new Response(
    '<link rel=icon href="data:,"><p id=t>${MARK}</p>' + t, { headers: { 'content-type': 'text/html' } })));
});`;

/** A port free on both loopback addresses. */
function freePort(): number {
  for (;;) {
    const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
    const port = probe.port as number;
    probe.stop(true);
    try {
      Bun.serve({ hostname: '::1', port, fetch: () => new Response('') }).stop(true);
      return port;
    } catch {
      // taken on ::1; try another
    }
  }
}

const port = freePort();
const squat = (['127.0.0.1', '::1'] as const).map((hostname) =>
  Bun.serve({
    hostname,
    port,
    fetch(req) {
      if (new URL(req.url).pathname === '/sw.js') {
        return new Response(WORKER, {
          headers: {
            'content-type': 'text/javascript',
            ...(plant === 'quiet' ? { 'cache-control': 'max-age=86400' } : {}),
          },
        });
      }
      const opts = plant === 'quiet' ? "{ scope: '/', updateViaCache: 'all' }" : "{ scope: '/' }";
      return new Response(
        `<link rel=icon href="data:,"><p id=t>planting</p><script>navigator.serviceWorker.register('/sw.js', ${opts}).then(() => navigator.serviceWorker.ready).then(() => { document.getElementById('t').textContent = 'planted'; });</script>`,
        { headers: { 'content-type': 'text/html' } },
      );
    },
  }),
);

const tmp = mkdtempSync(join(tmpdir(), 'keeper-sw-'));
const dir = join(tmp, 'store');
mkdirSync(dir, { mode: 0o700 });
const store = openKeeperStore(dir);
if ('error' in store) throw new Error(store.error);

const browser = await launchChrome(
  resolveChromeBin(undefined),
  (profile) => chromeLaunchArgs({ width: 800, height: 600 }, profile),
  STARTUP_TIMEOUT_MS,
  `keeper-sw-${process.pid}`,
);
const within = <T>(p: Promise<T>, ms: number, fallback: T) =>
  Promise.race([p, sleep(ms).then(() => fallback)]);

let reading: ServiceWorkerReading | undefined;
try {
  const cdp = await Cdp.connect(await pageSocketUrl(browser.port, STARTUP_TIMEOUT_MS));
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  // A navigation a worker answers can stall; bound every step.
  const open = async (url: string) => {
    const loaded = cdp.once('Page.loadEventFired');
    await within(
      cdp.send('Page.navigate', { url }).then(() => loaded),
      6000,
      undefined,
    );
  };
  const read = (js: string) => within(cdp.evaluate(js), 4000, 'TIMEOUT');
  const shown = async () =>
    String(
      await read(`document.getElementById('t')?.textContent ?? document.body?.innerText ?? ''`),
    );
  const workers = async () => {
    const n = await read('navigator.serviceWorker.getRegistrations().then((r) => r.length)');
    return typeof n === 'number' ? n : null;
  };

  await open(`http://localhost:${port}/plant`);
  let planted = '';
  for (let i = 0; i < 50 && planted !== 'planted'; i++) {
    planted = await shown();
    if (planted !== 'planted') await sleep(100);
  }
  for (const s of squat) s.stop(true);

  const keeper = serveKeeper({
    store,
    port,
    exec: {
      fly: async () => ({ status: 0, stdout: '', stderr: '' }),
      cloudflare: async () => ({ status: 500, body: '{}' }),
    },
  });
  try {
    const held = await keeper.requests.submit(
      { type: 'fly', args: ['apps', 'create', 'cw-riverbend'] },
      'driver',
    );
    if (held.outcome !== 'held') throw new Error('the request was not held');
    const id = held.request.id;
    const navigations: ServiceWorkerReading['navigations'] = [];
    for (let i = 0; i < 3; i++) {
      await open(`http://localhost:${port}/approve/${id}`);
      const text = await shown();
      await sleep(2500);
      navigations.push({
        answeredBy: text.includes(MARK)
          ? 'worker'
          : /approve|stopped/i.test(text)
            ? 'keeper'
            : 'nothing',
        workersAfter: await workers(),
      });
    }
    // The owner's own page, asking for a challenge the way the page script does.
    const page = keeper.requests.openPage(id) ?? '';
    const c = await fetch(`http://127.0.0.1:${port}/v1/requests/${id}/challenge`, {
      method: 'POST',
      headers: {
        host: `localhost:${port}`,
        origin: keeper.origin,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ page }),
    });
    reading = {
      plant,
      planted,
      navigations,
      alarm: store.alarm()?.reason ?? null,
      challengeStatus: c.status,
    };
  } finally {
    await keeper.stop();
    cdp.close();
  }
} finally {
  await stopBrowser(browser.proc, browser.profile);
  rmSync(tmp, { recursive: true, force: true });
}
console.log(JSON.stringify(reading));
// A navigation the worker stalled can hold a handle open for ~25s after Chrome is gone.
process.exit(0);
