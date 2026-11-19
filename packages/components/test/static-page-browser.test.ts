// @vitest-environment node
/**
 * The map on a plain static page, with no Workspaces server anywhere: the
 * package is packed into its tarball, the tarball installed into a fresh
 * folder with `bun install`, and a hand-written HTML page with no bundler
 * imports `lib/map.js` from `node_modules` and mounts the map over a JSON
 * snapshot of its state. Opened in headless Chromium at 1180x820 and at 430
 * wide, it draws the snapshot's markers on OpenStreetMap; a write through the
 * snapshot's hook redraws it; and the page asks no origin but its own and
 * the (locally answered) tile server.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
import { type MapPage, type MapReading, mapPage, serveDir, until } from './map-page-harness.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

const SUITE_MS = 180_000;
const CASE_MS = 60_000;

const SNAPSHOT = {
  title: 'Harborlight sites, from the snapshot',
  markers: [
    { lat: 37.761, lng: -122.441, label: 'Harborlight hall', category: 'Library' },
    { lat: 37.772, lng: -122.432, label: 'Riverbend school', category: 'School' },
    { lat: 37.755, lng: -122.45, label: 'Saltmarsh pier', category: 'Library' },
  ],
};

const PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Harborlight map</title>
  </head>
  <body style="margin: 0 16px">
    <h1>Harborlight</h1>
    <div id="map"></div>
    <script type="module">
      import mount from './node_modules/@claude-workspaces/components/lib/map.js';
      import { snapshotState } from './node_modules/@claude-workspaces/components/lib/index.js';
      const snapshot = await (await fetch('./map-state.json')).json();
      const state = snapshotState(snapshot, { id: 'map' });
      window.mapState = state;
      mount(document.getElementById('map'), {
        id: 'map',
        title: 'Harborlight sites',
        markers: [{ lat: 37.761, lng: -122.441, label: 'Harborlight hall' }],
        rings: [150],
        height: 360,
      }, state);
    </script>
  </body>
</html>
`;

let dir = '';
let site: Awaited<ReturnType<typeof serveDir>> | undefined;
let page: MapPage | undefined;
let wide: MapReading;
let narrow: MapReading;
let afterWrite: MapReading;
let popup: string;
let installed = '';

describe.skipIf(CHROME === null)('the map on a static page from the packed tarball', () => {
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'components-static-'));
    const packed = spawnSync('bun', [join(import.meta.dirname, '..', 'scripts', 'pack.ts'), dir], {
      encoding: 'utf8',
      timeout: 90_000,
    });
    if (packed.status !== 0) throw new Error(`pack failed:\n${packed.stderr}`);
    const tarball = packed.stdout.trim().split('\n').at(-1) ?? '';

    const root = join(dir, 'site');
    spawnSync('mkdir', [root]);
    copyFileSync(tarball, join(root, basename(tarball)));
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'harborlight-site',
        private: true,
        dependencies: { '@claude-workspaces/components': `file:./${basename(tarball)}` },
      }),
    );
    // The tarball names no dependency, so this reads nothing but the file.
    const install = spawnSync('bun', ['install', '--ignore-scripts'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 60_000,
    });
    if (install.status !== 0) throw new Error(`install failed:\n${install.stderr}`);
    installed = install.stdout + install.stderr;
    writeFileSync(join(root, 'map-state.json'), JSON.stringify(SNAPSHOT));
    writeFileSync(join(root, 'index.html'), PAGE);

    site = await serveDir(root);
    page = await mapPage(CHROME as string, site.origin, 'components-static');
    const read = async () => (await page?.read('#map')) ?? null;

    await page.open(`${site.origin}/`, 1180, 820);
    wide = await until('the map drew at 1180', read);
    // A real click on the first marker, as a reader would.
    popup = String(
      await page.cdp.evaluate(`(() => {
        const path = document.querySelector('#map path.cw-map-marker');
        path.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 1, clientY: 1 }));
        return document.querySelector('.cw-map-popup')?.textContent ?? '';
      })()`),
    );
    await page.cdp.evaluate(
      `window.mapState.push('markers', { lat: 37.75, lng: -122.43, label: 'Bob\\'s dock' })`,
    );
    afterWrite = await until('the written marker on the page', async () => {
      const r = await read();
      return r && r.markers === 4 ? r : null;
    });

    await page.open(`${site.origin}/`, 430, 932);
    narrow = await until('the map drew at 430', read);
  }, SUITE_MS);

  afterAll(async () => {
    await page?.close();
    await site?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it(
    'installs from the tarball alone',
    () => {
      expect(installed).toContain('@claude-workspaces/components');
    },
    CASE_MS,
  );

  it(
    "draws the snapshot's markers and title over the page's props, on OpenStreetMap",
    () => {
      expect(wide).toMatchObject({
        markers: 3,
        rings: 3,
        markerPaths: 3,
        basemap: 'osm',
        title: 'Harborlight sites, from the snapshot',
        legend: ['Library', 'School', '150 ft'],
        styled: true,
      });
      expect(wide.tilesLoaded).toBeGreaterThan(0);
      expect(popup).toBe('Harborlight hall');
    },
    CASE_MS,
  );

  it(
    'redraws when the page writes the state',
    () => {
      expect(afterWrite.markers).toBe(4);
      expect(afterWrite.markerPaths).toBe(4);
    },
    CASE_MS,
  );

  it(
    'fits a 430-wide phone',
    () => {
      expect(narrow.markers).toBe(3);
      expect(narrow.width).toBeLessThanOrEqual(narrow.viewport);
      expect(narrow.width).toBeGreaterThan(300);
    },
    CASE_MS,
  );

  it(
    'asks no origin but its own and the tile server',
    () => {
      expect(page?.tileRequests()).toBeGreaterThan(0);
      expect(page?.stray).toEqual([]);
    },
    CASE_MS,
  );
});
