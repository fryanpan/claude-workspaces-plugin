/**
 * On a phone, opening, replying to and closing a doc comment keeps the
 * reader's place. `mobile-comment-tap-browser-driver.ts` does it with touch
 * events in headless Chromium against a real server and the real doc bundle,
 * at 430x932 with an iOS-style keyboard, and at 1180x820 for the margin
 * balloons; these cases assert on the JSON it prints.
 *
 * Positive control: run against origin/main's bundle (`MOBILE_COMMENT_APP`
 * pointed at a checkout of it) every 430 case below fails. The tap focused
 * the DOCUMENT, so its first keystroke was typed into the doc; the reply box
 * sat under the keyboard; and closing handed focus back to the document,
 * whose caret-follow scrolled the page by 45px. The re-measure case fails on
 * it too: the reply box grew and the card's foot overran its slot.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
import { IOS_ACCESSORY } from '../src/keyboard-inset.ts';
import type { MobileCommentRun, TapView } from './mobile-comment-tap-browser-reading.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

const DRIVER = join(import.meta.dirname, 'mobile-comment-tap-browser-driver.ts');
/** Two bundle builds, two launches, two page loads. */
const SUITE_MS = 200_000;
const SPAWN_MS = 190_000;

let run: MobileCommentRun | null = null;
const result = (): MobileCommentRun => {
  if (!run) throw new Error('the driver printed nothing');
  return run;
};

/** The reply box is clear of the keyboard and the bar iOS floats above it. */
const replyInView = (v: TapView): void => {
  expect(v.replyTop).not.toBeNull();
  expect(v.replyTop as number).toBeGreaterThanOrEqual(v.bandTop);
  expect(v.replyBottom as number).toBeLessThanOrEqual(v.bandBottom - IOS_ACCESSORY);
};

describe.skipIf(CHROME === null)('a doc comment tapped on a phone', () => {
  beforeAll(() => {
    const r = spawnSync('bun', [DRIVER], { encoding: 'utf8', timeout: SPAWN_MS });
    expect(r.status, r.stderr).toBe(0);
    run = JSON.parse(r.stdout.trim().split('\n').pop() ?? '') as MobileCommentRun;
  }, SUITE_MS);

  it('expands, keeps the top of the comment in view and focuses the reply box', () => {
    const { open, openFromBelow } = result().phone;
    expect(open.before.expanded).toBe(false);
    expect(open.after).toMatchObject({ expanded: true, focus: 'reply' });
    expect(open.after.keyboard).toBeGreaterThan(0);
    expect(open.after.cardTop).toBeGreaterThanOrEqual(open.after.bandTop);
    replyInView(open.after);

    // A card whose top was above the editor is scrolled to show it.
    expect(openFromBelow.before.cardTop).toBeLessThan(openFromBelow.before.bandTop);
    expect(openFromBelow.after).toMatchObject({ expanded: true, focus: 'reply' });
    expect(openFromBelow.after.cardTop).toBeGreaterThanOrEqual(openFromBelow.after.bandTop);
  });

  it('keeps the reply box in view above the keyboard while a reply is typed', () => {
    const { typed, typedIntoDoc } = result().phone;
    expect(typedIntoDoc).toBe(false);
    expect(typed.focus).toBe('reply');
    expect(typed.replyText.trim()).toBe(
      'Alice signs off the berth once the Saltmarsh survey is back and the tide table agrees. ' +
        'Bob checks the Riverbend slipway first, because the loaded ferry needs the deeper one.',
    );
    expect(typed.keyboard).toBeGreaterThan(0);
    replyInView(typed);
  });

  it('re-measures the card as the reply box grows, so its foot is not clipped', () => {
    const { open, typed } = result().phone;
    // The control on the setup: the typing really did grow the box.
    expect(typed.replyHeight as number).toBeGreaterThan(open.after.replyHeight as number);
    expect(open.after.slotShortfall).toBe(0);
    expect(typed.slotShortfall).toBe(0);
  });

  it('closing an open comment leaves the page where it was', () => {
    const { close } = result().phone;
    expect(close.before).toMatchObject({ expanded: true, focus: 'reply' });
    expect(close.after.expanded).toBe(false);
    expect(close.after.scrollTop).toBe(close.before.scrollTop);
    expect(close.after.cardTop).toBe(close.before.cardTop);
    // Nothing took the caret, so no keyboard is left up over the doc.
    expect(close.after.focus).toBe('other');
    expect(close.after.keyboard).toBe(0);
  });

  it('leaves the 1180 balloon on its own path: it opens, closes, and its reply is not focused', () => {
    const { open, close } = result().wide;
    expect(open.before.expanded).toBe(false);
    expect(open.after.expanded).toBe(true);
    expect(open.after.focus).not.toBe('reply');
    expect(close.after.expanded).toBe(false);
    expect(close.after.scrollTop).toBe(close.before.scrollTop);
  });
});
