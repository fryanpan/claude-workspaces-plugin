/**
 * A served mock's load report judges the board's path, not the mock's own
 * images from another server, in a real browser against a real server. The
 * mock's two images are held by that server for seconds; the report's content
 * stamp lands before they arrive, and the frame's load, which waits for them,
 * is reported beside it as `msToFrameLoad`. Before, the frame's load was the
 * content stamp, so a mock's slow CDN or map tiles raised the slow-load alarm.
 *
 * `mock-load-report-driver.ts` drives the page; this file asserts on what it
 * measured.
 *
 * audit: no-text — the driver measures a running browser and server.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
import type { Reading } from './mock-load-report-driver.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

const DRIVER = join(import.meta.dirname, 'mock-load-report-driver.ts');
const SUITE_MS = 180_000;
const SPAWN_MS = 170_000;

let r: Reading | null = null;
const reading = (): Reading => {
  if (!r) throw new Error('the driver printed no reading');
  return r;
};

describe.skipIf(CHROME === null)("a served mock's load report", () => {
  beforeAll(() => {
    const out = spawnSync('bun', [DRIVER], {
      encoding: 'utf8',
      timeout: SPAWN_MS,
      env: process.env,
    });
    expect(out.status, out.stderr).toBe(0);
    r = JSON.parse(out.stdout.trim().split('\n').pop() ?? '') as Reading;
  }, SUITE_MS);

  it("stamps content before the mock's held images arrive", () => {
    const { report, holdMs, imagesServed } = reading();
    // The positive control: the mock asked for both images and waited on them.
    expect(imagesServed).toBe(2);
    expect(report.page).toBe('mock');
    expect(typeof report.msToContent).toBe('number');
    expect(typeof report.msToFrameLoad).toBe('number');
    const content = report.msToContent as number;
    const frameLoad = report.msToFrameLoad as number;
    // The frame's load waited out the hold; the content stamp did not. Half
    // the hold is the margin for a slow runner between parse and request.
    expect(frameLoad - content).toBeGreaterThanOrEqual(holdMs / 2);
  });

  it('stamps the frame starting no later than its content', () => {
    const { report } = reading();
    expect(typeof report.msToFrameStart).toBe('number');
    expect(report.msToFrameStart as number).toBeLessThanOrEqual(report.msToContent as number);
  });
});
