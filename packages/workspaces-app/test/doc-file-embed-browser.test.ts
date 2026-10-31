/**
 * A `::html{src="map/index.html"}` line in a bound doc frames that page from
 * the doc's own folder on the real doc page, in a real browser against a real
 * server, and the page's relative stylesheet, script and JSON fetch all load.
 *
 * The page reports what it saw with one message; a page that never loaded
 * sends none, so a null report fails every case below. The same report shows
 * the page ran with an opaque origin and could not read the doc page.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
import type { FileEmbedReading } from './doc-file-embed-browser-driver.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

/** A doc bundle build, one launch and one page. */
const SUITE_MS = 200_000;
const SPAWN_MS = 180_000;
const CASE_MS = 60_000;

let r: FileEmbedReading;

describe.skipIf(CHROME === null)('a doc frames an HTML file from its own folder', () => {
  beforeAll(() => {
    const run = spawnSync('bun', [join(import.meta.dirname, 'doc-file-embed-browser-driver.ts')], {
      encoding: 'utf8',
      timeout: SPAWN_MS,
    });
    expect(run.status, run.stderr).toBe(0);
    r = JSON.parse(run.stdout.trim().split('\n').at(-1) ?? '') as FileEmbedReading;
  }, SUITE_MS);

  it(
    'draws an opaque frame at the doc folder address',
    () => {
      expect(r.frameSrc).toMatch(/\/docs\/[^/]+\/files\/map\/index\.html$/);
      expect(r.sandbox).toBe('allow-scripts');
    },
    CASE_MS,
  );

  it(
    'runs the relative script and applies the relative stylesheet',
    () => {
      expect(r.report?.scriptRan).toBe(true);
      expect(r.report?.headingColor).toBe('rgb(12, 34, 56)');
    },
    CASE_MS,
  );

  it(
    'reads the relative JSON with fetch',
    () => {
      expect(r.report?.fetchError).toBeNull();
      expect(r.report?.json).toEqual({ route: 'Saltmarsh' });
    },
    CASE_MS,
  );

  it(
    'runs with an opaque origin and cannot read the doc page',
    () => {
      expect(r.report?.origin).toBe('null');
      expect(r.report?.parentReadable).toBe(false);
    },
    CASE_MS,
  );
});
