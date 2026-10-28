/**
 * Every page type posts a load report, in a real browser.
 *
 * `page-load-report-driver.ts` boots a server and the real bundles, opens
 * the board, Home, the review page, a doc, a mock, a diff file and a folder
 * file in headless Chromium, and reads after each one what the server
 * stored for that page type. This file asserts on what it read: one case per
 * page type, so a page that stops reporting names itself.
 *
 * audit: no-text — the driver reads a running page and a running server;
 * nothing here reads a source file, a bundle or a stylesheet.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
// Types only: importing a value would run the driver in this process.
import type { PageLoadRun } from './page-load-report-driver.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

const DRIVER = join(import.meta.dirname, 'page-load-report-driver.ts');
const SUITE_MS = 240_000;
const SPAWN_MS = 230_000;

let run: PageLoadRun;

describe.skipIf(CHROME === null)('every page type reports its load', () => {
  beforeAll(() => {
    const r = spawnSync('bun', [DRIVER], { encoding: 'utf8', timeout: SPAWN_MS });
    expect(r.status, r.stderr).toBe(0);
    run = JSON.parse(r.stdout.trim().split('\n').at(-1) ?? '') as PageLoadRun;
  }, SUITE_MS);

  for (const page of ['board', 'home', 'review', 'doc', 'mock', 'diff', 'folder']) {
    it(`the ${page} page posts one report, with its content time`, () => {
      expect(run.loads[page], page).toBe(1);
      expect(run.arrived[page], page).toBe(true);
    });
  }
});
