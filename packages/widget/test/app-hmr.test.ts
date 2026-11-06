/**
 * An attached app reloads through its framework's own socket, with no reload
 * code in the app and no setting but the base the board's prefix asks for.
 *
 * `app-hmr-driver.ts` runs real Vite behind `attach_app` in headless Chromium.
 * Each word below reached the running frame after a save to the file on disk,
 * so a word arriving is the framework's client doing its job through the
 * board's relay and the app socket route. The third and fourth are after the
 * dev server was killed and started again, which is the client reconnecting.
 *
 * audit: no-text — the driver reads a running page; nothing here reads a
 * source file, a bundle or a stylesheet.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
// Types only: importing a value would run the driver in this process.
import type { HmrReading } from './app-hmr-driver.ts';

/** The browser these cases may launch, or null to skip them. */
const CHROME = chromeForSuite();

const DRIVER = join(import.meta.dirname, 'app-hmr-driver.ts');
const SUITE_MS = 120_000;
const SPAWN_MS = 110_000;

let reading: HmrReading;

describe.skipIf(CHROME === null)('real Vite behind attach_app, in a real browser', () => {
  beforeAll(() => {
    const r = spawnSync('bun', [DRIVER], { encoding: 'utf8', timeout: SPAWN_MS });
    expect(r.status, r.stderr).toBe(0);
    reading = JSON.parse(r.stdout.trim().split('\n').at(-1) ?? '') as HmrReading;
  }, SUITE_MS);

  it('connects its own client through the board', () => {
    expect(reading.loaded).toBe('first');
    expect(reading.viteLog).toContain('[vite] connected.');
  });

  it('shows a saved change with no reload code in the app', () => {
    expect(reading.afterSave).toBe('second');
  });

  it('reconnects by itself after the dev server restarts', () => {
    expect(reading.viteLog).toContain('[vite] server connection lost. Polling for restart...');
    expect(reading.afterRestart).toBe('third');
    expect(reading.afterSecondSave).toBe('fourth');
  });
});
