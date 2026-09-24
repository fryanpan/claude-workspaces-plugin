/**
 * The reader keeps typing while the agent rebuilds the page, and loses
 * nothing to the reload.
 *
 * `draft-reload-driver.ts` does it in headless Chromium on the three kinds of
 * page the widget lives on: a dev server opened through the board's app
 * address (its live reload reloads the sandboxed frame), a mock the board
 * serves (the reader reloads it, then the agent writes round two), and a
 * plain page that embeds the widget. On each it leaves an edit unsent and a
 * comment open, reloads, and reads what came back. Then the negative
 * control: posted, cancelled or sent, nothing comes back. These cases assert
 * on the JSON it prints.
 *
 * audit: no-text — the driver measures a running browser and server.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
import { COMMENT, EDITED, HEADING, LEDE, type Reading, type Shown } from './draft-reload-page.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

const DRIVER = join(import.meta.dirname, 'draft-reload-driver.ts');
/** One launch, one bundle build, fourteen page loads across three pages. */
const SUITE_MS = 240_000;
const SPAWN_MS = 230_000;
const CASE_MS = 60_000;

/** A page showing the comment open on the heading, and the edit unsent. */
const kept: Shown = { mode: true, open: true, text: COMMENT, on: HEADING, lede: EDITED, bars: 1 };

let r: Reading | null = null;
const reading = (): Reading => {
  if (!r) throw new Error('the driver printed nothing');
  return r;
};

describe.skipIf(CHROME === null)('unsent words across a reload', () => {
  beforeAll(() => {
    const out = spawnSync('bun', [DRIVER], { encoding: 'utf8', timeout: SPAWN_MS });
    expect(out.status, out.stderr).toBe(0);
    r = JSON.parse(out.stdout.trim().split('\n').pop() ?? '') as Reading;
  }, SUITE_MS);

  it(
    'shows the comment and the edit on each page before it reloads',
    () => {
      const { typed } = reading();
      for (const [page, shown] of Object.entries(typed)) expect(shown, page).toEqual(kept);
    },
    CASE_MS,
  );

  it(
    "brings back the open comment and the unsent edit after the app's live reload",
    () => {
      expect(reading().appReloaded).toEqual(kept);
    },
    CASE_MS,
  );

  it(
    'brings them back after the reader reloads a mock, and keeps them through its next round',
    () => {
      expect(reading().mockReloaded).toEqual(kept);
      expect(reading().mockSwapped).toEqual({ ...kept, roundTwo: true });
    },
    CASE_MS,
  );

  it(
    'brings them back on a plain page, and on that page only',
    () => {
      expect(reading().plainReloaded).toEqual(kept);
      expect(reading().plainOtherPage).toEqual({
        mode: false,
        open: false,
        text: null,
        on: null,
        lede: LEDE,
        bars: 0,
      });
    },
    CASE_MS,
  );

  it(
    'brings nothing back once the comment is posted, a comment is cancelled, or the edits are sent',
    () => {
      const { afterPost, afterCancel, afterSend } = reading();
      expect(afterPost.posted).toBe(true);
      expect([afterPost.mode, afterPost.open]).toEqual([false, false]);
      expect([afterCancel.mode, afterCancel.open]).toEqual([false, false]);
      expect(afterSend).toEqual({ sent: true, unsent: 0 });
    },
    CASE_MS,
  );
});
