/**
 * Every control in a mock's bottom corners takes a tap while a review item is
 * docked across the bottom — the widget's own and the mock's own — and the
 * mock's buttons go back where they were when the dock clears.
 *
 * Seen on 28 October from inside a mock: the question bar covered the mock's
 * own buttons in the bottom-right corner. The widget's buttons already stood
 * above the bar; the mock's, fixed 20px up, sat under it.
 *
 * `mock-corner-dock-driver.ts` measures a running headless Chromium at
 * 1180x820 and 430x932; this file asserts on what it measured.
 *
 * audit: no-text — the driver measures a running browser; nothing here reads
 * a source file, a bundle or a stylesheet.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
// Types only: importing a value would run the driver in this process.
import type { Reading } from './mock-corner-dock-driver.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

const DRIVER = join(import.meta.dirname, 'mock-corner-dock-driver.ts');
/** One launch, four page loads. */
const SUITE_MS = 60_000;
const SPAWN_MS = 55_000;

let readings: Reading[] = [];
const at = (width: number): Reading => {
  const r = readings.find((x) => x.width === width);
  if (!r) throw new Error(`no reading at ${width}`);
  return r;
};

describe.skipIf(CHROME === null)("a mock's corner controls and a docked review item", () => {
  beforeAll(() => {
    const r = spawnSync('bun', [DRIVER], { encoding: 'utf8', timeout: SPAWN_MS });
    expect(r.status, r.stderr).toBe(0);
    readings = JSON.parse(r.stdout) as Reading[];
    expect(readings.map((x) => x.width)).toEqual([1180, 430]);
  }, SUITE_MS);

  for (const width of [1180, 430]) {
    it(`every corner control is on screen and takes a tap at ${width}`, () => {
      const { dock, docked } = at(width);
      expect(dock?.[3], 'CONTROL: the dock rests on the bottom edge').toBe(at(width).height);
      expect(docked.map((c) => c.name)).toEqual([
        'comment bubble',
        'thread list',
        'mic',
        'pencil',
        'mock mic',
        'mock chat',
        'round chevrons',
      ]);
      expect(
        docked.filter((c) => !c.tapped || !c.box || c.box[1] < 0).map((c) => c.name),
        'controls a tap at the centre does not reach',
      ).toEqual([]);
    });

    it(`a full-height rail of the mock's stays where it is at ${width}`, () => {
      const { height, rail } = at(width);
      expect(rail).toEqual([0, 0, 6, height]);
    });

    it(`the mock's own buttons keep their size and come back down at ${width}`, () => {
      const { docked, before, cleared } = at(width);
      const mine = docked.filter((c) => c.name.startsWith('mock ')).map((c) => c.box);
      const size = (b: readonly number[] | null) => (b ? [b[2] - b[0], b[3] - b[1]] : null);
      expect(mine.map(size)).toEqual(before.map(size));
      expect(cleared.dock, 'CONTROL: the dock went away').toBeNull();
      expect(cleared.mine).toEqual(before);
    });
  }
});
