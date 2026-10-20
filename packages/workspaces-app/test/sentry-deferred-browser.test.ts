/**
 * The page's own script does not wait for the Sentry script, and a boot error
 * still reaches Sentry — in a real browser.
 *
 * `sentry-deferred-driver.ts` serves a page with the real head tags and the
 * real built Sentry entry, holds the Sentry script until the page's script
 * says it ran, and stands in for Sentry's ingest. This file asserts on what
 * it read.
 *
 * audit: no-text — the driver reads a running page and a running server;
 * nothing here reads a source file, a bundle or a stylesheet.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
// Types only: importing a value would run the driver in this process.
import type { SentryDeferredRun } from './sentry-deferred-driver.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

const DRIVER = join(import.meta.dirname, 'sentry-deferred-driver.ts');

let run: SentryDeferredRun;

describe.skipIf(CHROME === null)('the Sentry script loads beside the page, not ahead of it', () => {
  beforeAll(() => {
    const r = spawnSync('bun', [DRIVER], { encoding: 'utf8', timeout: 110_000 });
    expect(r.status, r.stderr).toBe(0);
    run = JSON.parse(r.stdout.trim().split('\n').at(-1) ?? '') as SentryDeferredRun;
  }, 120_000);

  it("the page's script runs while the Sentry script is still downloading", () => {
    expect(run.pageRanFirst).toBe(true);
  });

  it('an error the page throws before Sentry has loaded still reaches Sentry', () => {
    expect(run.errorReported).toBe(true);
  });
});
