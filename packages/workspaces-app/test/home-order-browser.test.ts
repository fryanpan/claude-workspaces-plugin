/**
 * The owner opens Home and sees the review items at the top, with the coach
 * section below them, on the iPad in landscape and on a phone. Read in a real
 * browser: each region's top edge, from `getBoundingClientRect()`.
 *
 * `packages/server/test/home-order-browser-driver.ts` signs in as the owner
 * and does the reading. The order of the regions in the markup is the route
 * test, `packages/server/test/landing-section-nav.test.ts`.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
// Types only: importing a value would run the driver in this process.
import type { HomeOrderReading } from '../../server/test/home-order-browser-driver.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

const DRIVER = join(import.meta.dirname, '../../server/test/home-order-browser-driver.ts');
/** A client build, one launch and two page loads. */
const SUITE_MS = 180_000;
const SPAWN_MS = 170_000;

let r: HomeOrderReading;

describe.skipIf(CHROME === null)("Home's review items sit above the coach", () => {
  beforeAll(() => {
    const run = spawnSync('bun', [DRIVER], { encoding: 'utf8', timeout: SPAWN_MS });
    expect(run.status, run.stderr).toBe(0);
    r = JSON.parse(run.stdout.trim().split('\n').at(-1) ?? '') as HomeOrderReading;
  }, SUITE_MS);

  for (const [width, height] of [
    [1180, 820],
    [430, 932],
  ] as const) {
    it(`at ${width}x${height} the review items' top is above the coach's`, () => {
      const s = r.sizes.find((x) => x.width === width && x.height === height);
      // CONTROL: both regions are on the owner's page, so the comparison reads two boxes.
      expect(s?.review, 'review region').not.toBeNull();
      expect(s?.coach, 'coach region').not.toBeNull();
      expect(s?.review?.top ?? Number.POSITIVE_INFINITY).toBeLessThan(
        s?.coach?.top ?? Number.NEGATIVE_INFINITY,
      );
    }, 60_000);
  }
});
