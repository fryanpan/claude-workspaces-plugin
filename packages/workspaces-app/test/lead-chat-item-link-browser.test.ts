/**
 * A voice message said while a review item is open on the board's Home
 * reaches the lead with that item's link, not "(at board)" (Bryan, 30 Oct).
 * Whether the item was open before voice came on or was opened while it
 * listened, at 1180x820 and 430x932.
 * `lead-chat-item-link-browser-driver.ts` drives a real server and the real
 * bundles; these cases assert on its JSON.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
// Types only: importing a value would run the driver in this process.
import type { ItemLinkRun } from './lead-chat-item-link-browser-driver.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

const DRIVER = join(import.meta.dirname, 'lead-chat-item-link-browser-driver.ts');
/** One bundle build, two launches, eight page loads. */
const SUITE_MS = 220_000;
const SPAWN_MS = 210_000;

let run: ItemLinkRun | null = null;
const result = (): ItemLinkRun => {
  if (!run) throw new Error('the driver printed nothing');
  return run;
};

describe.skipIf(CHROME === null)('a voice message from an open review item', () => {
  beforeAll(() => {
    const r = spawnSync('bun', [DRIVER], { encoding: 'utf8', timeout: SPAWN_MS });
    expect(r.status, r.stderr).toBe(0);
    run = JSON.parse(r.stdout.trim().split('\n').pop() ?? '') as ItemLinkRun;
  }, SUITE_MS);

  it('runs both orders at both sizes, each with the item in the address', () => {
    const r = result();
    expect(r.cases.map((c) => `${c.width} ${c.order}`)).toEqual([
      '1180 item-first',
      '1180 voice-first',
      '430 item-first',
      '430 voice-first',
    ]);
    for (const c of r.cases) expect(c.pageItem, `${c.width} ${c.order}`).toMatch(/^task-review:/);
  }, 60_000);

  it("reaches the lead with that item's link on its board", () => {
    const r = result();
    for (const c of r.cases) {
      const at = `${c.width} ${c.order}: ${c.link}`;
      expect(c.link, at).not.toBeNull();
      const url = new URL(c.link ?? '', 'https://board.invalid');
      expect(url.pathname, at).toBe(`/workspaces/${r.workspaceId}/home`);
      expect(url.searchParams.get('item'), at).toBe(c.pageItem);
    }
  }, 60_000);
});
