/**
 * A mock's round chevrons stand above a docked review item, and come back
 * down to the corner when the dock clears.
 *
 * Seen on an iPad at 1180x820: the chevrons sat at 16px from the bottom
 * (756 to 804) and the dock ran from 767 to 820, drawn over them, so the
 * reader could neither see nor tap the way back to an earlier round.
 *
 * `mock-nav-dock-driver.ts` measures a running headless Chromium at 1180x820
 * and 430x932; this file asserts on those boxes.
 *
 * audit: no-text — the driver measures a running browser; nothing here reads
 * a source file, a bundle or a stylesheet.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { resolveChromeBin } from '../../../scripts/ui-shot-lib.ts';
// Types only: importing a value would run the driver in this process.
import type { Reading } from './mock-nav-dock-driver.ts';
import type { Box } from './panel-edge-driver.ts';

const CHROME = ((): string | null => {
  try {
    return resolveChromeBin(undefined);
  } catch {
    return null;
  }
})();

const DRIVER = join(import.meta.dirname, 'mock-nav-dock-driver.ts');
/** One launch, two page loads. */
const SUITE_MS = 90_000;
const SPAWN_MS = 80_000;

let readings: Reading[] = [];
const at = (width: number): Reading => {
  const r = readings.find((x) => x.width === width);
  if (!r) throw new Error(`no reading at ${width}`);
  return r;
};
const must = (b: Box | null, name: string): Box => {
  if (!b) throw new Error(`no ${name} measured`);
  return b;
};
const overlaps = (a: Box, b: Box): boolean =>
  a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];

describe.skipIf(CHROME === null)("a mock's round chevrons and a docked review item", () => {
  beforeAll(() => {
    const r = spawnSync('bun', [DRIVER], { encoding: 'utf8', timeout: SPAWN_MS });
    expect(r.status, r.stderr).toBe(0);
    readings = JSON.parse(r.stdout) as Reading[];
    expect(readings.map((x) => x.width)).toEqual([1180, 430]);
  }, SUITE_MS);

  for (const width of [1180, 430]) {
    it(`the chevrons stand fully above the dock, and on top, at ${width}`, () => {
      const { height, docked } = at(width);
      const dock = must(docked.dock, 'dock');
      const chevrons = must(docked.chevrons, 'chevrons');
      expect(dock[3], 'CONTROL: the dock rests on the bottom edge').toBe(height);
      expect(chevrons[3]).toBeLessThanOrEqual(dock[1]);
      expect(docked.chevronOnTop).toBe(true);
    });

    it(`they keep clear of the FAB and the list button at ${width}`, () => {
      const { docked } = at(width);
      const chevrons = must(docked.chevrons, 'chevrons');
      expect([
        overlaps(chevrons, must(docked.fab, 'FAB')),
        overlaps(chevrons, must(docked.list, 'list button')),
      ]).toEqual([false, false]);
    });

    it(`they return to 16px from the bottom when the dock clears at ${width}`, () => {
      const { height, cleared } = at(width);
      expect(cleared.dock, 'CONTROL: the dock went away').toBeNull();
      expect(must(cleared.chevrons, 'chevrons')[3]).toBe(height - 16);
    });
  }
});
