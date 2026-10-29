/**
 * Archiving a doc with a sign-in older than ten minutes is refused and asks
 * for a fresh one, then succeeds after it — in a real browser against a real
 * server.
 *
 * `packages/server/test/fresh-signin-browser-driver.ts` runs the server
 * behind a stand-in for Cloudflare Access and opens the doc in headless
 * Chromium holding a token minted twenty minutes ago. It taps Archive and
 * cancels; taps it again and signs in again; confirms the archive the page
 * held; puts it back; then at 430 wide asks once more and has an agent
 * archive the doc under the open page.
 *
 * The stand-in is not Cloudflare. It mints a fresh token for a navigation
 * that arrives without one, which is what Access does while the person's
 * identity-provider session is open; what the browser sends and what the
 * server answers are real.
 *
 * audit: no-text — the driver reads a running server and page; nothing here
 * reads a source file, a bundle or a stylesheet.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
// Types only: importing a value would run the driver in this process.
import type { Box, FreshSignInReading } from '../../server/test/fresh-signin-browser-driver.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

const DRIVER = join(import.meta.dirname, '../../server/test/fresh-signin-browser-driver.ts');
/** A client build, one launch and four page loads. */
const SUITE_MS = 180_000;
const SPAWN_MS = 170_000;

let r: FreshSignInReading;

const inside = (b: Box, width: number) => b.left >= 0 && b.right <= width;

describe.skipIf(CHROME === null)('a fresh sign-in before archiving a doc', () => {
  beforeAll(() => {
    const run = spawnSync('bun', [DRIVER], { encoding: 'utf8', timeout: SPAWN_MS });
    expect(run.status, run.stderr).toBe(0);
    r = JSON.parse(run.stdout.trim().split('\n').at(-1) ?? '') as FreshSignInReading;
  }, SUITE_MS);

  it('a stale sign-in is asked to confirm, and nothing is archived while it asks', () => {
    expect(r.firstAsk).toEqual({ title: "Confirm it's you", buttons: ['Cancel', 'Sign in again'] });
    expect(r.onBoardWhileAsked).toBe(true);
  });

  it('Cancel changes nothing', () => {
    expect(r.cancelToast).toBe('Nothing changed');
    expect(r.onBoardAfterCancel).toBe(true);
  });

  it('"Sign in again" goes through one sign-in and back to the same page', () => {
    expect(r.secondAsk).toEqual({ title: 'Sign in again', buttons: ['Cancel', 'Go to sign-in'] });
    expect(r.minted).toBe(1);
    expect(r.backAt).toMatch(/^\/workspaces\/[^/]+\/docs\/riverbend-launch-notes$/);
  });

  it('back from signing in, the page offers the held archive, and still nothing has changed', () => {
    expect(r.resumeAsk?.title).toMatch(/^Archive .+ now\?$/);
    expect(r.resumeAsk?.buttons).toEqual(['Not now', 'Archive']);
    expect(r.onBoardBeforeResume).toBe(true);
  });

  it('confirming archives the doc, shows the bar, and offers "Put it back"', () => {
    expect(r.onBoardAfterArchive).toBe(false);
    expect(r.archivedToast).toMatch(/^Archived /);
    expect(r.archivedToastAction).toBe('Put it back');
    expect(r.barShown).toBe(true);
  });

  it('"Put it back" restores the doc without asking', () => {
    expect(r.askedOnPutBack).toBe(false);
    expect(r.onBoardAfterPutBack).toBe(true);
    expect(r.barAfterPutBack).toBe(false);
  });

  it('at 1180x820 the two buttons are 44px tall', () => {
    expect(r.wideAskButtons.map((b) => b.height)).toEqual([44, 44]);
  });

  it('at 430 wide the More button, its menu and the ask all fit on screen', () => {
    const w = r.narrow.viewport.width;
    expect(r.narrow.more && inside(r.narrow.more, w)).toBe(true);
    expect(r.narrow.menu && inside(r.narrow.menu, w)).toBe(true);
    expect(r.narrow.ask?.title).toBe("Confirm it's you");
    expect(r.narrow.askButtons).toHaveLength(2);
    for (const b of r.narrow.askButtons) {
      expect(inside(b, w)).toBe(true);
      expect(b.height).toBe(44);
    }
  });

  it("an agent's archive is not asked, and reaches the open page as the bar", () => {
    expect(r.narrow.agentStatus).toBe(200);
    expect(r.narrow.liveBar && inside(r.narrow.liveBar, r.narrow.viewport.width)).toBe(true);
  });

  it('the page threw nothing', () => {
    expect(r.errors).toEqual([]);
  });
});
