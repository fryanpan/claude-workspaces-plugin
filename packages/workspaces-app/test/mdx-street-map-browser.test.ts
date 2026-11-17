/**
 * A `<StreetMap>` in a bound `.mdx` draws in the real doc page, not in a
 * frame, at the task's scale: 100 markers with popups, 150 ft and 300 ft
 * rings around each, 3,000 points in five category colours and a legend,
 * once from inline JSON and once from a JSON file beside the doc, at
 * 1180x820 and at 430 wide. A real click on a marker opens its popup, and
 * the page asks no origin but the server and the basemap's listed one.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
import type { MapReading, StreetMapReading } from './mdx-street-map-browser-driver.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

const SUITE_MS = 200_000;
const SPAWN_MS = 180_000;
const CASE_MS = 60_000;
const ROUNDING_PX = 1;

let r: StreetMapReading;
const maps = (): Array<[string, MapReading]> => [
  ['wide inline', r.wide.inline],
  ['wide file', r.wide.file],
  ['narrow inline', r.narrow.inline],
  ['narrow file', r.narrow.file],
];

describe.skipIf(CHROME === null)('a StreetMap on the doc page', () => {
  beforeAll(() => {
    const run = spawnSync('bun', [join(import.meta.dirname, 'mdx-street-map-browser-driver.ts')], {
      encoding: 'utf8',
      timeout: SPAWN_MS,
    });
    expect(run.status, run.stderr).toBe(0);
    r = JSON.parse(run.stdout.trim().split('\n').at(-1) ?? '') as StreetMapReading;
  }, SUITE_MS);

  it(
    'draws every marker, ring and point, inline and from a file, at both widths',
    () => {
      expect([r.wide.viewport, r.narrow.viewport]).toEqual([1180, 430]);
      for (const [, m] of maps()) {
        expect({ markers: m.markers, rings: m.rings, points: m.points }).toEqual({
          markers: 100,
          rings: 200,
          points: 3000,
        });
        expect(m.markerPaths).toBe(100);
        expect(m.ringPaths).toBe(200);
        expect(m.coloursPainted).toBe(5);
        expect(m.canvasShown).toBe(true);
        expect(m.framed).toBe(false);
      }
    },
    CASE_MS,
  );

  it(
    'shows a legend of the five categories and both rings under each map',
    () => {
      for (const [, m] of maps()) {
        expect(m.legend).toEqual([
          'Noise',
          'Litter',
          'Graffiti',
          'Lighting',
          'Potholes',
          '150 ft',
          '300 ft',
        ]);
      }
    },
    CASE_MS,
  );

  it(
    'keeps each map inside the text column at its own height',
    () => {
      for (const [name, m] of maps()) {
        expect(m.width, name).toBeLessThanOrEqual(m.column + ROUNDING_PX);
        expect(m.width, name).toBeGreaterThan(0);
        expect(m.height, name).toBe(name.endsWith('file') ? 420 : 480);
      }
    },
    CASE_MS,
  );

  it(
    'opens a marker’s popup on a click without opening the source',
    () => {
      expect(r.popup).toMatch(/^(Harborlight|Riverbend|Saltmarsh) hall \d+: \d+ reports$/);
      expect(r.sourceOpened).toBe(false);
    },
    CASE_MS,
  );

  it(
    'loads tiles from the basemap’s listed origin and nowhere else',
    () => {
      expect(r.tileRequests).toBeGreaterThan(0);
      expect(r.strayRequests).toEqual([]);
    },
    CASE_MS,
  );
});
