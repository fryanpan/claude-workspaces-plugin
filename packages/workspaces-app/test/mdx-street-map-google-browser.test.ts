/**
 * A `<StreetMap basemap="google">` on the real doc page draws on Google's map
 * with the key the server handed that doc, keeps its markers, rings and
 * Google's credit, and asks Google for nothing it does not list; a doc whose
 * map is on OpenStreetMap asks neither the server for the key nor Google for
 * anything; and on a server with no key the Google map draws on
 * OpenStreetMap and says so. Google's script and tiles are stubbed with a
 * fake key, by `mdx-street-map-google-browser-driver.ts`.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
import { FAKE_KEY, GOOGLE_CREDIT, REFUSED_KEY, UNLOADED_KEY } from './fake-google-maps.ts';
import type { GoogleMapReading, PageReading } from './mdx-street-map-google-browser-driver.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

const SUITE_MS = 200_000;
const SPAWN_MS = 180_000;
const CASE_MS = 60_000;

let r: GoogleMapReading;

describe.skipIf(CHROME === null)('a StreetMap on the google basemap', () => {
  beforeAll(() => {
    const run = spawnSync(
      'bun',
      [join(import.meta.dirname, 'mdx-street-map-google-browser-driver.ts')],
      { encoding: 'utf8', timeout: SPAWN_MS },
    );
    expect(run.status, run.stderr).toBe(0);
    r = JSON.parse(run.stdout.trim().split('\n').at(-1) ?? '') as GoogleMapReading;
  }, SUITE_MS);

  it(
    'draws on Google’s tiles with the server’s key, at 1180 and at 430',
    () => {
      for (const page of [r.wide, r.narrow] as PageReading[]) {
        expect(page.basemap).toBe('google');
        expect(page.scriptKeys).toEqual([FAKE_KEY]);
        expect(page.keyRequests).toBe(1);
        expect(page.googleTiles).toBeGreaterThan(0);
        expect(page.osmTiles).toBe(0);
        expect({ markers: page.markerPaths, rings: page.ringPaths }).toEqual({
          markers: 12,
          rings: 12,
        });
        expect(page.corners).toContain(GOOGLE_CREDIT);
        expect(page.notice).toBeNull();
      }
      expect(r.narrow.width).toBeLessThan(430);
    },
    CASE_MS,
  );

  it(
    'asks Google only for what its basemap lists, and nowhere else',
    () => {
      for (const page of [r.wide, r.narrow, r.plain, r.keyless, r.refused, r.unloaded]) {
        expect(page.strayRequests).toEqual([]);
      }
      expect(r.wide.googleRequests).toBeGreaterThan(1);
    },
    CASE_MS,
  );

  it(
    'gives a doc whose map is on OpenStreetMap no key and no Google script',
    () => {
      expect(r.plain.basemap).toBe('osm');
      expect(r.plain.osmTiles).toBeGreaterThan(0);
      expect(r.plain.keyRequests).toBe(0);
      expect(r.plain.googleRequests).toBe(0);
      expect(r.plain.googleScriptTag).toBe(false);
      expect(r.plain.googleGlobal).toBe(false);
    },
    CASE_MS,
  );

  it(
    'falls back to OpenStreetMap and says so on a server with no key',
    () => {
      expect(r.keyless.basemap).toBe('osm');
      expect(r.keyless.osmTiles).toBeGreaterThan(0);
      expect(r.keyless.googleRequests).toBe(0);
      expect(r.keyless.googleScriptTag).toBe(false);
      expect(r.keyless.notice).toBe(
        'Google Maps is not set up on this server, so this map is drawn on OpenStreetMap.',
      );
      expect(r.keyless.corners).toContain('OpenStreetMap');
    },
    CASE_MS,
  );

  it(
    'falls back to OpenStreetMap and says so when Google refuses the key',
    () => {
      expect(r.refused.scriptKeys).toEqual([REFUSED_KEY]);
      expect(r.refused.basemap).toBe('osm');
      expect(r.refused.osmTiles).toBeGreaterThan(0);
      expect(r.refused.googleTiles).toBe(0);
      expect(r.refused.notice).toBe(
        "Google Maps refused this server's key, so this map is drawn on OpenStreetMap.",
      );
      expect(r.refused.markerPaths).toBe(12);
    },
    CASE_MS,
  );

  it(
    'falls back to OpenStreetMap and says so when Google’s script does not load',
    () => {
      expect(r.unloaded.scriptKeys).toEqual([UNLOADED_KEY]);
      expect(r.unloaded.basemap).toBe('osm');
      expect(r.unloaded.osmTiles).toBeGreaterThan(0);
      expect(r.unloaded.googleScriptTag).toBe(false);
      expect(r.unloaded.notice).toBe(
        'Google Maps did not load, so this map is drawn on OpenStreetMap.',
      );
      expect(r.unloaded.markerPaths).toBe(12);
    },
    CASE_MS,
  );
});
