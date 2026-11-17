/**
 * The lead chat opened on a doc page sits beside the doc's text, not on top
 * of it (Bryan: "the chat box is overlapping the rest of the document. The
 * chat box should be a fixed-right panel"). At 1180x820 the open panel docks
 * on the right and the doc column ends at its left edge; closing it gives the
 * column its width back. At 430 wide the panel is a full-screen sheet whose
 * Close is on screen, and closing it leaves the doc as it was.
 *
 * `doc-lead-chat-dock-browser-driver.ts` drives a real server and the real
 * doc bundle in headless Chromium; these cases assert on its JSON.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
import type { DocDockRun, DocDockWidth } from './doc-lead-chat-dock-browser-reading.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

const DRIVER = join(import.meta.dirname, 'doc-lead-chat-dock-browser-driver.ts');
/** One bundle build, two launches, two page loads. */
const SUITE_MS = 200_000;
const SPAWN_MS = 190_000;
const CASE_MS = 60_000;

let run: DocDockRun | null = null;
const at = (width: number): DocDockWidth => {
  const w = run?.widths.find((x) => x.width === width);
  if (!w) throw new Error(`the driver printed no run at ${width}`);
  return w;
};

describe.skipIf(CHROME === null)('the lead chat on a doc page', () => {
  beforeAll(() => {
    const r = spawnSync('bun', [DRIVER], { encoding: 'utf8', timeout: SPAWN_MS });
    expect(r.status, r.stderr).toBe(0);
    run = JSON.parse(r.stdout.trim().split('\n').pop() ?? '') as DocDockRun;
  }, SUITE_MS);

  it(
    'opens the panel and shows the doc text at both sizes',
    () => {
      for (const width of [1180, 430]) {
        const w = at(width);
        expect(w.open.pane, String(width)).not.toBeNull();
        expect(w.before.column?.height ?? 0, String(width)).toBeGreaterThan(0);
        expect(w.after.pane, String(width)).toBeNull();
      }
    },
    CASE_MS,
  );

  it(
    'at 1180x820 docks the panel beside the doc column, covering none of its text',
    () => {
      const { open } = at(1180);
      const pane = open.pane;
      const col = open.column;
      if (!pane || !col) throw new Error('no panel or no column');
      // Docked on the right, the full height under the top of the window.
      expect(pane.left + pane.width).toBe(open.viewport);
      expect(pane.left).toBeGreaterThan(open.viewport / 2);
      expect(col.left + col.width).toBeLessThanOrEqual(pane.left);
      // The doc's own top bar ends where the panel begins.
      expect(open.topbar?.width).toBe(pane.left);
      expect(open.covered).toBe(0);
    },
    CASE_MS,
  );

  it(
    'at 1180x820 moves the comment cards into the flow while the panel is docked',
    () => {
      const w = at(1180);
      expect(w.before.cards).toBe('balloon');
      expect(w.open.cards).toBe('inline');
      expect(w.after.cards).toBe('balloon');
    },
    CASE_MS,
  );

  it(
    'at 1180x820 gives the column its full width back when the panel closes',
    () => {
      const w = at(1180);
      expect(w.after.column?.width).toBe(w.before.column?.width);
      expect(w.after.column?.left).toBe(w.before.column?.left);
      expect(w.after.topbar?.width).toBe(w.after.viewport);
    },
    CASE_MS,
  );

  it(
    'keeps the reader on the same paragraph as the panel opens and closes',
    () => {
      for (const width of [1180, 430]) {
        const w = at(width);
        // CONTROL: the driver scrolled into the doc, so a page that jumped
        // back to the top fails here rather than reading 0 === 0.
        expect(w.before.topPara, String(width)).toBeGreaterThan(2);
        expect(w.open.topPara, String(width)).toBe(w.before.topPara);
        expect(w.after.topPara, String(width)).toBe(w.before.topPara);
      }
    },
    CASE_MS,
  );

  it(
    'at 430 wide opens a full-width sheet whose Close is on screen, and leaves the doc as it was',
    () => {
      const w = at(430);
      const pane = w.open.pane;
      const close = w.open.close;
      if (!pane || !close) throw new Error('no sheet or no Close');
      expect(pane.left).toBe(0);
      expect(pane.width).toBe(w.open.viewport);
      expect(close.left).toBeGreaterThanOrEqual(0);
      expect(close.left + close.width).toBeLessThanOrEqual(w.open.viewport);
      expect(close.top).toBeGreaterThanOrEqual(0);
      // CONTROL for the cover probe the 1180 case reads as 0: a sheet over
      // the text is counted.
      expect(w.open.covered).toBeGreaterThan(0);
      expect(w.after.column).toEqual(w.before.column);
    },
    CASE_MS,
  );
});
