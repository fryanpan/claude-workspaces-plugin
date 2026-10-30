/**
 * A reader on an inner screen of a mock stays there when the agent saves the
 * next round.
 *
 * `mock-swap-state-driver.ts` serves a two-tab mock from a real board server
 * into headless Chromium, taps the second tab, scrolls, rewrites the file and
 * reports what the frame shows before and after the round swaps in.
 *
 * audit: no-text — the driver reads a running page; nothing here reads a
 * source file, a bundle or a stylesheet.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
// Types only: importing a value would run the driver in this process.
import type { Reading } from './mock-swap-state-driver.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

const DRIVER = join(import.meta.dirname, 'mock-swap-state-driver.ts');
const SUITE_MS = 120_000;
const SPAWN_MS = 110_000;

let reading: Reading;

describe.skipIf(CHROME === null)('a mock round landing under a reader on its second tab', () => {
  beforeAll(() => {
    const r = spawnSync('bun', [DRIVER], { encoding: 'utf8', timeout: SPAWN_MS });
    expect(r.status, r.stderr).toBe(0);
    const last = r.stdout.trim().split('\n').at(-1) ?? '';
    reading = JSON.parse(last) as Reading;
  }, SUITE_MS);

  it('CONTROL: the reader was on the second tab, scrolled, before the save', () => {
    expect(reading.before.tab).toBe('Closed permits');
    expect(reading.before.scrollY).toBe(900);
  });

  it('shows round two on the tab the reader was on', () => {
    expect(reading.after.round).toBe('Round 2');
    expect(reading.after.tab).toBe('Closed permits');
  });

  it("keeps the frame's query, hash and scroll", () => {
    expect(reading.after.search).toBe(reading.before.search);
    expect(reading.after.search).toContain('view=list');
    expect(reading.after.hash).toBe('#notes');
    expect(reading.after.scrollY).toBe(900);
  });
});
