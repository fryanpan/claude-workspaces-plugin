/**
 * The owner reaches the access page from the workspaces list, and its back
 * link returns to that list, in a real browser against a real server (Bryan,
 * 30 Oct: "I was expecting this to go back to the main workspaces page. And
 * to have a way to get to this page from the main workspaces page.").
 *
 * `packages/server/test/access-links-browser-driver.ts` clicks the list's
 * "Who has access" link, then the access page's back link, opened plain and
 * opened from a board (`?ws=`), and reads where each click landed. The
 * control is the list signed out in the same run, which shows no such link.
 *
 * audit: no-text — the driver reads a running server and page; nothing here
 * reads a source file, a bundle or a stylesheet.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
// Types only: importing a value would run the driver in this process.
import type { AccessLinksReading } from '../../server/test/access-links-browser-driver.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

const DRIVER = join(import.meta.dirname, '../../server/test/access-links-browser-driver.ts');
/** A client build, one launch and five page loads. */
const SUITE_MS = 180_000;
const SPAWN_MS = 170_000;

let r: AccessLinksReading;

describe.skipIf(CHROME === null)(
  'the workspaces list and the access page link to each other',
  () => {
    beforeAll(() => {
      const run = spawnSync('bun', [DRIVER], { encoding: 'utf8', timeout: SPAWN_MS });
      expect(run.status, run.stderr).toBe(0);
      r = JSON.parse(run.stdout.trim().split('\n').at(-1) ?? '') as AccessLinksReading;
    }, SUITE_MS);

    it('CONTROL: signed out, the list offers no link to the access page', () => {
      expect(r.signedOutAccessLinks).toBe(0);
    }, 60_000);

    it("the owner's list links to the access page", () => {
      expect(r.fromList).toEqual({ pathname: '/access', heading: 'Who has access' });
    }, 60_000);

    it('back from the access page lands on the workspaces list', () => {
      expect(r.backFromPlain).toEqual({
        label: 'Workspaces',
        pathname: '/',
        heading: 'Workspaces',
      });
    }, 60_000);

    it('back lands on the workspaces list even when the page was opened from a board', () => {
      expect(r.backFromBoard).toEqual({
        label: 'Workspaces',
        pathname: '/',
        heading: 'Workspaces',
      });
    }, 60_000);

    it('the pages threw nothing', () => {
      expect(r.errors).toEqual([]);
    }, 60_000);
  },
);
