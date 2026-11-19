/**
 * The components package's map runs in a board doc with live state: a bound
 * `.mdx` whose repository holds the unpacked tarball draws the map on the
 * real doc page from the tag's props, and a state write from another client
 * on the doc's socket redraws the open page with no reload. The write-to-page
 * time is printed for the report. The off-board halves are
 * `packages/components/test/static-page-browser.test.ts` and
 * `templates/astro-chart/test/astro-map.test.ts`.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
import type { ComponentsMapDocReading } from './components-map-doc-browser-driver.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

const SUITE_MS = 200_000;
const SPAWN_MS = 180_000;
const CASE_MS = 60_000;

let r: ComponentsMapDocReading;

describe.skipIf(CHROME === null)('the components map in a board doc', () => {
  beforeAll(() => {
    const run = spawnSync(
      'bun',
      [join(import.meta.dirname, 'components-map-doc-browser-driver.ts')],
      { encoding: 'utf8', timeout: SPAWN_MS },
    );
    expect(run.status, run.stderr).toBe(0);
    r = JSON.parse(run.stdout.trim().split('\n').at(-1) ?? '') as ComponentsMapDocReading;
    console.log(`[components map state write-to-page, browser] ${r.writeToPageMs} ms`);
  }, SUITE_MS);

  it(
    "draws the map from the tag's props on OpenStreetMap, styled",
    () => {
      expect(r.first).toMatchObject({
        markers: 2,
        rings: 2,
        markerPaths: 2,
        basemap: 'osm',
        title: 'Harborlight sites',
        legend: ['Library', 'School', '150 ft'],
        styled: true,
      });
      expect(r.first.tilesLoaded).toBeGreaterThan(0);
    },
    CASE_MS,
  );

  it(
    'redraws the open page when another client writes its state',
    () => {
      expect(r.afterWrite).toMatchObject({
        markers: 3,
        markerPaths: 3,
        title: 'Harborlight sites, Saltmarsh added',
      });
    },
    CASE_MS,
  );

  it(
    'asks no origin but the server and the tile server',
    () => {
      expect(r.tileRequests).toBeGreaterThan(0);
      expect(r.stray).toEqual([]);
    },
    CASE_MS,
  );
});
