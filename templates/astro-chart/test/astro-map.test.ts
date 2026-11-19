/**
 * The components package's map runs on an Astro page unchanged: this
 * fixture's `src/pages/map.astro` imports `packages/components/src/map.ts`,
 * the file the package compiles, and mounts it over a JSON snapshot of its
 * state. Built with Astro and opened in headless Chromium, the page shows the
 * snapshot's markers and title over the props the page wrote, on
 * OpenStreetMap with every tile answered locally. The doc half is
 * `packages/workspaces-app/test/components-map-doc-browser.test.ts`.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type MapPage,
  type MapReading,
  mapPage,
  serveDir,
  until,
} from '../../../packages/components/test/map-page-harness.ts';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

const FIXTURE = join(import.meta.dirname, '..');
const SUITE_MS = 180_000;
const CASE_MS = 60_000;

let dir = '';
let site: Awaited<ReturnType<typeof serveDir>> | undefined;
let page: MapPage | undefined;
let reading: MapReading;

describe.skipIf(CHROME === null)('the components map on an Astro page', () => {
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'astro-map-'));
    const out = join(dir, 'dist');
    // Built with bun, as astro-page.test.ts explains.
    const built = spawnSync(
      'bun',
      [join(FIXTURE, 'node_modules', 'astro', 'bin', 'astro.mjs'), 'build', '--outDir', out],
      {
        cwd: FIXTURE,
        encoding: 'utf8',
        timeout: 120_000,
        env: { ...process.env, ASTRO_TELEMETRY_DISABLED: '1' },
      },
    );
    expect(built.status, `${built.stdout}\n${built.stderr}`).toBe(0);

    site = await serveDir(out);
    page = await mapPage(CHROME as string, site.origin, 'astro-map');
    await page.open(`${site.origin}/map/`, 1180, 820);
    reading = await until('the map drew on the Astro page', async () => {
      return (await page?.read('#sites')) ?? null;
    });
  }, SUITE_MS);

  afterAll(async () => {
    await page?.close();
    await site?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it(
    "draws the snapshot's markers and title over the page's props",
    () => {
      expect(reading).toMatchObject({
        markers: 3,
        rings: 3,
        markerPaths: 3,
        basemap: 'osm',
        title: "Harborlight sites, from the doc's state",
        legend: ['Library', 'School', '150 ft'],
        styled: true,
      });
      expect(reading.tilesLoaded).toBeGreaterThan(0);
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
