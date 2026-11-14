#!/usr/bin/env bun
/**
 * A `<StreetMap basemap="google">` on the real doc page, in headless Chromium
 * against two real servers, one holding a fake Maps key and one holding none,
 * and a `<StreetMap>` on OpenStreetMap beside it on the keyed server.
 *
 * No request leaves the machine. Google's Maps script is answered with the
 * stand-in in `fake-google-maps.ts`, its tiles and OpenStreetMap's with a grey
 * PNG, and anything else is failed and reported. Every request is filed under
 * the page that made it, so the test can say which page asked Google for
 * anything and which asked the server for the key.
 *
 * Spawned by `mdx-street-map-google-browser.test.ts`, which reads the JSON it
 * prints.
 *
 * audit: no-text — every value returned comes from the running page.
 */
import { type ChildProcess, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BASEMAPS, basemapAllows } from '@claude-workspaces/core/map-basemaps';
import {
  Cdp,
  launchChrome,
  pageSocketUrl,
  sleep,
  stopBrowser,
} from '../../../scripts/headless-chrome.ts';
import {
  STARTUP_TIMEOUT_MS,
  chromeLaunchArgs,
  resolveChromeBin,
} from '../../../scripts/ui-shot-lib.ts';
import { type ServerHandle, createServer } from '../../server/src/server.ts';
import { tinyPng } from '../../server/test/tiny-png.ts';
import {
  FAKE_GOOGLE_MAPS_JS,
  FAKE_KEY,
  GOOGLE_CREDIT,
  REFUSED_KEY,
  UNLOADED_KEY,
} from './fake-google-maps.ts';

/** What one open page did. */
export interface PageReading {
  /** The basemap the map says it drew on. */
  basemap: string;
  markerPaths: number;
  ringPaths: number;
  /** Loaded tiles whose image came from Google's tile address. */
  googleTiles: number;
  /** Loaded tiles from OpenStreetMap. */
  osmTiles: number;
  /** The fallback notice, or null when it is hidden. */
  notice: string | null;
  /** The text of the map's corner controls, where the credit sits. */
  corners: string;
  /** Whether the page has a Maps script tag, or a `google` global. */
  googleScriptTag: boolean;
  googleGlobal: boolean;
  /** The `key` each request for Google's Maps script carried. */
  scriptKeys: string[];
  /** Requests to any of Google's listed origins, script and tiles. */
  googleRequests: number;
  /** Requests this page made to the server for a map key. */
  keyRequests: number;
  /** Requests to an origin no basemap lists. */
  strayRequests: string[];
  width: number;
}

export interface GoogleMapReading {
  /** The keyed server, the Google doc, at 1180x820 and at 430. */
  wide: PageReading;
  narrow: PageReading;
  /** The keyed server, a doc whose map is on OpenStreetMap. */
  plain: PageReading;
  /** The server with no key, the Google doc. */
  keyless: PageReading;
  /** A server whose key Google refuses, and one whose Google script never
   *  arrives: the Google doc on each. */
  refused: PageReading;
  unloaded: PageReading;
}

const step = (what: string): void => {
  process.stderr.write(`[google-map-driver] ${what}\n`);
};

async function until<T>(what: string, read: () => Promise<T | null>, ms = 40_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await read();
    if (v !== null && v !== undefined) return v;
    await sleep(50);
  }
  throw new Error(`never happened: ${what}`);
}

const MARKERS = Array.from({ length: 12 }, (_, i) => ({
  lat: 37.76 + (i % 4) * 0.004,
  lng: -122.44 + Math.floor(i / 4) * 0.005,
  popup: `${['Harborlight', 'Riverbend', 'Saltmarsh'][i % 3]} hall ${i + 1}`,
}));
const tag = (basemap: string) =>
  `<StreetMap title="Halls" basemap="${basemap}" rings={[150]} markers={${JSON.stringify(MARKERS)}} />`;

/** Ready once the map has drawn and a tile has loaded; null until then. */
const READ_PAGE = `(() => {
  const slot = document.querySelector('#editor .mdx-map');
  if (!slot || !slot.dataset.markers || !slot.dataset.basemap) return null;
  const loaded = [...slot.querySelectorAll('.leaflet-tile-loaded')];
  const src = (t) => (t.tagName === 'IMG' ? t : t.querySelector('img'))?.src ?? '';
  const googleTiles = loaded.filter((t) => src(t).startsWith('https://maps.googleapis.com/maps/vt')).length;
  const osmTiles = loaded.filter((t) => src(t).startsWith('https://tile.openstreetmap.org/')).length;
  if (googleTiles + osmTiles === 0) return null;
  // Not yet settled: the map still says Google but shows OpenStreetMap.
  if (slot.dataset.basemap === 'google' && googleTiles === 0) return null;
  const corners = slot.querySelector('.leaflet-control-container')?.textContent ?? '';
  // Google's corners move into the map a moment after its tiles: wait for them.
  if (googleTiles > 0 && !corners.includes(${JSON.stringify(GOOGLE_CREDIT)})) return null;
  const notice = slot.parentElement.querySelector('.mdx-map-fallback');
  return {
    basemap: slot.dataset.basemap,
    markerPaths: slot.querySelectorAll('path.cw-map-marker').length,
    ringPaths: slot.querySelectorAll('path.cw-map-ring').length,
    googleTiles,
    osmTiles,
    notice: notice && !notice.hidden ? notice.textContent : null,
    corners,
    googleScriptTag: !!document.querySelector('script[data-cw-google-maps]'),
    googleGlobal: typeof window.google !== 'undefined',
    width: slot.getBoundingClientRect().width,
  };
})()`;

let browser: { proc: ChildProcess; profile: string } | undefined;

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'google-map-'));
  const servers: ServerHandle[] = [];
  try {
    step('build the doc bundle');
    const appDist = join(dir, 'app');
    const built = spawnSync(
      'bun',
      ['run', join(import.meta.dirname, '..', 'scripts', 'build.ts'), '--outdir', appDist],
      { encoding: 'utf8', timeout: 120_000 },
    );
    if (built.status !== 0) throw new Error(`doc bundle build failed:\n${built.stderr}`);

    const repo = join(dir, 'riverbend');
    mkdirSync(repo);
    spawnSync('git', ['init', '-q'], { cwd: repo });

    /** A server, with a Google doc and an OpenStreetMap doc of its own. */
    const serve = async (name: string, googleMapsKey?: string) => {
      mkdirSync(join(repo, name));
      writeFileSync(join(repo, name, 'google.mdx'), `# Riverbend halls\n\n${tag('google')}\n`);
      writeFileSync(join(repo, name, 'plain.mdx'), `# Saltmarsh halls\n\n${tag('osm')}\n`);
      const handle = createServer({
        port: 0,
        dataDir: join(dir, `data-${name}`),
        markdownAppDistDir: appDist,
        requireSignInToWrite: false,
        ...(googleMapsKey ? { googleMapsKey } : {}),
      });
      servers.push(handle);
      const base = `http://127.0.0.1:${handle.port}`;
      const post = async (path: string, payload: unknown) => {
        const res = await fetch(`${base}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
        return (await res.json()) as Record<string, unknown>;
      };
      const author = { id: 'agent-riverbend', name: 'Riverbend notes', kind: 'agent' };
      const ws = (
        (await post('/workspaces', { name: 'Riverbend', author })) as { workspace: { id: string } }
      ).workspace.id;
      const doc = async (docId: string) =>
        String(
          (
            await post(`/workspaces/${ws}/docs`, {
              docId,
              type: 'markdown',
              sourceUrl: join(repo, name, `${docId}.mdx`),
            })
          ).docId,
        );
      return {
        base,
        google: `${base}/workspaces/${ws}/docs/${await doc('google')}`,
        plain: `${base}/workspaces/${ws}/docs/${await doc('plain')}`,
      };
    };
    const keyed = await serve('keyed', FAKE_KEY);
    const keyless = await serve('keyless');
    const refused = await serve('refused', REFUSED_KEY);
    const unloaded = await serve('unloaded', UNLOADED_KEY);
    const ourBases = [keyed.base, keyless.base, refused.base, unloaded.base];

    const b = await launchChrome(
      resolveChromeBin(undefined),
      (profile) => chromeLaunchArgs({ width: 1180, height: 820 }, profile),
      STARTUP_TIMEOUT_MS,
      `google-map-${process.pid}`,
      (started) => {
        browser = started;
      },
    );
    const cdp = await Cdp.connect(await pageSocketUrl(b.port, STARTUP_TIMEOUT_MS));
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `try { localStorage.setItem('feedback-user-name', 'Alice'); } catch {}`,
    });

    const google = BASEMAPS.google;
    const osm = BASEMAPS.osm;
    if (!google || !osm) throw new Error('missing basemap');
    const ours = new Set(ourBases);
    const png = Buffer.from(tinyPng(232, 256, 256)).toString('base64');
    const js = Buffer.from(FAKE_GOOGLE_MAPS_JS).toString('base64');
    /** The requests of the page now open. */
    let seen = { scriptKeys: [] as string[], google: 0, keys: 0, stray: [] as string[] };
    const fulfil = (requestId: string, type: string, body: string) =>
      cdp.send('Fetch.fulfillRequest', {
        requestId,
        responseCode: 200,
        responseHeaders: [
          { name: 'content-type', value: type },
          { name: 'access-control-allow-origin', value: '*' },
        ],
        body,
      });
    cdp.on('Fetch.requestPaused', (p) => {
      const requestId = String(p.requestId);
      const url = new URL(String((p.request as { url: string }).url));
      if (ours.has(url.origin)) {
        if (url.pathname.includes('/map-key/')) seen.keys++;
        void cdp.send('Fetch.continueRequest', { requestId });
      } else if (basemapAllows(google, url.href)) {
        seen.google++;
        if (url.href.startsWith(`${google.script}?`)) {
          const key = url.searchParams.get('key') ?? '';
          seen.scriptKeys.push(key);
          if (key === UNLOADED_KEY) {
            void cdp.send('Fetch.failRequest', { requestId, errorReason: 'ConnectionFailed' });
          } else {
            void fulfil(requestId, 'text/javascript', js);
          }
        } else if (url.hostname === 'maps.googleapis.com' && url.pathname === '/maps/vt') {
          void fulfil(requestId, 'image/png', png);
        } else {
          seen.stray.push(url.origin);
          void cdp.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
        }
      } else if (basemapAllows(osm, url.href)) {
        void fulfil(requestId, 'image/png', png);
      } else {
        seen.stray.push(url.origin);
        void cdp.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
      }
    });
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });

    const open = async (url: string, width: number, height: number): Promise<PageReading> => {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: false,
      });
      step(`open ${new URL(url).pathname} at ${width}x${height}`);
      seen = { scriptKeys: [], google: 0, keys: 0, stray: [] };
      const loaded = cdp.once('Page.loadEventFired');
      await cdp.send('Page.navigate', { url });
      await loaded;
      const page = (await until(`the map at ${url} drew`, async () =>
        cdp.evaluate(READ_PAGE),
      )) as Omit<PageReading, 'scriptKeys' | 'googleRequests' | 'keyRequests' | 'strayRequests'>;
      return {
        ...page,
        scriptKeys: seen.scriptKeys,
        googleRequests: seen.google,
        keyRequests: seen.keys,
        strayRequests: [...new Set(seen.stray)],
      };
    };
    const reading: GoogleMapReading = {
      wide: await open(keyed.google, 1180, 820),
      narrow: await open(keyed.google, 430, 932),
      plain: await open(keyed.plain, 1180, 820),
      keyless: await open(keyless.google, 1180, 820),
      refused: await open(refused.google, 1180, 820),
      unloaded: await open(unloaded.google, 1180, 820),
    };
    cdp.close();
    process.stdout.write(`\n${JSON.stringify(reading)}\n`);
  } finally {
    if (browser) await stopBrowser(browser.proc, browser.profile);
    for (const s of servers) await s.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

setTimeout(() => {
  step('gave up after 170s');
  const b = browser;
  void (b ? stopBrowser(b.proc, b.profile) : Promise.resolve()).finally(() => process.exit(3));
}, 170_000).unref();
await main();
process.exit(0);
