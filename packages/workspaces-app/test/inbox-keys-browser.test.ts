/**
 * Incoming Messages answers the keyboard on a loaded front page: `j` then
 * `o` opens the next line, `?` shows the key list as a dialog that takes no
 * room in the section, and `e` removes a line into the Removed fold.
 *
 * `inbox-keys-driver.ts` boots a server with fixture rows, opens `/` through
 * the owner's Access door in headless Chromium, and presses real keys. This
 * file asserts on what it read.
 *
 * WHAT IT COULD NOT REPRODUCE. Bryan's report was from an iPad. On this page
 * as it stood, Chromium and WebKit both moved and opened on `j`/`o` once the
 * page had loaded; the one difference found is that nothing held focus at
 * load (`document.activeElement` was `<body>`), and Safari never focuses a
 * tapped button. So the section now takes focus itself, and the first case
 * asserts that.
 *
 * audit: no-text — the driver reads a running page; nothing here reads a
 * source file, a bundle or a stylesheet.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
// Types only: importing a value would run the driver in this process.
import type { Reading } from './inbox-keys-driver.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

const DRIVER = join(import.meta.dirname, 'inbox-keys-driver.ts');
const SUITE_MS = 120_000;
const SPAWN_MS = 110_000;

let reading: Reading;

describe.skipIf(CHROME === null)('Incoming Messages and the keyboard', () => {
  beforeAll(() => {
    const r = spawnSync('bun', [DRIVER], { encoding: 'utf8', timeout: SPAWN_MS });
    expect(r.status, r.stderr).toBe(0);
    reading = JSON.parse(r.stdout.trim().split('\n').at(-1) ?? '') as Reading;
  }, SUITE_MS);

  it('the section holds focus once the page loads, so a key has somewhere to go', () => {
    expect(reading.focusAtLoad).toBe('section#inbox');
  });

  it('no line carries the cursor before a key, and the first j lands on the first line', () => {
    expect(reading.cursorAtLoad).toBeNull();
    expect(reading.firstLine).not.toBeNull();
    expect(reading.cursorAfterJ).toBe(reading.firstLine);
    expect(reading.cursorAfterJJ).toBe(reading.secondLine);
  });

  it('the cursor line is drawn differently from a plain one, and is wholly in view', () => {
    // Positive control: the plain line paints its button white with no bar.
    expect(reading.plainLook.boxShadow).toBe('none');
    expect(reading.cursorLook.boxShadow).toContain('inset');
    expect(reading.cursorLook.lineBackground).not.toBe(reading.plainLook.lineBackground);
    // The bar is on the element painted at the line's edge, not under it.
    expect(reading.cursorLook.atLeftEdge).toContain('board-review-row');
    expect(reading.cursorInView).toBe(true);
  });

  it('a second j moves to the next line and o opens it with its message', () => {
    expect(reading.secondLine).not.toBeNull();
    expect(reading.openAfterO).toBe(reading.secondLine);
    expect(reading.messageAfterO).toBe('Message 2 text.');
  });

  it('? opens the key list as a dialog naming e, without changing the section height', () => {
    expect(reading.keysDialog).toBe('Keyboard shortcuts');
    expect(reading.keysNameE).toBe(true);
    expect(reading.heightWithKeys).toBe(reading.heightBefore);
    expect(reading.dialogAfterEscape).toBe(false);
  });

  it('e removes the cursor line into the Removed fold, with an Undo toast', () => {
    expect(reading.removedFold).toBe('Show 1 removed');
    expect(reading.toast).toBe('Removed.');
    expect(reading.openLinesAfterE).toBe(2);
  });
});
