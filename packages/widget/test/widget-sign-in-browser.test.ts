/**
 * The widget on an app page signs in through the popup and posts a comment
 * with the one-day board token (`wt2`), which replaced the retired seven-day
 * popup token.
 *
 * `widget-sign-in-driver.ts` runs a real server that refuses unsigned writes,
 * serves an app page from another origin, and drives headless Chromium with
 * real presses: open the widget, pick a paragraph, type, Post, then the
 * composer's Sign in. It reads back the token the widget stored and the
 * comment the server holds.
 *
 * audit: no-text — the driver reads a running server and page; nothing here
 * reads a source file, a bundle or a stylesheet.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
// Types only: importing a value would run the driver in this process.
import type { SignInReading } from './widget-sign-in-driver.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

const DRIVER = join(import.meta.dirname, 'widget-sign-in-driver.ts');
/** A widget build, a server, one launch, a page load and a popup. */
const SUITE_MS = 120_000;
const SPAWN_MS = 110_000;

let reading: SignInReading;

describe.skipIf(CHROME === null)('the widget signs in and posts on a board token', () => {
  beforeAll(() => {
    const r = spawnSync('bun', [DRIVER], { encoding: 'utf8', timeout: SPAWN_MS });
    expect(r.status, r.stderr).toBe(0);
    const last = r.stdout.trim().split('\n').at(-1) ?? '';
    reading = JSON.parse(last) as SignInReading;
  }, SUITE_MS);

  it('CONTROL: the unsigned post is refused, so the composer offers sign-in', () => {
    expect(reading.offered).toBe(true);
  });

  it('stores a board token for this page’s board, not the retired popup token', () => {
    // The browser's pages ride on the message: a refused hand-back leaves
    // the popup open with the line that says why.
    expect(reading.tokenTag, JSON.stringify(reading.pages)).toBe('wt2.');
    expect(reading.tokenBoard).toBe(reading.board);
  });

  it('posts the draft as the signed-in person once the token arrives', () => {
    expect(reading.comment).toEqual({
      text: 'the last sailing is missing',
      authorId: reading.signedInAs,
    });
  });
});
