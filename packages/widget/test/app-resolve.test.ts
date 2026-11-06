/**
 * A thread resolved by an agent leaves an attached app's page that is already
 * open, in both frames the board hands out, and after the page's connection
 * goes away and comes back.
 *
 * `app-resolve-driver.ts` runs a board server, a dev server and headless
 * Chromium, with a forwarder between the browser and the board. This file
 * asserts on what it read. It lives with the widget's browser cases because
 * the browser gate opens only on the CI steps that run this package.
 *
 * audit: no-text — the driver reads a running page; nothing here reads a
 * source file, a bundle or a stylesheet.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
// Types only: importing a value would run the driver in this process.
import type { Arm, Reading } from './app-resolve-driver.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

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

describe.skipIf(CHROME === null).each([
  ['opaque', 'opaque'],
  ['frame-host', 'frame-host'],
])('a resolve on an open app page, in the %s frame', (_name, frame) => {
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
