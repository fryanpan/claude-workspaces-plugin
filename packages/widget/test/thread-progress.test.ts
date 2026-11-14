/**
 * An agent marks a comment in progress, then done, on an attached app's page
 * that is already open; the marks show without a reload, and a done comment
 * stays on the page until a person resolves it.
 *
 * `thread-progress-driver.ts` runs a board server, a dev server and headless
 * Chromium. This file asserts on what it read.
 *
 * audit: no-text — the driver reads a running page; nothing here reads a
 * source file, a bundle or a stylesheet.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
// Types only: importing a value would run the driver in this process.
import type { Reading } from './thread-progress-driver.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

const DRIVER = join(import.meta.dirname, 'thread-progress-driver.ts');
const SUITE_MS = 120_000;
const SPAWN_MS = 115_000;

describe.skipIf(CHROME === null)("an agent's mark on a comment, on an open app page", () => {
  let reading: Reading;

  beforeAll(() => {
    const r = spawnSync('bun', [DRIVER], { encoding: 'utf8', timeout: SPAWN_MS });
    expect(r.status, r.stderr).toBe(0);
    reading = JSON.parse(r.stdout.trim().split('\n').at(-1) ?? '') as Reading;
  }, SUITE_MS);

  it('shows In progress on the pin and the card, with no reload', () => {
    expect(reading.working.shown, JSON.stringify(reading)).toBe(true);
    expect(reading.working.word).toBe('In progress');
    expect(reading.sameDocument).toBe(true);
  });

  it('then shows Done on the pin and the card, with no reload', () => {
    expect(reading.done.shown, JSON.stringify(reading)).toBe(true);
    expect(reading.done.word).toBe('Done');
    expect(reading.sameDocument).toBe(true);
  });

  it('keeps a done comment on the page until a person resolves it', () => {
    expect(reading.doneShown, JSON.stringify(reading)).toBe(true);
    expect(reading.holdReads).toBeGreaterThan(0);
    expect(reading.stayed, JSON.stringify(reading)).toBe(true);
    expect(reading.leftAfterResolve, JSON.stringify(reading)).toBe(true);
  });
});
