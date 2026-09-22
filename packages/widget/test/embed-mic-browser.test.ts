/**
 * A page that drops in the tag and the script gets a microphone, in the slot
 * a mock's own mic stands in.
 *
 * The injector lives in the budgeted bundle and does one thing: append
 * `<script src="<serverUrl>/widget/mic.js">`. Nothing about that is visible to
 * happy-dom, which refuses to load a script at all — so the unit test beside
 * this one can only assert the tag it wrote. `embed-mic-driver.ts` serves the
 * bundles over HTTP, loads the embed in headless Chromium at 1180x820 and
 * 430x932, and measures the button that actually arrived.
 *
 * The control is the second page it loads: one that says `window.cwMic = true`
 * before the bundle — what a served mock does through `mockup-live.js` — and
 * fetches the mic from a tag of its own. Both go through the same
 * `mountVoiceLoader`, so the boxes must agree. A mic the injector put
 * somewhere of its own would part them.
 *
 * audit: no-text — the driver measures a running browser; nothing here reads
 * a source file, a bundle or a stylesheet.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
import type { Box, Reading } from './embed-mic-driver.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

const DRIVER = join(import.meta.dirname, 'embed-mic-driver.ts');
/** One launch, four page loads, three bundle builds. */
const SUITE_MS = 240_000;
const SPAWN_MS = 230_000;

/** The floor a finger needs. The widget's own chrome is built to 44. */
const TAP_FLOOR = 36;

let readings: Reading[] = [];
const at = (width: number): Reading => {
  const r = readings.find((x) => x.width === width);
  if (!r) throw new Error(`no reading at ${width}`);
  return r;
};
const painted = (b: Box | null, what: string): Box => {
  if (!b) throw new Error(`expected ${what} to be painted`);
  return b;
};

describe.skipIf(CHROME === null)('the mic an ordinary embed fetches', () => {
  beforeAll(() => {
    const r = spawnSync('bun', [DRIVER], { encoding: 'utf8', timeout: SPAWN_MS });
    expect(r.status, r.stderr).toBe(0);
    readings = JSON.parse(r.stdout) as Reading[];
    expect(readings.map((x) => x.width)).toEqual([1180, 430]);
  }, SUITE_MS);

  it('arrives on a page that pasted nothing but the tag and the script', () => {
    for (const width of [1180, 430]) {
      const r = at(width);
      // The tag the injector wrote, on the server the WIDGET was given —
      // not the page's own origin, which serves none of this. Here they are
      // the same host, so what this says is that the path is right and that
      // the page went and got it.
      expect(
        r.scripts.some((s) => s.endsWith('/widget/mic.js')),
        `fetched at ${width}`,
      ).toBe(true);
      const mic = painted(r.injected, `the mic at ${width}`);
      expect(mic[2] - mic[0], `mic width at ${width}`).toBeGreaterThanOrEqual(TAP_FLOOR);
      expect(mic[3] - mic[1], `mic height at ${width}`).toBeGreaterThanOrEqual(TAP_FLOOR);
      // "this page", never "this mock": the embed is a guest on somebody
      // else's dev server.
      expect(r.tip, `the label at ${width}`).toBe('Talk: voice feedback on this page');
    }
  });

  it('stands where an explicitly mounted mic stands, at both widths', () => {
    for (const width of [1180, 430]) {
      const r = at(width);
      // CONTROL: the page that mounts the mic itself, the way a served mock
      // does. Same mount, so the same box — this is what says the injector
      // chose no slot of its own.
      expect(painted(r.control, `the control mic at ${width}`)).toEqual(
        painted(r.injected, `the injected mic at ${width}`),
      );
    }
  });

  it('takes the slot above the FAB and leaves the thread list beside it', () => {
    for (const width of [1180, 430]) {
      const r = at(width);
      const mic = painted(r.injected, `the mic at ${width}`);
      const fab = painted(r.fab, `the FAB at ${width}`);
      const list = painted(r.list, `the thread list at ${width}`);
      // The mic takes the slot the thread list stood in, above the FAB, and
      // the list becomes a chip to the FAB's left — `addMic`'s whole effect
      // on the widget's own chrome, which is what a mock shows too.
      expect(mic[3], `the mic sits above the FAB at ${width}`).toBeLessThanOrEqual(fab[1]);
      expect(list[2], `the list sits left of the FAB at ${width}`).toBeLessThanOrEqual(fab[0]);
      expect(Math.abs(list[3] - fab[3]), `the chip shares the FAB's row at ${width}`).toBeLessThan(
        8,
      );
    }
  });

  it('keeps every edge of it on the screen', () => {
    for (const width of [1180, 430]) {
      const r = at(width);
      const mic = painted(r.injected, `the mic at ${width}`);
      expect(mic[0], `left edge at ${width}`).toBeGreaterThanOrEqual(0);
      expect(mic[2], `right edge at ${width}`).toBeLessThanOrEqual(width);
      expect(mic[1], `top edge at ${width}`).toBeGreaterThanOrEqual(0);
      expect(mic[3], `bottom edge at ${width}`).toBeLessThanOrEqual(r.height);
    }
  });
});
