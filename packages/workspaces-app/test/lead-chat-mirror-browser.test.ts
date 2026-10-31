/**
 * The lead chat's mirror of the lead's session in a real browser, at
 * 1180x820, 1000x800 and 430x932: a tool call opens to its input and output, the
 * header's toggle hides board events, a spoken reply's words open on a tap,
 * the lead's text reaches an open page within a second, and on a wide
 * screen the panel docks on the right, resizes by its edge, and is open at
 * that width on the next page. `lead-chat-mirror-browser-driver.ts` does it
 * against a real server; these cases assert on its JSON.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
import type { MirrorRun } from './lead-chat-mirror-browser-reading.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

const DRIVER = join(import.meta.dirname, 'lead-chat-mirror-browser-driver.ts');
/** One bundle build, two launches, three page loads. */
const SUITE_MS = 200_000;
const SPAWN_MS = 190_000;

let run: MirrorRun | null = null;
const result = (): MirrorRun => {
  if (!run) throw new Error('the driver printed nothing');
  return run;
};

describe.skipIf(CHROME === null)('the lead chat mirror in a browser', () => {
  beforeAll(() => {
    const r = spawnSync('bun', [DRIVER], { encoding: 'utf8', timeout: SPAWN_MS });
    expect(r.status, r.stderr).toBe(0);
    run = JSON.parse(r.stdout.trim().split('\n').pop() ?? '') as MirrorRun;
  }, SUITE_MS);

  it('runs at both sizes', () => {
    expect(result().widths.map((w) => w.width)).toEqual([1180, 1000, 430]);
  }, 60_000);

  it('shows a tool call as one line that opens to its input and output', () => {
    for (const w of result().widths) {
      const at = String(w.width);
      expect(w.tool.head, at).toContain('Bash');
      expect(w.tool.head, at).toContain('git status --short');
      expect(w.tool.open, at).toEqual(['git status --short', ' M deploy.ts']);
      expect(w.tool.expanded, at).toBe('true');
    }
  }, 60_000);

  it('hides board events with the header’s toggle, counting them, and shows them again', () => {
    for (const w of result().widths) {
      const at = String(w.width);
      expect(w.channel.before, at).toBe(1);
      expect(w.channel.hidden, at).toBe(0);
      expect(w.channel.count, at).toBe('(1)');
      expect(w.channel.after, at).toBe(1);
      expect(w.channel.headerOneRow, at).toBe(true);
    }
  }, 60_000);

  it('shows a spoken reply collapsed, its words opening on a tap', () => {
    for (const w of result().widths) {
      const at = String(w.width);
      expect(w.voice.closedText, at).toBe(false);
      expect(w.voice.words, at).toContain('Two tasks, both in review.');
      expect(w.voice.label, at).toContain('Hide words');
    }
  }, 60_000);

  it('shows text the lead’s session wrote in the open chat within a second', () => {
    for (const w of result().widths) expect(w.liveWithin1s, String(w.width)).toBe(true);
  }, 60_000);

  it('docks on the right at 1180, resizes by its edge, and is open at that width on the next page', () => {
    const wide = result().widths.find((w) => w.width === 1180);
    expect(wide?.layout.docked).toBe(true);
    expect(wide?.layout.right).toBe(wide?.layout.vw);
    expect(wide?.layout.width).toBe(420);
    expect(wide?.resized?.width).toBeGreaterThanOrEqual(510);
    expect(wide?.resized?.width).toBeLessThanOrEqual(530);
    expect(wide?.afterNav).toEqual({ open: true, width: wide?.resized?.width, docked: true });
  }, 60_000);

  // 1000 is the tier where the bar is a strip along the TOP until the chat
  // opens, so only the full-screen rules put it at the bottom there.
  it.each([1000, 430])(
    'fills the screen at %i down to the navbar pinned at the bottom, and a page tap closes it',
    (at) => {
      const f = result().widths.find((w) => w.width === at)?.full;
      expect(f).not.toBeNull();
      if (!f) return;
      expect(f.paneTop).toBe(0);
      expect(Math.abs(f.paneBottom - f.navTop)).toBeLessThanOrEqual(1);
      expect(Math.abs(f.navBottom - f.vh)).toBeLessThanOrEqual(1);
      expect(f.navLeft).toBeGreaterThanOrEqual(0);
      expect(f.navWidth).toBeLessThanOrEqual(at);
      expect(f.agentFirst).toBe(true);
      expect(f.closedByPageTap).toBe(true);
      expect(f.libraryCurrent).toBe('page');
    },
    60_000,
  );

  it('is a sheet, not docked, at 430', () => {
    const narrow = result().widths.find((w) => w.width === 430);
    expect(narrow?.layout.sheet).toBe(true);
    expect(narrow?.layout.docked).toBe(false);
  }, 60_000);
});
