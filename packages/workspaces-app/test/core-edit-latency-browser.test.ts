/**
 * The M8 cutover trial in a real browser, on a board on the collab core.
 *
 * `core-edit-latency-browser-driver.ts` runs it in headless Chromium against
 * a port-0 server and the real doc bundle; these cases assert on the JSON it
 * prints.
 *
 *   - bar 3: a page outside the board — another origin, the app kit's page
 *     client and nothing of the board app — joins the doc's room ON THE CORE
 *     (the core's open rooms name the doc while it is the only page), holds
 *     the doc, and its edit reaches the server.
 *   - bar 2: an edit reaches the board's doc page's stored state within 1s
 *     and its screen within 1.5s, on the named doc (the Harborlight tide
 *     table, `server/test/core-edit-latency.ts`), worst of five. The bar IS a
 *     latency, so it is asserted as one; the clocks are stamped at the events
 *     (see the driver), and the numbers are printed so the CI log keeps them.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
import { SCREEN_BAR_MS, STORED_BAR_MS } from '../../server/test/core-edit-latency.ts';
import type { CoreEditLatencyRun } from './core-edit-latency-reading.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

const DRIVER = join(import.meta.dirname, 'core-edit-latency-browser-driver.ts');
/** Two bundle builds, one browser, one server. */
const SUITE_MS = 200_000;
const SPAWN_MS = 190_000;

let run: CoreEditLatencyRun | null = null;
const result = (): CoreEditLatencyRun => {
  if (!run) throw new Error('the driver printed nothing');
  return run;
};

describe.skipIf(CHROME === null)('a board on the collab core, in a browser', () => {
  beforeAll(() => {
    const r = spawnSync('bun', [DRIVER], { encoding: 'utf8', timeout: SPAWN_MS });
    expect(r.status, r.stderr).toBe(0);
    run = JSON.parse(r.stdout.trim().split('\n').pop() ?? '') as CoreEditLatencyRun;
    const { edits, docBytes, docWeeks } = run;
    console.log(
      `[core-edit-latency] browser, Harborlight tide table ${docWeeks} weeks, ${docBytes} bytes: ` +
        edits
          .map((e) => `stored ${e.storedMs.toFixed(1)}ms / screen ${e.screenMs.toFixed(1)}ms`)
          .join('; '),
    );
  }, SUITE_MS);

  it('bar 3: a page on another origin joins the doc’s room on the core', () => {
    const { outside } = result();
    expect(outside.origin).not.toBe(outside.boardOrigin);
    expect(outside.status).toBe('synced');
    expect(outside.heldDoc).toBe(true);
    expect(outside.coreRoomsWhileAlone).toEqual([outside.docId]);
    expect(outside.editReachedServer).toBe(true);
  });

  it('control: the board doc page is on the core too', () => {
    const { outside, coreRoomsWithDocPage } = result();
    expect(coreRoomsWithDocPage).toEqual([outside.docId]);
  });

  it('bar 2: an edit reaches the doc page’s stored state within 1s and its screen within 1.5s', () => {
    const { edits } = result();
    expect(edits).toHaveLength(5);
    for (const e of edits) {
      // A negative number would mean the clocks were not one clock.
      expect(e.screenMs).toBeGreaterThanOrEqual(0);
      expect(e.storedMs).toBeGreaterThanOrEqual(0);
      expect(e.storedMs).toBeLessThan(STORED_BAR_MS);
      expect(e.screenMs).toBeLessThan(SCREEN_BAR_MS);
    }
  });
});
