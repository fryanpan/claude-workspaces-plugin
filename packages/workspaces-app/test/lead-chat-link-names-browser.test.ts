/**
 * A link to a board doc in the lead's reply reads as the doc's name, and a
 * click on it stays in the board's tab while the platform's new-tab click
 * opens a new one (Bryan, 1 Nov: chat links did nothing). On a board's
 * Home at 1180x820 and 430x932. `lead-chat-link-names-browser-driver.ts`
 * drives the page against a real server; these cases assert on its JSON.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
// Types only: importing a value would run the driver in this process.
import type { NamesRun } from './lead-chat-link-names-browser-driver.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

const DRIVER = join(import.meta.dirname, 'lead-chat-link-names-browser-driver.ts');
/** One bundle build, two launches, six page loads. */
const SUITE_MS = 200_000;
const SPAWN_MS = 190_000;
/** The driver's doc title and the author's own label. */
const DOC_TITLE = 'What We Know';
const OWN_LABEL = 'the research notes';

let run: NamesRun | null = null;
const result = (): NamesRun => {
  if (!run) throw new Error('the driver printed nothing');
  return run;
};

describe.skipIf(CHROME === null)('a link to a board doc in the lead’s reply', () => {
  beforeAll(() => {
    const r = spawnSync('bun', [DRIVER], { encoding: 'utf8', timeout: SPAWN_MS });
    expect(r.status, r.stderr).toBe(0);
    run = JSON.parse(r.stdout.trim().split('\n').pop() ?? '') as NamesRun;
  }, SUITE_MS);

  it('runs at both sizes', () => {
    expect(result().widths.map((w) => w.width)).toEqual([1180, 430]);
  }, 60_000);

  it('reads as the doc’s name, never its URL or id, and keeps an author’s own words', () => {
    for (const w of result().widths) {
      // Bare absolute, bare relative, labelled with the URL, labelled with
      // the id, and labelled in the author's words — the control that the
      // title is not simply pasted over every label.
      expect(w.texts, String(w.width)).toEqual([
        DOC_TITLE,
        DOC_TITLE,
        DOC_TITLE,
        DOC_TITLE,
        OWN_LABEL,
      ]);
    }
  }, 60_000);

  it('opens the doc in the same tab on a plain click', () => {
    for (const w of result().widths) {
      expect(w.targets, String(w.width)).toEqual([null, null, null, null, null]);
      expect(w.plain.opened, String(w.width)).toEqual([]);
      expect(new URL(w.plain.pageUrl).pathname, String(w.width)).toBe(w.docPath);
    }
  }, 60_000);

  it('opens the doc in a new tab on a Cmd- or Ctrl-click, leaving the board where it was', () => {
    for (const w of result().widths) {
      expect(
        w.newTab.opened.map((u) => new URL(u).pathname),
        String(w.width),
      ).toEqual([w.docPath]);
      expect(new URL(w.newTab.pageUrl).pathname, String(w.width)).not.toBe(w.docPath);
    }
  }, 60_000);
});
