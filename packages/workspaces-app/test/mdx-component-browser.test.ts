/**
 * A component tag in a bound `.mdx` draws in the real doc page: a carousel
 * built from a declared folder's `.tsx` and an exact-version esm.sh module,
 * holding two `<PlotChart>` slides, at 1180x820 and at 430 wide; and a saved
 * component file reaches the already-open page without a reload. The
 * save-to-page time is printed for the report.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
import type { ComponentReading } from './mdx-component-browser-driver.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

const SUITE_MS = 200_000;
const SPAWN_MS = 180_000;
const CASE_MS = 60_000;
const ROUNDING_PX = 1;

let r: ComponentReading;

describe.skipIf(CHROME === null)('a component tag on the doc page', () => {
  beforeAll(() => {
    const run = spawnSync('bun', [join(import.meta.dirname, 'mdx-component-browser-driver.ts')], {
      encoding: 'utf8',
      timeout: SPAWN_MS,
    });
    expect(run.status, run.stderr).toBe(0);
    r = JSON.parse(run.stdout.trim().split('\n').at(-1) ?? '') as ComponentReading;
    console.log(`[component save-to-page, browser] ${r.saveToPageMs} ms`);
  }, SUITE_MS);

  it(
    'draws the carousel with both PlotChart slides charted, at both widths',
    () => {
      for (const at of [r.wide, r.narrow]) {
        expect(at.slides).toBe(2);
        expect(at.charts).toBe(2);
        expect(at.caption).toBe('Ferry Riverbend v1.0.0');
      }
      expect([r.wide.viewport, r.narrow.viewport]).toEqual([1180, 430]);
    },
    CASE_MS,
  );

  it(
    'keeps the carousel inside the text column at both widths',
    () => {
      for (const at of [r.wide, r.narrow]) {
        expect(at.width).toBeLessThanOrEqual(at.column + ROUNDING_PX);
        expect(at.width).toBeGreaterThan(0);
      }
    },
    CASE_MS,
  );

  it(
    'shows a saved component file on the open page without a reload',
    () => {
      expect(r.afterSave).toBe('Ferry rebuilt Riverbend v1.0.0');
      expect(r.saveToPageMs).toBeGreaterThan(0);
    },
    CASE_MS,
  );
});
