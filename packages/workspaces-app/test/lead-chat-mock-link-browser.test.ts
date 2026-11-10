/**
 * A mockup link tapped in the lead's chat, on Home with a review item open,
 * opens the mock — even when the link names the board the person is reading
 * and the mock is filed on another (9 Nov: "Page not found … Nothing on this
 * board answers to …" for a mock that existed). By the name `attach_mockup`
 * was given and by the id it minted, at 1180x820 and 430x932.
 * `lead-chat-mock-link-browser-driver.ts` drives a real server and the real
 * bundles; these cases assert on its JSON.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
// Types only: importing a value would run the driver in this process.
import type { MockLinkRun } from './lead-chat-mock-link-browser-driver.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

const DRIVER = join(import.meta.dirname, 'lead-chat-mock-link-browser-driver.ts');
/** One bundle build, two launches, eight page loads. */
const SUITE_MS = 200_000;
const SPAWN_MS = 190_000;

let run: MockLinkRun | null = null;
const result = (): MockLinkRun => {
  if (!run) throw new Error('the driver printed nothing');
  return run;
};

describe.skipIf(CHROME === null)('a mockup link in the lead chat', () => {
  beforeAll(() => {
    const r = spawnSync('bun', [DRIVER], { encoding: 'utf8', timeout: SPAWN_MS });
    expect(r.status, r.stderr).toBe(0);
    run = JSON.parse(r.stdout.trim().split('\n').pop() ?? '') as MockLinkRun;
  }, SUITE_MS);

  it('taps both links at both sizes, from Home with the item open', () => {
    const r = result();
    expect(r.taps.map((t) => `${t.width} ${t.name}`)).toEqual([
      '1180 alias',
      '1180 minted',
      '430 alias',
      '430 minted',
    ]);
    for (const t of r.taps) {
      const at = `${t.width} ${t.name}`;
      expect(new URL(t.from).searchParams.get('item'), at).toMatch(/^task-review:/);
      // The link names the board being read, not the mock's own board.
      expect(new URL(t.href ?? '', t.from).pathname, at).toMatch(
        new RegExp(`^/workspaces/${r.workspaceId}/mockups/`),
      );
    }
  }, 60_000);

  it('opens the mock under the board that holds it, frame and all', () => {
    const r = result();
    for (const t of r.taps) {
      const at = `${t.width} ${t.name}: ${t.pageUrl}`;
      expect(t.notFound, at).toBe(false);
      expect(new URL(t.pageUrl).pathname, at).toMatch(
        new RegExp(`^/workspaces/${r.mockBoard}/mockups/`),
      );
      expect(t.title, at).toContain('Saltmarsh home mock');
      expect(t.frame, at).toMatch(/^200 /);
    }
  }, 60_000);
});
