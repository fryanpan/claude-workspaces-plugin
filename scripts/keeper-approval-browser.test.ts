/**
 * The keeper's approval page approves a held project only with a passkey,
 * in a real browser: Chrome's virtual authenticator registers on the
 * enrollment page and then approves `fly apps create` on the approval page.
 * The driver is `keeper-browser-driver.ts` beside it; the server
 * suite's `keeper-approval.test.ts` covers the same checks with a software
 * passkey and no browser.
 *
 * audit: no-text — the driver reads a running keeper and page; nothing here
 * reads a source file, a bundle or a stylesheet.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from './browser-tests.ts';
import type { KeeperBrowserReading } from './keeper-browser-driver.ts';

/** The browser these cases may launch, or null to skip them. */
const CHROME = chromeForSuite();
const DRIVER = join(import.meta.dirname, './keeper-browser-driver.ts');

let reading: KeeperBrowserReading;

describe.skipIf(CHROME === null)("the keeper's pages with a virtual passkey", () => {
  beforeAll(() => {
    const r = spawnSync('bun', [DRIVER], { encoding: 'utf8', timeout: 55_000 });
    expect(r.status, r.stderr).toBe(0);
    reading = JSON.parse(r.stdout.trim().split('\n').at(-1) ?? '') as KeeperBrowserReading;
  }, 60_000);

  it('registers the passkey on the enrollment page', () => {
    expect(reading.enrollStatus).toBe('Registered.');
    expect(reading.passkeys).toBe(1);
  });

  it('runs nothing until the tap, then runs the held command once', () => {
    expect(reading.ranBeforeTap).toBe(0);
    expect(reading.approveStatus).toBe('Approved. It ran with exit 0.');
    expect(reading.ranAfterTap).toEqual([['apps', 'create', 'cw-harborlight']]);
    expect(reading.appRegistered).toBe(true);
  });
});
