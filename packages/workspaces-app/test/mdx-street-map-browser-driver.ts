#!/usr/bin/env bun
/**
 * A bound `.mdx` with two `<StreetMap>` tags at the task's scale — 100
 * markers with popups, 150 ft and 300 ft rings around each, 3,000 points in
 * five categories — one with its data inline and one reading a JSON file
 * beside the doc, opened on the real doc page in headless Chromium against a
 * real server and the real doc bundle, at 1180x820 and at 430 wide. A marker
 * is clicked like a reader would, and its popup read back.
 *
 * No request leaves the machine. Every request the page makes to another
 * origin is caught: a tile from the basemap's listed origin is answered with
 * a grey PNG, and anything else is failed and reported, so the test can say
 * the map asked nowhere else.
 *
 * Synthetic data, around invented places. Spawned by
 * `mdx-street-map-browser.test.ts`, which reads the JSON it prints. A second
 * argument names a folder to save a screenshot of each width into.
 *
 * audit: no-text — every value returned comes from the running page.
 */
import { type ChildProcess, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BASEMAPS, DEFAULT_BASEMAP } from '@claude-workspaces/core/map-basemaps';
import { CATEGORY_COLORS } from '@claude-workspaces/core/map-spec';
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

export interface MapReading {
  /** What the slot says it drew. */
  markers: number;
  rings: number;
  points: number;
  /** SVG paths on the page: one per marker, one per ring. */
  markerPaths: number;
  ringPaths: number;
  /** Category colours found painted on the points' canvas, of five. */
  coloursPainted: number;
  /** Whether the canvas shows at the size Leaflet gave it, so painted
   *  pixels are pixels a reader sees. */
  canvasShown: boolean;
  legend: string[];
  framed: boolean;
  /** The map's width against the text column's, and its height. */
  width: number;
  column: number;
  height: number;
}

export interface WidthReading {
  viewport: number;
  inline: MapReading;
  file: MapReading;
}

export interface StreetMapReading {
  wide: WidthReading;
  narrow: WidthReading;
  /** The popup a real click on the first inline marker opened. */
  popup: string;
  /** Whether that click opened the block's source. */
  sourceOpened: boolean;
  tileRequests: number;
  /** Requests to any origin that is neither the server nor the basemap's. */
  strayRequests: string[];
}

const step = (what: string): void => {
  process.stderr.write(`[street-map-driver] ${what}\n`);
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

const CATEGORIES = ['Noise', 'Litter', 'Graffiti', 'Lighting', 'Potholes'];
const PLACES = ['Harborlight', 'Riverbend', 'Saltmarsh'];

/** A seeded generator, so every run draws the same synthetic city. */
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function syntheticData() {
  const rnd = seeded(7);
  const lat0 = 37.76;
  const lng0 = -122.44;
  const round = (n: number) => Math.round(n * 1e5) / 1e5;
  const markers = Array.from({ length: 100 }, (_, i) => ({
    lat: round(lat0 + rnd() * 0.04),
    lng: round(lng0 + rnd() * 0.05),
    label: `${PLACES[i % 3]} hall ${i + 1}`,
    popup: `${PLACES[i % 3]} hall ${i + 1}: ${Math.floor(rnd() * 40)} reports`,
  }));
  const points = Array.from({ length: 3_000 }, (_, i) => ({
    lat: round(lat0 + rnd() * 0.04),
    lng: round(lng0 + rnd() * 0.05),
    category: CATEGORIES[i % CATEGORIES.length],
  }));
  return { markers, points };
}

const READ_MAP = (which: string) => `(() => {
  const maps = [...document.querySelectorAll('#editor .mdx-map')];
  const slot = maps[${which === 'inline' ? 0 : 1}];
  if (!slot || !slot.dataset.markers) return null;
  const tiles = slot.querySelectorAll('img.leaflet-tile-loaded');
  if (tiles.length === 0) return null;
  const canvas = slot.querySelector('canvas');
  const want = ${JSON.stringify(CATEGORY_COLORS.slice(0, 5))}.map((h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)));
  let coloursPainted = 0;
  if (canvas) {
    const px = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    const hits = want.map(() => 0);
    for (let i = 0; i < px.length; i += 4) {
      if (px[i + 3] === 0) continue;
      want.forEach((c, k) => {
        if (Math.abs(px[i] - c[0]) + Math.abs(px[i + 1] - c[1]) + Math.abs(px[i + 2] - c[2]) < 12) hits[k]++;
      });
    }
    coloursPainted = hits.filter((n) => n >= 20).length;
  }
  // Leaflet paints its canvas on the next frame: read again until it has.
  if (Number(slot.dataset.points) > 0 && coloursPainted === 0) return null;
  const col = slot.closest('.ProseMirror');
  const cs = getComputedStyle(col);
  const block = slot.closest('.mdx-view');
  return {
    markers: Number(slot.dataset.markers),
    rings: Number(slot.dataset.rings),
    points: Number(slot.dataset.points),
    markerPaths: slot.querySelectorAll('path.cw-map-marker').length,
    ringPaths: slot.querySelectorAll('path.cw-map-ring').length,
    coloursPainted,
    canvasShown: !!canvas && Math.abs(canvas.getBoundingClientRect().width - canvas.width) < 2,
    legend: [...(block?.querySelectorAll('.mdx-map-legend li') ?? [])].map((li) => li.textContent),
    framed: !!slot.closest('iframe') || !!block?.querySelector('iframe'),
    width: slot.getBoundingClientRect().width,
    column: col.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight),
    height: slot.getBoundingClientRect().height,
  };
})()`;

let browser: { proc: ChildProcess; profile: string } | undefined;

async function main(): Promise<void> {
  const shots = process.argv[2];
  const dir = mkdtempSync(join(tmpdir(), 'street-map-'));
  let handle: ServerHandle | undefined;
  try {
    step('build the doc bundle');
    const appDist = join(dir, 'app');
    const built = spawnSync(
      'bun',
      ['run', join(import.meta.dirname, '..', 'scripts', 'build.ts'), '--outdir', appDist],
      { encoding: 'utf8', timeout: 120_000 },
    );
    if (built.status !== 0) throw new Error(`doc bundle build failed:\n${built.stderr}`);

    const { markers, points } = syntheticData();
    const repo = join(dir, 'harborlight');
    mkdirSync(join(repo, 'data'), { recursive: true });
    spawnSync('git', ['init', '-q'], { cwd: repo });
    writeFileSync(join(repo, 'data', 'reports.json'), JSON.stringify({ markers, points }));
    const doc = [
      '# Harborlight reports',
      '',
      `<StreetMap title="Inline" rings={[150, 300]} markers={${JSON.stringify(markers)}} points={${JSON.stringify(points)}} />`,
      '',
      'Riverbend notes between the maps.',
      '',
      '<StreetMap title="From a file" src="data/reports.json" rings={[150, 300]} height={420} />',
      '',
    ].join('\n');
    writeFileSync(join(repo, 'reports.mdx'), doc);

    handle = createServer({
      port: 0,
      dataDir: join(dir, 'data'),
      markdownAppDistDir: appDist,
      requireSignInToWrite: false,
    });
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
    const author = { id: 'agent-harborlight', name: 'Harborlight notes', kind: 'agent' };
    const ws = (
      (await post('/workspaces', { name: 'Harborlight', author })) as { workspace: { id: string } }
    ).workspace.id;
    const docId = String(
      (
        await post(`/workspaces/${ws}/docs`, {
          docId: 'reports',
          type: 'markdown',
          sourceUrl: join(repo, 'reports.mdx'),
        })
      ).docId,
    );

    const b = await launchChrome(
      resolveChromeBin(undefined),
      (profile) => chromeLaunchArgs({ width: 1180, height: 820 }, profile),
      STARTUP_TIMEOUT_MS,
      `street-map-${process.pid}`,
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

    // Every request to another origin stops here.
    const tileOrigins = BASEMAPS[DEFAULT_BASEMAP]?.origins ?? [];
    const tile = Buffer.from(tinyPng(232, 256, 256)).toString('base64');
    let tileRequests = 0;
    const strayRequests: string[] = [];
    cdp.on('Fetch.requestPaused', (p) => {
      const requestId = String(p.requestId);
      const url = String((p.request as { url: string }).url);
      const origin = new URL(url).origin;
      if (origin === base) {
        void cdp.send('Fetch.continueRequest', { requestId });
      } else if (tileOrigins.includes(origin)) {
        tileRequests++;
        void cdp.send('Fetch.fulfillRequest', {
          requestId,
          responseCode: 200,
          responseHeaders: [
            { name: 'content-type', value: 'image/png' },
            { name: 'access-control-allow-origin', value: '*' },
          ],
          body: tile,
        });
      } else {
        strayRequests.push(origin);
        void cdp.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
      }
    });
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });

    const url = `${base}/workspaces/${ws}/docs/${docId}`;
    const readAt = async (width: number, height: number): Promise<WidthReading> => {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: false,
      });
      step(`open the doc at ${width}x${height}`);
      const loaded = cdp.once('Page.loadEventFired');
      await cdp.send('Page.navigate', { url });
      await loaded;
      const inline = (await until(`the inline map drew at ${width}`, async () =>
        cdp.evaluate(READ_MAP('inline')),
      )) as MapReading;
      const file = (await until(`the file map drew at ${width}`, async () =>
        cdp.evaluate(READ_MAP('file')),
      )) as MapReading;
      if (shots) {
        mkdirSync(shots, { recursive: true });
        await cdp.evaluate(
          `document.querySelector('#editor .mdx-map').scrollIntoView({ block: 'center' })`,
        );
        await sleep(300);
        const shot = (await cdp.send('Page.captureScreenshot', { format: 'png' })) as {
          data: string;
        };
        writeFileSync(join(shots, `street-map-${width}.png`), Buffer.from(shot.data, 'base64'));
      }
      return { viewport: width, inline, file };
    };
    const narrow = await readAt(430, 932);
    const wide = await readAt(1180, 820);

    step('click the first marker');
    await cdp.evaluate(
      `document.querySelector('#editor .mdx-map path.cw-map-marker').scrollIntoView({ block: 'center', behavior: 'instant' })`,
    );
    // The doc may still be scrolling or settling: click where the marker
    // stands once two reads agree.
    let last = '';
    const at = (await until('the marker to stand still', async () => {
      const r = (await cdp.evaluate(`(() => {
        const r = document.querySelector('#editor .mdx-map path.cw-map-marker').getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      })()`)) as { x: number; y: number };
      const key = JSON.stringify(r);
      const still = key === last;
      last = key;
      if (!still) await sleep(150);
      return still ? r : null;
    })) as { x: number; y: number };
    for (const type of ['mousePressed', 'mouseReleased']) {
      await cdp.send('Input.dispatchMouseEvent', {
        type,
        x: at.x,
        y: at.y,
        button: 'left',
        clickCount: 1,
      });
    }
    const popup = (await until('the marker popup', async () =>
      cdp.evaluate(`document.querySelector('#editor .cw-map-popup')?.textContent ?? null`),
    )) as string;
    const sourceOpened = (await cdp.evaluate(
      `document.querySelector('#editor .mdx-block')?.classList.contains('is-open') ?? false`,
    )) as boolean;
    cdp.close();
    const reading: StreetMapReading = {
      wide,
      narrow,
      popup,
      sourceOpened,
      tileRequests,
      strayRequests: [...new Set(strayRequests)],
    };
    process.stdout.write(`\n${JSON.stringify(reading)}\n`);
  } finally {
    if (browser) await stopBrowser(browser.proc, browser.profile);
    await handle?.stop();
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
