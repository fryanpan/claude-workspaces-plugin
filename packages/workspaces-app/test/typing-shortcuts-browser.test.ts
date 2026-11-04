/**
 * Every single-key shortcut, typed into the agent chat on the front page,
 * the board, a workspace's Home, a doc and a task, lands in the box as text
 * and makes the page do nothing. With nothing editable focused, the same
 * keys still act. `typing-shortcuts-browser-driver.ts` drives a real
 * Chromium against real servers; these cases assert on its JSON.
 *
 * happy-dom does not retarget an event at a shadow boundary (a document
 * listener sees the inner textarea as `ev.target`), so the bug this guards
 * cannot be reproduced there: it needs a real browser.
 *
 * audit: no-text — the driver reads a running page; nothing here reads a
 * source file, a bundle or a stylesheet.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
import {
  type PageState,
  SHORTCUT_KEYS,
  type SurfaceReading,
  type TypingRun,
} from './typing-shortcuts-reading.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

const DRIVER = join(import.meta.dirname, 'typing-shortcuts-browser-driver.ts');
/** One bundle build, two servers, one browser, five pages. */
const SUITE_MS = 200_000;
const SPAWN_MS = 190_000;

let run: TypingRun | null = null;
const at = (surface: string): SurfaceReading => {
  const r = run?.readings.find((x) => x.surface === surface);
  if (!r) throw new Error(`the driver printed no ${surface} reading`);
  return r;
};

/** Everything a shortcut could have changed, without the box itself. */
const pageOf = (s: PageState) => {
  const { composerValue: _v, composerFocused: _f, ...rest } = s;
  return rest;
};

const SURFACES = ['front', 'board', 'home', 'doc', 'task'];

describe.skipIf(CHROME === null)('typing into the agent chat', () => {
  beforeAll(() => {
    const r = spawnSync('bun', [DRIVER], { encoding: 'utf8', timeout: SPAWN_MS });
    expect(r.status, r.stderr).toBe(0);
    run = JSON.parse(r.stdout.trim().split('\n').pop() ?? '') as TypingRun;
  }, SUITE_MS);

  it.each(SURFACES)('on the %s every shortcut key lands in the box as text', (surface) => {
    const { before, typed } = at(surface);
    expect(before.composerFocused).toBe(true);
    expect(before.composerValue).toBe('');
    expect(typed.composerValue).toBe(SHORTCUT_KEYS.join(''));
    expect(typed.composerFocused).toBe(true);
  });

  it.each(SURFACES)('on the %s the page does nothing while the box is typed in', (surface) => {
    const { before, typed } = at(surface);
    expect(pageOf(typed)).toEqual(pageOf(before));
  });

  it('on the front page no message is removed, and with the box let go `j` and `e` still act', () => {
    const { before, typed, control } = at('front');
    // CONTROL for the fixture: there were lines to remove.
    expect(before.inboxOpen).toBeGreaterThan(0);
    expect(typed.inboxOpen).toBe(before.inboxOpen);
    const [afterJ, afterE] = control;
    expect(afterJ?.inboxCursor).toBe(true);
    expect(afterE?.inboxOpen).toBe(before.inboxOpen - 1);
  });

  it('on the board, with the box let go, `j` focuses a row and `?` shows the key list', () => {
    const [afterJ, afterHelp] = at('board').control;
    expect(afterJ?.rowFocused).toBe(true);
    expect(afterHelp?.helpShown).toBe(true);
  });

  it.each(['home', 'task'])('on the %s, with the box let go, `?` shows the key list', (surface) => {
    const { before, control } = at(surface);
    expect(before.helpShown).toBe(false);
    expect(control[0]?.helpShown).toBe(true);
  });
});
