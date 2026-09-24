/**
 * While voice records, the reader keeps using the page: a click runs the
 * page's own handler and pins nothing, typed keys land in the page's input,
 * and Escape is the page's too. Only the tap after Move is the widget's — it
 * re-points the comment and never reaches the page — and the hover outline
 * shows only while Move is armed.
 *
 * `voice-passthrough-driver.ts` loads the real widget and voice mode in
 * headless Chromium and drives it with CDP input: a mouse at 1180x820, touch
 * taps at 430x932.
 *
 * audit: no-text — the driver measures a running browser; nothing here reads
 * a source file, a bundle or a stylesheet.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
import type { Reading } from './voice-passthrough-driver.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

const DRIVER = join(import.meta.dirname, 'voice-passthrough-driver.ts');
const SUITE_MS = 60_000;
const SPAWN_MS = 55_000;

let readings: Reading[] = [];

describe.skipIf(CHROME === null)('the page, while voice records', () => {
  beforeAll(() => {
    const r = spawnSync('bun', [DRIVER], { encoding: 'utf8', timeout: SPAWN_MS });
    expect(r.status, r.stderr).toBe(0);
    readings = JSON.parse(r.stdout) as Reading[];
    expect(readings.map((x) => x.width)).toEqual([1180, 430]);
  }, SUITE_MS);

  it('runs a page button’s own handler on a plain click, and pins nothing', () => {
    for (const r of readings) {
      expect(r.savedByPlainClick, `the handler ran at ${r.width}`).toBe(1);
      expect(r.pinsAfterPlainClick, `no pin at ${r.width}`).toBe(0);
    }
  });

  it('lands typed keys in the page’s input', () => {
    for (const r of readings) expect(r.typed, `at ${r.width}`).toBe('Riverbend');
  });

  it('leaves Escape to the page and keeps recording', () => {
    for (const r of readings) {
      expect(r.escapeToPage, `not prevented at ${r.width}`).toBe(true);
      expect(r.stateAfterEscape, `at ${r.width}`).toBe('recording');
    }
  });

  it('re-points the comment on the tap after Move, and keeps that tap from the page', () => {
    for (const r of readings) {
      expect(r.armed, `Move armed at ${r.width}`).toBe(true);
      expect(r.savedAfterMoveTap, `the handler did not run again at ${r.width}`).toBe(1);
      expect(r.saveIndex, `the catalog names the button at ${r.width}`).not.toBeNull();
      expect(r.moveTarget, `moved to the tapped button at ${r.width}`).toBe(r.saveIndex);
    }
  });

  it('shows the hover outline only while Move is armed', () => {
    const r = readings.find((x) => !x.touch);
    if (!r) throw new Error('no mouse reading');
    expect(r.outlineRecording, 'recording, Move not armed').toBe(false);
    expect(r.outlineArmed, 'CONTROL: Move armed').toBe(true);
    expect(r.outlineAfterMove, 'after the move').toBe(false);
  });

  it('cancels an armed Move on Escape, and keeps that Escape from the page', () => {
    for (const r of readings) {
      expect(r.escapeCancelPrevented, `prevented at ${r.width}`).toBe(true);
      expect(r.pickingAfterEscape, `disarmed at ${r.width}`).toBeNull();
    }
  });
});
