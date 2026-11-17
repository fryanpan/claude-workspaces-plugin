/**
 * A tap on the lead chat's bar opens the chat even when the bar's words
 * redraw between the press and the release. Chrome sends no click when the
 * pressed element has left the page, so the rows must be updated in place.
 * `lead-chat-bar-tap-browser-driver.ts` does the tapping; this asserts on it.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
import type { BarTapCase } from './lead-chat-bar-tap-browser-driver.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

const BROWSER_CASE_MS = 60_000;

describe.skipIf(CHROME === null)('the lead chat bar in headless Chrome', () => {
  it(
    'takes a tap whose release lands after the rows redraw',
    () => {
      const r = spawnSync(
        'bun',
        [join(import.meta.dirname, 'lead-chat-bar-tap-browser-driver.ts'), CHROME ?? ''],
        {
          encoding: 'utf8',
          timeout: BROWSER_CASE_MS - 10_000,
        },
      );
      expect(r.status, r.stderr).toBe(0);
      const cases = JSON.parse(r.stdout) as BarTapCase[];
      expect(cases.map((k) => k.name)).toHaveLength(4);
      for (const k of cases) expect({ [k.name]: k.clicks }).toEqual({ [k.name]: 1 });
      // The long case presses the cut words themselves, not the label.
      const long = cases.at(-1);
      expect(long?.cut).toBe(true);
      expect(long?.pressed).toBe('lc-tail-text');
    },
    BROWSER_CASE_MS,
  );
});
