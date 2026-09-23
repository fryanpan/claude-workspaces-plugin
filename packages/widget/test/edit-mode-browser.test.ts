/**
 * The reader changes words on a page, and the agent is told what changed.
 *
 * `edit-mode-driver.ts` does it in headless Chromium on the two kinds of page
 * the widget lives on: a dev server on its own port that pasted the tag, and
 * a mock the board serves in a sandboxed frame. On each it taps the pencil,
 * taps the heading, types, and presses Send; reads what the board stored and
 * the page source back; reloads; then plays the agent (rewrites the source,
 * resolves the thread) and reloads again. These cases assert on the JSON it
 * prints.
 *
 * audit: no-text — the driver measures a running browser and server; the
 * only files it reads back are the fixtures it wrote.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
import type { Scenario } from './edit-mode-driver.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

const DRIVER = join(import.meta.dirname, 'edit-mode-driver.ts');
/** One launch, six bundle builds, six page loads across two pages. */
const SUITE_MS = 240_000;
const SPAWN_MS = 230_000;

/** The same words the driver types; importing them would run the driver. */
const BEFORE = 'Harborlight Street Projects';
const AFTER = 'Harborlight Street Works';

let result: { dev: Scenario; mock: Scenario } | null = null;
const surfaces = (): Array<[string, Scenario]> => {
  if (!result) throw new Error('the driver printed nothing');
  return [
    ['dev server', result.dev],
    ['mock', result.mock],
  ];
};

describe.skipIf(CHROME === null)('editing the words on a page', () => {
  beforeAll(() => {
    const r = spawnSync('bun', [DRIVER], { encoding: 'utf8', timeout: SPAWN_MS });
    expect(r.status, r.stderr).toBe(0);
    const last = r.stdout.trim().split('\n').pop() ?? '';
    result = JSON.parse(last) as { dev: Scenario; mock: Scenario };
  }, SUITE_MS);

  it('stores the element, the words before and the words after on the thread', () => {
    for (const [name, s] of surfaces()) {
      expect(s.stored, name).toEqual([
        { selector: 'h1', before: BEFORE, after: AFTER, anchorKind: 'element' },
      ]);
      expect(s.text, name).toBe(`1 text edit on this page:\n- h1: "${BEFORE}" → "${AFTER}"`);
    }
  });

  it('never writes the page source itself', () => {
    for (const [name, s] of surfaces()) expect(s.sourceUnchanged, name).toBe(true);
  });

  it('shows the original words with the pending edit marked after a reload', () => {
    for (const [name, s] of surfaces()) {
      expect(s.reloaded, name).toEqual({
        heading: BEFORE,
        pending: 1,
        green: 0,
        besideHeading: true,
        washAlpha: 0,
      });
    }
  });

  it('drops the mark once the agent applies the edit, and shows it applied in edit mode', () => {
    for (const [name, s] of surfaces()) {
      expect(s.applied, name).toEqual({
        heading: AFTER,
        pending: 0,
        green: 0,
        besideHeading: false,
        washAlpha: 0,
      });
      expect(s.appliedInMode.heading, name).toBe(AFTER);
      expect(s.appliedInMode.pending, name).toBe(0);
      expect(s.appliedInMode.green, name).toBe(1);
      // The wash tints the words; an opaque one hides them.
      expect(s.appliedInMode.washAlpha, name).toBeGreaterThan(0);
      expect(s.appliedInMode.washAlpha, name).toBeLessThan(0.5);
    }
  });
});
