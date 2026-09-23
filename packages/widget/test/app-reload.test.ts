/**
 * A file change in an attached dev server's site reaches a page open
 * through the board, within five seconds, over the proxied reload stream.
 *
 * `app-reload-driver.ts` runs the site's dev server, a board server and
 * headless Chromium, changes the file, and reads the sandboxed frame until
 * the new version shows. This file asserts on what it read. It lives with
 * the widget's browser cases, not in the server suite, because the browser
 * gate opens only on the CI steps that run this package.
 *
 * audit: no-text — the driver reads a running page; nothing here reads a
 * source file, a bundle or a stylesheet.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
// Types only: importing a value would run the driver in this process.
import type { Reading } from './app-reload-driver.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

const DRIVER = join(import.meta.dirname, 'app-reload-driver.ts');
const SUITE_MS = 60_000;
const SPAWN_MS = 55_000;

let reading: Reading;

describe.skipIf(CHROME === null)("an attached dev server's reload stream", () => {
  beforeAll(() => {
    const r = spawnSync('bun', [DRIVER], { encoding: 'utf8', timeout: SPAWN_MS });
    expect(r.status, r.stderr).toBe(0);
    const last = r.stdout.trim().split('\n').at(-1) ?? '';
    reading = JSON.parse(last) as Reading;
  }, SUITE_MS);

  it('shows the app inside the frame, with its reload stream open through the board', () => {
    expect(reading.before).toBe('one');
    expect(reading.streamsAtChange).toBeGreaterThan(0);
  });

  it('shows the changed file without the reader doing anything', () => {
    expect(reading.after, JSON.stringify(reading)).toBe('two');
    expect(reading.arrived).toBe(true);
  });
});
