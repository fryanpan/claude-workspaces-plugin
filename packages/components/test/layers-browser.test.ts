// @vitest-environment node
/**
 * The map's GeoJSON layers on a plain static page, from the packed tarball,
 * in headless Chromium at 1180x820. A reader's tap on the canvas opens the
 * popup of the topmost layer under it, filled from that feature's
 * properties; switching that layer off sends the same tap to the layer
 * beneath; a layer named by `url` is fetched from the page's own origin and
 * drawn; and the heatmap colours its canvas along its ramp, hottest where
 * the points crowd.
 *
 * A second page draws a load at SF Works' scale (20,000 lines, 18,523
 * heatmap points) and the case reads that it drew all of it and that the
 * page still answers. The time it took is printed for the PR, not asserted.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
import { type MapPage, mapPage, serveDir, until } from './map-page-harness.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

const SUITE_MS = 180_000;
const CASE_MS = 60_000;

const CENTER = [37.76, -122.44];

/** A slow street on the page's own origin, fetched by `url`. */
const HARBORLIGHT_SLOW = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: [
          [-122.45, 37.75],
          [-122.45, 37.77],
        ],
      },
      properties: { name: 'Harborlight slow street' },
    },
  ],
};

const IMPORT = `import mount from './node_modules/@claude-workspaces/components/lib/map.js';`;

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>Riverbend layers</title></head>
<body style="margin: 0 16px">
  <div id="map"></div>
  <script type="module">
    ${IMPORT}
    const square = (lng, lat, d) => [[[lng, lat], [lng + d, lat], [lng + d, lat + d], [lng, lat + d], [lng, lat]]];
    const reports = [];
    // A crowd of reports north-east of the centre, and a few strays.
    for (let i = 0; i < 300; i++) reports.push([-122.43 + (i % 10) * 0.0001, 37.765 + Math.floor(i / 10) * 0.0001, 2]);
    for (let i = 0; i < 20; i++) reports.push([-122.455 + i * 0.001, 37.752, 1]);
    mount(document.getElementById('map'), {
      center: ${JSON.stringify(CENTER)},
      zoom: 14,
      height: 420,
      layers: [
        { type: 'heatmap', id: 'reports', name: 'Harborlight reports', weight: 'count',
          colors: ['#0000ff', '#ff0000'], radius: 20,
          data: { type: 'FeatureCollection', features: reports.map(([lng, lat, count]) => ({
            type: 'Feature', geometry: { type: 'Point', coordinates: [lng, lat] }, properties: { count } })) } },
        { type: 'polygon', id: 'quarters', name: 'Saltmarsh quarter', fill: '#a463f2', fillOpacity: 0.3,
          popup: 'Quarter: {name}',
          data: { type: 'Feature', geometry: { type: 'Polygon', coordinates: square(-122.47, 37.74, 0.04) },
                  properties: { name: 'Saltmarsh' } } },
        { type: 'line', id: 'paths', name: 'Riverbend paths', color: '#ff725c', width: 8, dash: [8, 4],
          popup: '{name}: {speed} mph',
          data: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: [[-122.46, 37.76], [-122.42, 37.76]] },
                   properties: { name: 'Riverbend Ave', speed: 20 } }] },
        { type: 'line', id: 'slow', name: 'Slow streets', url: './harborlight-slow.geojson', color: '#3ca951' },
      ],
    });
  </script>
</body></html>
`;

const BIG = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>Riverbend at scale</title></head>
<body style="margin: 0 16px">
  <div id="map"></div>
  <script type="module">
    ${IMPORT}
    const lines = [];
    for (let i = 0; i < 20000; i++) {
      const lng = -122.52 + (i % 200) * 0.0007, lat = 37.70 + Math.floor(i / 200) * 0.0012;
      lines.push({ type: 'Feature', properties: { name: 'Riverbend ' + i },
        geometry: { type: 'LineString', coordinates: [[lng, lat], [lng + 0.0002, lat + 0.0003], [lng + 0.0004, lat], [lng + 0.0006, lat + 0.0003], [lng + 0.0007, lat]] } });
    }
    const crashes = [];
    for (let i = 0; i < 18523; i++) {
      crashes.push({ type: 'Feature', properties: {},
        geometry: { type: 'Point', coordinates: [-122.52 + ((i * 7919) % 1400) * 0.0001, 37.70 + ((i * 104729) % 1200) * 0.0001] } });
    }
    // The longest task the page ran from the mount on: what a reader feels
    // as the page stopping.
    window.longest = 0;
    let t0 = Infinity;
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) if (e.startTime + e.duration >= t0) window.longest = Math.max(window.longest, e.duration);
    }).observe({ type: 'longtask', buffered: true });
    setTimeout(() => {
      t0 = performance.now();
      const el = document.getElementById('map');
      mount(el, {
        height: 420,
        layers: [
          { type: 'heatmap', name: 'Harborlight crashes', data: { type: 'FeatureCollection', features: crashes } },
          { type: 'line', name: 'Riverbend network', popup: '{name}', data: { type: 'FeatureCollection', features: lines } },
        ],
      });
      const done = () => el.querySelector('.cw-map-slot').dataset.layers === '2'
        ? (window.drawnMs = performance.now() - t0) : requestAnimationFrame(done);
      done();
    }, 0);
  </script>
</body></html>
`;

interface Layers {
  rows: Array<{ id: string; state: string; features: number }>;
  heatCells: number;
}

const readLayers = `(() => {
  const slot = document.querySelector('#map .cw-map-slot');
  if (!slot || !slot.dataset.layers || !slot.querySelector('img.leaflet-tile-loaded')) return null;
  return {
    rows: [...document.querySelectorAll('#map .cw-map-layers li')].map((li) => ({
      id: li.dataset.layer, state: li.dataset.state, features: Number(li.dataset.features) })),
    heatCells: Number(slot.dataset.heatCells),
  };
})()`;

/** The heatmap canvas: its pane, its painted pixels, and the colour of
 *  its most opaque pixel. */
const readHeat = `(() => {
  const c = document.querySelector('#map canvas.cw-map-heat');
  if (!c) return null;
  const px = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let painted = 0, best = -1, rgb = [0, 0, 0];
  for (let i = 3; i < px.length; i += 4) {
    if (px[i] === 0) continue;
    painted++;
    if (px[i] > best) { best = px[i]; rgb = [px[i - 3], px[i - 2], px[i - 1]]; }
  }
  return { pane: c.parentElement.className, painted, hottest: rgb, pointerEvents: getComputedStyle(c).pointerEvents };
})()`;

let dir = '';
let site: Awaited<ReturnType<typeof serveDir>> | undefined;
let page: MapPage | undefined;
let layers: Layers;
let heat: { pane: string; painted: number; hottest: number[]; pointerEvents: string };
const taps: Record<string, string> = {};
let heatAfterOff: unknown;
let big: Layers & { answered: boolean; drawnMs: number; longest: number };

/** Tap the page at `(x, y)` as a reader's mouse would, and return the
 *  popup's words once one opens. */
async function tap(p: MapPage, x: number, y: number): Promise<string> {
  await p.cdp.evaluate(`document.querySelector('#map .leaflet-popup-close-button')?.click()`);
  await until(
    'the popup to close',
    async () =>
      (await p.cdp.evaluate(`document.querySelector('#map .cw-map-popup') ? null : true`)) as
        | true
        | null,
  );
  for (const type of ['mousePressed', 'mouseReleased'] as const) {
    await p.cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
  }
  return until('a popup', async () => {
    const words = await p.cdp.evaluate(
      `document.querySelector('#map .cw-map-popup')?.textContent ?? null`,
    );
    return typeof words === 'string' ? words : null;
  });
}

describe.skipIf(CHROME === null)('GeoJSON layers on a static page from the packed tarball', () => {
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'components-layers-'));
    const packed = spawnSync('bun', [join(import.meta.dirname, '..', 'scripts', 'pack.ts'), dir], {
      encoding: 'utf8',
      timeout: 90_000,
    });
    if (packed.status !== 0) throw new Error(`pack failed:\n${packed.stderr}`);
    const tarball = packed.stdout.trim().split('\n').at(-1) ?? '';
    const root = join(dir, 'site');
    mkdirSync(root);
    copyFileSync(tarball, join(root, basename(tarball)));
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'riverbend-site',
        private: true,
        dependencies: { '@claude-workspaces/components': `file:./${basename(tarball)}` },
      }),
    );
    const install = spawnSync('bun', ['install', '--ignore-scripts'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 60_000,
    });
    if (install.status !== 0) throw new Error(`install failed:\n${install.stderr}`);
    writeFileSync(join(root, 'harborlight-slow.geojson'), JSON.stringify(HARBORLIGHT_SLOW));
    writeFileSync(join(root, 'index.html'), PAGE);
    writeFileSync(join(root, 'big.html'), BIG);

    site = await serveDir(root);
    const p = await mapPage(CHROME as string, site.origin, 'components-layers');
    page = p;
    await p.open(`${site.origin}/`, 1180, 820);
    layers = await until('the layers drew', async () => {
      const r = (await p.cdp.evaluate(readLayers)) as Layers | null;
      return r?.rows.every((row) => row.state === 'drawn') && r.heatCells > 0 ? r : null;
    });
    heat = await until('the heatmap painted', async () => {
      const h = (await p.cdp.evaluate(readHeat)) as typeof heat | null;
      return h && h.painted > 0 ? h : null;
    });

    const box = (await p.cdp.evaluate(`(() => {
      const r = document.querySelector('#map .cw-map-slot').getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`)) as { x: number; y: number };
    taps.onLine = await tap(p, box.x, box.y);
    taps.offLine = await tap(p, box.x, box.y + 60);
    // The quarter switched off and on goes back beneath the paths.
    const flip = (id: string) =>
      p.cdp.evaluate(
        `document.querySelector('#map .cw-map-layers li[data-layer="${id}"] input').click()`,
      );
    await flip('quarters');
    await flip('quarters');
    taps.quarterBack = await tap(p, box.x, box.y);
    await p.cdp.evaluate(
      `document.querySelector('#map .cw-map-layers li[data-layer="paths"] input').click()`,
    );
    taps.lineOff = await tap(p, box.x, box.y);
    await p.cdp.evaluate(
      `document.querySelector('#map .cw-map-layers li[data-layer="reports"] input').click()`,
    );
    heatAfterOff = await p.cdp.evaluate(readHeat);

    await p.open(`${site.origin}/big.html`, 1180, 820);
    const drawn = await until('the big page drew', async () => {
      const r = (await p.cdp.evaluate(readLayers)) as Layers | null;
      return r && r.rows.length === 2 && r.rows.every((row) => row.state === 'drawn') ? r : null;
    });
    // A zoom redraws every path and the heatmap; the page must come back.
    await p.cdp.evaluate(`document.querySelector('#map .leaflet-control-zoom-in').click()`);
    const answered = await until('the page to answer after a zoom', async () =>
      (await p.cdp.evaluate('new Promise((r) => requestAnimationFrame(() => r(true)))')) === true
        ? true
        : null,
    );
    const timing = (await p.cdp.evaluate(
      '({ drawnMs: window.drawnMs, longest: window.longest })',
    )) as {
      drawnMs: number;
      longest: number;
    };
    big = { ...drawn, answered, ...timing };
    process.stderr.write(
      `[layers-browser] 20,000 lines + 18,523 heat points: drawn ${Math.round(timing.drawnMs)} ms after mount, longest task ${Math.round(timing.longest)} ms\n`,
    );
  }, SUITE_MS);

  afterAll(async () => {
    await page?.close();
    await site?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it(
    'draws every layer, the url one fetched from the page, with a switch each in declared order',
    () => {
      expect(layers.rows).toEqual([
        { id: 'reports', state: 'drawn', features: 320 },
        { id: 'quarters', state: 'drawn', features: 1 },
        { id: 'paths', state: 'drawn', features: 1 },
        { id: 'slow', state: 'drawn', features: 1 },
      ]);
      expect(page?.stray).toEqual([]);
    },
    CASE_MS,
  );

  it(
    "opens the topmost layer's popup from the feature's properties, keeps declared order through a switch, and reaches the layer beneath once that layer is off",
    () => {
      expect(taps.onLine).toBe('Riverbend Ave: 20 mph');
      expect(taps.offLine).toBe('Quarter: Saltmarsh');
      expect(taps.quarterBack).toBe('Riverbend Ave: 20 mph');
      expect(taps.lineOff).toBe('Quarter: Saltmarsh');
    },
    CASE_MS,
  );

  it(
    'colours the heatmap along its ramp, hottest where the reports crowd, beneath the paths and out of the way of taps',
    () => {
      expect(heat.pane).toContain('leaflet-cw-heat-below-pane');
      expect(heat.pointerEvents).toBe('none');
      const [r = 0, g = 0, b = 0] = heat.hottest;
      // The ramp runs blue to red: the most opaque pixel is the red end.
      expect(r).toBeGreaterThan(200);
      expect(b).toBeLessThan(60);
      expect(g).toBeLessThan(60);
      expect(heatAfterOff).toBeNull();
    },
    CASE_MS,
  );

  it(
    "draws a load at SF Works' scale and the page still answers",
    () => {
      expect(big.rows.map((r) => r.features)).toEqual([18_523, 20_000]);
      expect(big.heatCells).toBeGreaterThan(0);
      expect(big.answered).toBe(true);
    },
    CASE_MS,
  );
});
