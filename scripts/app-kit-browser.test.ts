/**
 * An app made by `bun run new-app`, in two real browser tabs: a person makes
 * an account on the app's form, opens the mailed link, signs in by password,
 * opens one doc in both tabs, types in the first, and
 * the second shows it. The page carries the shared theme and its Web Awesome
 * components. `packages/server/test/app-kit-browser-driver.ts` drives it;
 * the same flow without a browser is `packages/server/test/app-kit.test.ts`.
 *
 * audit: no-text — the driver reads a running app and its pages; nothing here
 * reads a source file, a bundle or a stylesheet.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
// Types only: importing a value would run the driver in this process.
import type { AppKitBrowserReading } from '../packages/server/test/app-kit-browser-driver.ts';
import { chromeForSuite } from './browser-tests.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

const DRIVER = join(import.meta.dirname, '../packages/server/test/app-kit-browser-driver.ts');
/** Make and build the app, one browser launch, three page loads. */
const SUITE_MS = 180_000;
const SPAWN_MS = 170_000;

let r: AppKitBrowserReading;

describe.skipIf(CHROME === null)('an app made by new-app, in two browser tabs', () => {
  beforeAll(() => {
    const run = spawnSync('bun', [DRIVER], { encoding: 'utf8', timeout: SPAWN_MS });
    expect(run.status, run.stderr).toBe(0);
    r = JSON.parse(run.stdout.trim().split('\n').at(-1) ?? '') as AppKitBrowserReading;
  }, SUITE_MS);

  it('makes an account, verifies it by the mailed link, and signs in by password', () => {
    expect(r.afterSignUp).toBe('Check your email');
    expect(r.afterVerify).toBe('/auth/sign-in');
    expect(r.afterSignIn).toBe('/');
  });

  it('syncs the doc between the two tabs', () => {
    expect(r.statuses).toEqual(['Live', 'Live']);
    expect(r.secondTabText).toBe('typed in tab one');
  });

  it('draws the page in the shared theme', () => {
    expect(r.brandColor).not.toBe('');
    expect(r.buttonDefined).toBe(true);
  });

  it('the pages threw nothing', () => {
    expect(r.errors).toEqual([]);
  });
});
