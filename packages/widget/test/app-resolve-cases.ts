/**
 * A thread resolved by an agent leaves an attached app's page that is already
 * open, in both frames the board hands out, and after the page's connection
 * goes away and comes back.
 *
 * `app-resolve-driver.ts` runs a board server, a dev server and headless
 * Chromium, with a forwarder between the browser and the board. The cases
 * here assert on what it read. They live with the widget's browser cases
 * because the browser gate opens only on the CI steps that run this package.
 *
 * One test file per frame (`app-resolve-opaque.test.ts`,
 * `app-resolve-frame-host.test.ts`), not one file for both: each frame's
 * driver run takes about 48s on CI, most of it the silent-socket arm waiting
 * out `READ_MS`, and vitest runs a file's suites one after the other. As one
 * file it was a 95s floor under whichever client shard drew it; as two, the
 * shards can run them side by side.
 *
 * audit: no-text — the driver reads a running page; nothing here reads a
 * source file, a bundle or a stylesheet.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
// Types only: importing a value would run the driver in this process.
import type { Arm, Reading } from './app-resolve-driver.ts';

const DRIVER = join(import.meta.dirname, 'app-resolve-driver.ts');
const SUITE_MS = 170_000;
const SPAWN_MS = 165_000;

const ARMS: [string, keyof Omit<Reading, 'frameOrigin'>][] = [
  ['on a healthy connection', 'live'],
  ['with the comment list open', 'panel'],
  ['after the frame reloaded', 'reloaded'],
  ['after every connection is cut and returns', 'closed'],
  ['after the connection goes silent and the page wakes', 'woken'],
  ['after the connection goes silent with no event at all', 'silent'],
];

/**
 * The cases for one frame. `chrome` is the caller's `chromeForSuite()`: the
 * call stays in each test file, because that call is how
 * `scripts/vitest-sequencer.ts` knows a file launches a browser.
 */
export function describeResolve(chrome: string | null, frame: 'opaque' | 'frame-host'): void {
  describe.skipIf(chrome === null)(`a resolve on an open app page, in the ${frame} frame`, () => {
    let reading: Reading;

    beforeAll(() => {
      const r = spawnSync('bun', [DRIVER, frame], { encoding: 'utf8', timeout: SPAWN_MS });
      expect(r.status, r.stderr).toBe(0);
      reading = JSON.parse(r.stdout.trim().split('\n').at(-1) ?? '') as Reading;
    }, SUITE_MS);

    it('ran in the frame it names', () => {
      expect(reading.frameOrigin?.includes('frames.localhost')).toBe(frame === 'frame-host');
    });

    it.each(ARMS)('leaves the page %s, with no reload', (_what, arm) => {
      const seen: Arm = reading[arm];
      expect(seen.shownBefore, JSON.stringify(seen)).toBe(true);
      expect(seen.left, JSON.stringify(seen)).toBe(true);
      expect(seen.sameDocument, JSON.stringify(seen)).toBe(true);
    });
  });
}
