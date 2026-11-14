/**
 * The library chart (`core/plot-chart.ts`) runs in a doc with live state: a
 * bound `.mdx` whose repository holds the chart file and `plot-spec.mjs`
 * byte for byte draws the chart on the real doc page from the tag's props,
 * and a state write from another client on the doc's socket redraws the
 * open page with no reload. The write-to-page time is printed for the report.
 * The Astro half is templates/astro-chart/test/astro-page.test.ts.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
import type { PlotChartDocReading } from './plot-chart-doc-browser-driver.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

const SUITE_MS = 200_000;
const SPAWN_MS = 180_000;
const CASE_MS = 60_000;

let r: PlotChartDocReading;

describe.skipIf(CHROME === null)('the library chart in a doc', () => {
  beforeAll(() => {
    const run = spawnSync('bun', [join(import.meta.dirname, 'plot-chart-doc-browser-driver.ts')], {
      encoding: 'utf8',
      timeout: SPAWN_MS,
    });
    expect(run.status, run.stderr).toBe(0);
    r = JSON.parse(run.stdout.trim().split('\n').at(-1) ?? '') as PlotChartDocReading;
    console.log(`[plot-chart state write-to-page, browser] ${r.writeToPageMs} ms`);
  }, SUITE_MS);

  it(
    "draws the chart from the tag's props",
    () => {
      expect(r.buildError).toBeNull();
      expect(r.first).toEqual({ bars: 2, title: 'Ferry trips' });
    },
    CASE_MS,
  );

  it(
    'redraws the open page when another client writes its state',
    () => {
      expect(r.afterWrite).toEqual({ bars: 3, title: 'Ferry trips, Saltmarsh added' });
    },
    CASE_MS,
  );
});
