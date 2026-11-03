/**
 * The lead chat with the on-screen keyboard up, in a real browser: at 430
 * wide the sheet covers exactly what the keyboard leaves on screen, with the
 * composer above iOS's form-accessory bar and the newest message still in
 * view, both where Safari leaves the view and where it pans down to the
 * field; with the keyboard down it is back above the navbar. At 1180x820 the
 * docked panel does not move. `lead-chat-keyboard-browser-driver.ts` does it
 * against a real server; these cases assert on its JSON.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
import { IOS_ACCESSORY } from '../src/keyboard-inset.ts';
import type { KeyboardRun, KeyboardWidthRun } from './lead-chat-keyboard-browser-reading.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

const DRIVER = join(import.meta.dirname, 'lead-chat-keyboard-browser-driver.ts');
/** One bundle build, three launches. */
const SUITE_MS = 200_000;
const SPAWN_MS = 190_000;

let run: KeyboardRun | null = null;
const at = (label: string): KeyboardWidthRun => {
  const w = run?.widths.find((x) => x.label === label);
  if (!w) throw new Error(`the driver printed no ${label} run`);
  return w;
};

describe.skipIf(CHROME === null)('the lead chat with the keyboard up', () => {
  beforeAll(() => {
    const r = spawnSync('bun', [DRIVER], { encoding: 'utf8', timeout: SPAWN_MS });
    expect(r.status, r.stderr).toBe(0);
    run = JSON.parse(r.stdout.trim().split('\n').pop() ?? '') as KeyboardRun;
  }, SUITE_MS);

  it.each(['430', '430-panned'])(
    'at %s keeps the composer on screen above the accessory bar, and covers the rest',
    (label) => {
      const { before, up } = at(label);
      // CONTROL: the keyboard really took the band's foot, and the composer
      // was down there before it came up.
      expect(up.band.bottom).toBeLessThan(before.band.bottom - 200);
      expect(before.composer.bottom).toBeGreaterThan(up.band.bottom);
      expect(up.focused).toBe(true);
      expect(up.composer.top).toBeGreaterThanOrEqual(up.band.top);
      expect(up.composer.bottom).toBeLessThanOrEqual(up.band.bottom - IOS_ACCESSORY);
      expect(up.pane.top).toBeLessThanOrEqual(up.band.top);
      expect(up.pane.bottom).toBeGreaterThanOrEqual(up.band.bottom);
      expect(up.misses).toEqual([]);
      // The newest message is still the one in view.
      expect(up.listGap).toBeLessThanOrEqual(1);
    },
    60_000,
  );

  it.each(['430', '430-panned'])(
    'at %s goes back above the navbar when the keyboard goes down',
    (label) => {
      const { before, down } = at(label);
      expect(down.pane).toEqual(before.pane);
      expect(down.composer).toEqual(before.composer);
      expect(down.pane.bottom).toBe(down.navTop);
    },
    60_000,
  );

  it('leaves the docked panel at 1180x820 where it was', () => {
    const { before, up, down } = at('1180');
    expect(up.pane).toEqual(before.pane);
    expect(down.pane).toEqual(before.pane);
    expect(up.composer).toEqual(before.composer);
  }, 60_000);
});
