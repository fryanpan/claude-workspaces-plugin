/**
 * The lead chat on the cross-board review (`/review`, opened from Home), in
 * a real browser at 1180x820 and 430x932: the agent button sits in the
 * page's rail dock where a board's does, opens a chat with the lead of the
 * board the open review item is from, follows the card to the next board's
 * lead, and shows that lead's text without a reload.
 * `review-lead-chat-browser-driver.ts` does it against a real server with
 * two fixture boards; these cases assert on its JSON.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
import type { ReviewLeadChatRun } from './review-lead-chat-browser-reading.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

const DRIVER = join(import.meta.dirname, 'review-lead-chat-browser-driver.ts');
/** One bundle build, two launches, five page loads. */
const SUITE_MS = 200_000;
const SPAWN_MS = 190_000;

let run: ReviewLeadChatRun | null = null;
const result = (): ReviewLeadChatRun => {
  if (!run) throw new Error('the driver printed nothing');
  return run;
};

describe.skipIf(CHROME === null)('the lead chat on the cross-board review', () => {
  beforeAll(() => {
    const r = spawnSync('bun', [DRIVER], { encoding: 'utf8', timeout: SPAWN_MS });
    expect(r.status, r.stderr).toBe(0);
    run = JSON.parse(r.stdout.trim().split('\n').pop() ?? '') as ReviewLeadChatRun;
  }, SUITE_MS);

  it('runs at both sizes, over two boards with different leads', () => {
    expect(result().widths.map((w) => w.width)).toEqual([1180, 430]);
    expect(result().leads).toEqual({
      Harborlight: 'Harborlight Lead',
      Riverbend: 'Riverbend Lead',
    });
  }, 60_000);

  it('shows the agent button in the rail dock with a review item open', () => {
    for (const w of result().widths) {
      expect(w.buttonClosed, String(w.width)).not.toBeNull();
      expect(w.inDock, String(w.width)).toBe(true);
    }
  }, 60_000);

  it('opens a chat with the lead of the open item’s board', () => {
    const { leads } = result();
    for (const w of result().widths) {
      expect(w.firstLead, String(w.width)).toBe(leads[w.firstProject]);
    }
  }, 60_000);

  it('follows the card: after Skip the chat is with the next board’s lead', () => {
    const { leads } = result();
    for (const w of result().widths) {
      const at = String(w.width);
      // CONTROL: the two cards are from different boards, so a chat stuck on
      // the first lead fails here.
      expect(w.secondProject, at).not.toBe(w.firstProject);
      expect(w.secondLead, at).toBe(leads[w.secondProject]);
    }
  }, 60_000);

  it('shows the lead’s text in the open chat within a second, and only that lead’s', () => {
    for (const w of result().widths) {
      expect(w.liveWithin1s, String(w.width)).toBe(true);
      expect(w.otherLeadShown, String(w.width)).toBe(false);
    }
  }, 60_000);

  it('keeps the button’s size and place as the chat opens and as the card changes board', () => {
    for (const w of result().widths) {
      const at = String(w.width);
      expect(w.buttonOpen, at).toEqual(w.buttonClosed);
      expect(w.buttonAfterSkip, at).toEqual(w.buttonClosed);
    }
  }, 60_000);

  it('puts the button where the board page puts it', () => {
    for (const w of result().widths) {
      const at = String(w.width);
      expect(w.boardButton, at).not.toBeNull();
      expect(w.buttonClosed?.left, at).toBe(w.boardButton?.left);
      expect(w.buttonClosed?.width, at).toBe(w.boardButton?.width);
      expect(w.buttonClosed?.height, at).toBe(w.boardButton?.height);
      expect(w.buttonClosed?.top, at).toBe(w.boardButton?.top);
    }
  }, 60_000);
});
