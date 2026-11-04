/**
 * An image wider than the doc's text column draws at the column's width, at
 * 1180x820 and at 430 wide, on the real doc page in a real browser against a
 * real server (MOI: an 1800px PNG drew at 1800px against a 1083px column).
 *
 * A picture that never loaded reads a natural width of 0, which fails the
 * first case rather than passing the others by drawing nothing.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
import type { ImageFitReading } from './doc-image-fit-browser-driver.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

/** A doc bundle build, one launch and two page loads. */
const SUITE_MS = 200_000;
const SPAWN_MS = 180_000;
const CASE_MS = 60_000;
/** Sub-pixel rounding between a box's width and its column's. */
const ROUNDING_PX = 1;

let r: ImageFitReading;

describe.skipIf(CHROME === null)('a doc image fits its text column', () => {
  beforeAll(() => {
    const run = spawnSync('bun', [join(import.meta.dirname, 'doc-image-fit-browser-driver.ts')], {
      encoding: 'utf8',
      timeout: SPAWN_MS,
    });
    expect(run.status, run.stderr).toBe(0);
    r = JSON.parse(run.stdout.trim().split('\n').at(-1) ?? '') as ImageFitReading;
  }, SUITE_MS);

  it(
    'loads a picture wider than the column at both widths',
    () => {
      for (const fit of [r.wide, r.narrow]) {
        expect(fit.natural).toBe(1800);
        expect(fit.natural).toBeGreaterThan(fit.column);
      }
      expect([r.wide.viewport, r.narrow.viewport]).toEqual([1180, 430]);
    },
    CASE_MS,
  );

  it(
    'draws it no wider than the column at 1180x820',
    () => {
      expect(r.wide.drawn).toBeLessThanOrEqual(r.wide.column + ROUNDING_PX);
      expect(r.wide.drawn).toBeGreaterThan(r.wide.column - ROUNDING_PX);
    },
    CASE_MS,
  );

  it(
    'draws it no wider than the column at 430 wide',
    () => {
      expect(r.narrow.drawn).toBeLessThanOrEqual(r.narrow.column + ROUNDING_PX);
      expect(r.narrow.drawn).toBeGreaterThan(r.narrow.column - ROUNDING_PX);
    },
    CASE_MS,
  );
});
