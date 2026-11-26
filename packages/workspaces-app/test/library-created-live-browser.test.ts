/**
 * "Every surface is live": a doc made elsewhere reaches a Library already
 * open on Recently Created, with no reload; and the three recent-files tabs
 * stay one row that does not move as the choice changes, at 1180x820 and
 * 430. `library-created-live-browser-driver.ts` drives a real server and
 * headless Chromium; these cases read its JSON. The wiring-level twin, on the
 * fake server, is the board case in `library-tabs.test.ts`.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
// Types only: importing a value would run the driver in this process.
import type { LibraryCreatedLiveReading } from './library-created-live-browser-driver.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();
const DRIVER = join(import.meta.dirname, 'library-created-live-browser-driver.ts');
const BROWSER_CASE_MS = 60_000;

let r: LibraryCreatedLiveReading;

describe.skipIf(CHROME === null)('Recently Created, on an open Library', () => {
  beforeAll(() => {
    const run = spawnSync('bun', [DRIVER], { encoding: 'utf8', timeout: 170_000 });
    expect(run.status, run.stderr).toBe(0);
    r = JSON.parse(run.stdout.trim().split('\n').at(-1) ?? '') as LibraryCreatedLiveReading;
  }, 180_000);

  it(
    'shows a doc made elsewhere first, on the same page, with no reload',
    () => {
      expect(r.before).toEqual(['Saltmarsh sketch']);
      expect(r.after).toEqual(['Riverbend survey', 'Saltmarsh sketch']);
      expect(r.samePage).toBe(true);
      // Measured, not asserted: printed so a run's log says what it took.
      process.stderr.write(`[library-created-live] row drawn ${r.latencyMs}ms after create\n`);
    },
    BROWSER_CASE_MS,
  );

  it(
    'keeps the three tabs on one row, in place, whichever is chosen, at both sizes',
    () => {
      expect(r.rows.map((row) => row.width)).toEqual([1180, 430]);
      for (const row of r.rows) {
        expect(row.overflow).toBe(false);
        const choices = Object.values(row.byChoice);
        const first = choices[0] ?? [];
        expect(first.map((t) => t.label)).toEqual([
          'Recently Viewed',
          'Recently Modified',
          'Recently Created',
        ]);
        // One row: every tab on the first one's line, inside the viewport.
        for (const t of first) {
          expect(t.y).toBe(first[0]?.y);
          expect(t.x + t.w).toBeLessThanOrEqual(row.width);
        }
        // Unmoved: the same boxes whichever tab is chosen.
        for (const boxes of choices) expect(boxes).toEqual(first);
      }
    },
    BROWSER_CASE_MS,
  );

  it(
    'the page threw nothing',
    () => {
      expect(r.errors).toEqual([]);
    },
    BROWSER_CASE_MS,
  );
});
