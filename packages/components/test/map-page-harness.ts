/**
 * What the map's off-board browser tests share: a static file server, a
 * headless Chromium page whose every request to another origin is caught,
 * and a read of the map as the page shows it.
 *
 * No request leaves the machine. A tile from OpenStreetMap's origin is
 * answered with a one-pixel PNG; anything else off the page's own origin is
 * failed and listed, so a test can say the map asked nowhere else.
 *
 * Used by `static-page-browser.test.ts`, the board doc's
 * `workspaces-app/test/components-map-doc-browser-driver.ts` and the Astro
 * fixture's `templates/astro-chart/test/astro-map.test.ts`.
 *
 * audit: no-text — every value returned comes from the running page.
 */
import type { ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { type Server, createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { BASEMAPS } from '@claude-workspaces/core/map-basemaps';
import {
  Cdp,
  launchChrome,
  pageSocketUrl,
  sleep,
  stopBrowser,
} from '../../../scripts/headless-chrome.ts';
import { STARTUP_TIMEOUT_MS, chromeLaunchArgs } from '../../../scripts/ui-shot-lib.ts';

/** A one-pixel grey PNG, standing in for every map tile. */
const TILE =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGN4AQAA6gDp3uJOLwAAAABJRU5ErkJggg==';
const TILE_ORIGINS: readonly string[] = BASEMAPS.osm?.origins ?? [];

/** Content types by extension, without its dot. */
const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json',
};

/** Serve `root` on a free loopback port. */
export async function serveDir(
  root: string,
): Promise<{ origin: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const path = normalize(decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/'));
    const file = join(root, path.endsWith('/') ? `${path}index.html` : path);
    if (!file.startsWith(root)) {
      res.writeHead(404).end();
      return;
    }
    readFile(file).then(
      (body) =>
        res
          .writeHead(200, {
            'content-type': TYPES[extname(file).slice(1)] ?? 'application/octet-stream',
          })
          .end(body),
      () => res.writeHead(404).end(),
    );
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/** The first map under `selector`, as the page shows it. */
export interface MapReading {
  /** What the slot says it drew, and on which basemap. */
  markers: number;
  rings: number;
  basemap: string;
  /** SVG paths on the page: one per marker. */
  markerPaths: number;
  /** Tiles Leaflet placed and saw load. */
  tilesLoaded: number;
  title: string;
  legend: string[];
  /** Whether Leaflet's stylesheet reached the page: its panes are placed
   *  absolutely, which nothing but that stylesheet says. */
  styled: boolean;
  /** The map's width and the page's. */
  width: number;
  viewport: number;
}

/** A read of the first map under `selector`, or null until it has drawn and
 *  a tile has loaded. */
const readMap = (selector: string) => `(() => {
  const root = document.querySelector(${JSON.stringify(`${selector} .cw-map`)});
  const slot = root && root.querySelector('.cw-map-slot');
  if (!slot || !slot.dataset.markers) return null;
  const tilesLoaded = slot.querySelectorAll('img.leaflet-tile-loaded').length;
  if (tilesLoaded === 0) return null;
  const pane = slot.querySelector('.leaflet-pane');
  return {
    markers: Number(slot.dataset.markers),
    rings: Number(slot.dataset.rings),
    basemap: slot.dataset.basemap || '',
    markerPaths: slot.querySelectorAll('path.cw-map-marker').length,
    tilesLoaded,
    title: root.querySelector('.cw-map-title')?.textContent ?? '',
    legend: [...root.querySelectorAll('.cw-map-legend li')].map((li) => li.textContent),
    styled: !!pane && getComputedStyle(pane).position === 'absolute',
    width: Math.round(slot.getBoundingClientRect().width),
    viewport: document.documentElement.clientWidth,
  };
})()`;

export async function until<T>(
  what: string,
  read: () => Promise<T | null>,
  ms = 30_000,
): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await read();
    if (v !== null && v !== undefined) return v;
    await sleep(50);
  }
  throw new Error(`never happened: ${what}`);
}

export interface MapPage {
  cdp: Cdp;
  /** Load `url` at `width` x `height`. */
  open(url: string, width: number, height: number): Promise<void>;
  /** The first map under `selector`, or null until it has drawn and a tile
   *  has loaded. */
  read(selector: string): Promise<MapReading | null>;
  tileRequests(): number;
  /** Origins other than the page's and the tiles' that the page asked for. */
  stray: string[];
  close(): Promise<void>;
}

/** Launch headless Chromium on one page that may reach `origin` and,
 *  answered locally, OpenStreetMap's tiles. */
export async function mapPage(chrome: string, origin: string, label: string): Promise<MapPage> {
  let browser: { proc: ChildProcess; profile: string } | undefined;
  const b = await launchChrome(
    chrome,
    (profile) => chromeLaunchArgs({ width: 1180, height: 820 }, profile),
    STARTUP_TIMEOUT_MS,
    `${label}-${process.pid}`,
    (started) => {
      browser = started;
    },
  );
  const cdp = await Cdp.connect(await pageSocketUrl(b.port, STARTUP_TIMEOUT_MS));
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  let tiles = 0;
  const stray: string[] = [];
  cdp.on('Fetch.requestPaused', (p) => {
    const requestId = String(p.requestId);
    const url = String((p.request as { url: string }).url);
    const at = new URL(url).origin;
    if (at === origin) {
      void cdp.send('Fetch.continueRequest', { requestId });
    } else if (TILE_ORIGINS.includes(at)) {
      tiles++;
      void cdp.send('Fetch.fulfillRequest', {
        requestId,
        responseCode: 200,
        responseHeaders: [
          { name: 'content-type', value: 'image/png' },
          { name: 'access-control-allow-origin', value: '*' },
        ],
        body: TILE,
      });
    } else {
      stray.push(at);
      void cdp.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
    }
  });
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
  return {
    cdp,
    async open(url, width, height) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: false,
      });
      const loaded = cdp.once('Page.loadEventFired');
      await cdp.send('Page.navigate', { url });
      await loaded;
    },
    read: async (selector) => (await cdp.evaluate(readMap(selector))) as MapReading | null,
    tileRequests: () => tiles,
    stray,
    async close() {
      cdp.close();
      if (browser) await stopBrowser(browser.proc, browser.profile);
    },
  };
}
