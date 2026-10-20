/**
 * A doc's first load on a phone over 5G shows its text inside two seconds,
 * having transferred under 250 KB to do it.
 *
 * `doc-first-load-browser-driver.ts` does it in headless Chromium against a
 * real server and the real doc bundle, cold, through a relay that paces the
 * bytes at ~9 Mbps with a 150 ms round trip, with the CPU slowed four times;
 * these cases assert on the JSON it prints.
 *
 * This is the one place a test here asserts a duration, because the duration
 * is the behaviour: "readable at once" is a number of seconds. The two
 * controls are what make that number mean anything. The relay's own rate is
 * measured on a known uncompressed payload, because Chrome's network
 * emulation was measured lying by a factor of thirty, and the unthrottled load
 * has to be the faster one, or the throttle was never applied.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
import type { DocFirstLoadRun } from './doc-first-load-reading.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

const DRIVER = join(import.meta.dirname, 'doc-first-load-browser-driver.ts');
/** A bundle build, two browser launches, one server. */
const SUITE_MS = 200_000;
const SPAWN_MS = 190_000;

let run: DocFirstLoadRun | null = null;
const result = (): DocFirstLoadRun => {
  if (!run) throw new Error('the driver printed nothing');
  return run;
};

describe.skipIf(CHROME === null)("a doc's first load on a phone over 5G", () => {
  beforeAll(() => {
    const r = spawnSync('bun', [DRIVER], { encoding: 'utf8', timeout: SPAWN_MS });
    expect(r.status, r.stderr).toBe(0);
    run = JSON.parse(r.stdout.trim().split('\n').pop() ?? '') as DocFirstLoadRun;
  }, SUITE_MS);

  it('control: the relay delivers the rate it was set to', () => {
    const { relayBitsPerSecond, configuredBitsPerSecond } = result();
    expect(relayBitsPerSecond).toBeGreaterThan(configuredBitsPerSecond * 0.85);
    expect(relayBitsPerSecond).toBeLessThan(configuredBitsPerSecond * 1.1);
  });

  it('control: the same load unthrottled shows the text sooner', () => {
    const { throttled, unthrottled } = result();
    expect(unthrottled.textMs).toBeLessThan(throttled.textMs);
  });

  it('transfers under 250 KB before the text is on screen', () => {
    // 769,040 bytes before this change, when the editor, CodeMirror and the
    // stylesheets' comments all came first; 113,796 after.
    expect(result().throttled.bytesBeforeText).toBeLessThan(250_000);
  });

  it('shows the text inside two seconds', () => {
    // Measured 1,114 ms on an M-series Mac, so the bar leaves about 0.9 s for
    // a slower runner. The editor mounts on the same text after it.
    const { throttled } = result();
    expect(throttled.textMs).toBeLessThan(2000);
    expect(throttled.editorMs).toBeGreaterThanOrEqual(throttled.textMs);
  });
});
