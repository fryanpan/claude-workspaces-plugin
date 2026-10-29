/**
 * On a code file's diff, the comment pill sits just right of the text it
 * comments on. `code-diff-pill-browser-driver.ts` selects and clicks in
 * headless Chromium against a real server and the real doc bundle, at
 * 1180x820 and 430x932; these cases assert on the JSON it prints.
 *
 * Positive control: run against origin/main's bundle (`CODE_PILL_APP`
 * pointed at a checkout of it) the line-start and click cases fail at both
 * widths, and the tap case at 430. A selection dragged to the start of a
 * later line put the pill at that line's left edge, because the DOM range's
 * last rect is a zero-width one at column 0; a click or a tap showed no pill
 * at all, because the line-snapped selection a bare cursor produces was read
 * as a range. The within-line and long-press cases passed there too.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
import type { PillReading, PillRun, PillWidth } from './code-diff-pill-browser-reading.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

const DRIVER = join(import.meta.dirname, 'code-diff-pill-browser-driver.ts');
/** One bundle build, two launches, two page loads. */
const SUITE_MS = 200_000;
const SPAWN_MS = 190_000;

let run: PillRun | null = null;
const result = (): PillRun => {
  if (!run) throw new Error('the driver printed nothing');
  return run;
};

/** Showing, starting within a small gap right of the text's last character,
 *  and centred on that character's line. */
const besideText = (r: PillReading | null, what: string): void => {
  expect(r, what).not.toBeNull();
  const { pill, text } = r as PillReading;
  expect(pill, `${what}: no pill`).not.toBeNull();
  if (!pill) return;
  expect(pill.left, `${what}: pill left of the text's end`).toBeGreaterThanOrEqual(text.right);
  expect(pill.left, `${what}: pill far from the text's end`).toBeLessThanOrEqual(text.right + 16);
  const mid = (pill.top + pill.bottom) / 2;
  expect(mid, `${what}: pill above the line`).toBeGreaterThanOrEqual(text.top);
  expect(mid, `${what}: pill below the line`).toBeLessThanOrEqual(text.bottom);
};

const widths = (): PillWidth[] => [result().wide, result().phone];

describe.skipIf(CHROME === null)('the comment pill on a code diff', () => {
  beforeAll(() => {
    const r = spawnSync('bun', [DRIVER], { encoding: 'utf8', timeout: SPAWN_MS });
    expect(r.status, r.stderr).toBe(0);
    run = JSON.parse(r.stdout.trim().split('\n').pop() ?? '') as PillRun;
  }, SUITE_MS);

  it('sits right of a selection dragged within one line', () => {
    for (const w of widths()) besideText(w.withinLine, `${w.width} within a line`);
  });

  it('sits right of the last selected text when the drag ends at a line start', () => {
    for (const w of widths()) besideText(w.toLineStart, `${w.width} to a line start`);
  });

  it('shows at the end of a clicked line', () => {
    for (const w of widths()) besideText(w.click, `${w.width} click`);
  });

  it('shows at the end of a tapped line, and right of a long-press selection, at 430', () => {
    besideText(result().phone.tap, '430 tap');
    besideText(result().phone.longPress, '430 long-press');
  });
});
