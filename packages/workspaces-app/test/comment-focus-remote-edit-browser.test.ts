/**
 * Typing a comment while an agent edits the doc keeps the caret, the words
 * and the reader's place. `comment-focus-remote-edit-driver.ts` does it in
 * headless Chromium against a real server and the real doc bundle, at
 * 1180x820 and 430x932, for a new comment and for a reply, with the agent's
 * edits going through the REST routes the MCP edit tools call; these cases
 * assert on the JSON it prints.
 *
 * Positive control: with the five source files of the fix restored to
 * 913ea977b, 8 of these 21 cases fail. Blocks inserted above the reader moved
 * the commented words down the screen in every scenario — 488px for a new
 * comment at 1180, 274px for a reply at 1180, 329px at 430 — because the
 * reading hold followed a `<p>` that ProseMirror had reused for another
 * paragraph. At 430 the reply box also lost focus to `body` on that edit, and
 * every word typed after it went somewhere other than the reply.
 *
 * Two more edits per scenario: a paragraph lengthened between the pane's top
 * edge and the commented words, and a burst of four edits inside a second
 * while the reader types. On b6139328e 5 of the 21 cases fail on the first:
 * the commented words moved 30px at 1180 for a reply, and 74px (new comment)
 * and 99px (reply) at 430, because the hold kept the topmost line still.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
import type { ComposerKind, FocusRun, FocusScenario } from './comment-focus-remote-edit-reading.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

const DRIVER = join(import.meta.dirname, 'comment-focus-remote-edit-driver.ts');
/** Two bundle builds, four launches, four page loads and thirty-two edits. */
const SUITE_MS = 260_000;
const SPAWN_MS = 250_000;

/** Sub-pixel layout and rounding: a line that moved by less has not moved. */
const STILL_PX = 2;
/**
 * The inside edit lengthens the commented paragraph by about two hundred
 * characters, and an in-flow card sits under that paragraph, so the card
 * moves down by the paragraph's new lines (99px measured at 430). Anything
 * past this is more than that paragraph can account for.
 */
const INSIDE_GROWTH_PX = 200;

let run: FocusRun | null = null;
const scenario = (width: number, kind: ComposerKind): FocusScenario => {
  if (!run) throw new Error('the driver printed nothing');
  const s = run.scenarios.find((x) => x.width === width && x.kind === kind);
  if (!s) throw new Error(`no ${width} ${kind} scenario`);
  return s;
};

describe.skipIf(CHROME === null)('typing a comment while an agent edits the doc', () => {
  beforeAll(() => {
    const r = spawnSync('bun', [DRIVER], { encoding: 'utf8', timeout: SPAWN_MS });
    expect(r.status, r.stderr).toBe(0);
    run = JSON.parse(r.stdout.trim().split('\n').pop() ?? '') as FocusRun;
  }, SUITE_MS);

  for (const width of [1180, 430]) {
    for (const kind of ['new', 'reply'] as const) {
      describe(`${width}px, ${kind === 'new' ? 'a new comment' : 'a reply'}`, () => {
        it('the box held the caret before any edit', () => {
          expect(scenario(width, kind).opened.focus).toBe('composer');
        });

        it('keeps the caret in the box through every edit', () => {
          for (const st of scenario(width, kind).steps) {
            expect(st.landed.focus, st.where).toBe('composer');
            expect(st.after.focus, st.where).toBe('composer');
          }
        });

        it('keeps every word typed, in the box', () => {
          const s = scenario(width, kind);
          for (const st of s.steps) expect(st.after.text, st.where).toBe(st.typed);
          expect(s.final.text).toBe(s.typed);
          expect(s.final.focus).toBe('composer');
        });

        it('holds the commented words on the pixel they were on', () => {
          for (const st of scenario(width, kind).steps) {
            expect(st.before.anchorTop, st.where).not.toBeNull();
            const moved = (st.landed.anchorTop ?? Number.NaN) - (st.before.anchorTop ?? 0);
            expect(Math.abs(moved), `${st.where}: ${moved}px`).toBeLessThanOrEqual(STILL_PX);
          }
        });

        it('leaves the box where the reader was typing', () => {
          for (const st of scenario(width, kind).steps) {
            expect(st.before.boxTop, st.where).not.toBeNull();
            const moved = (st.landed.boxTop ?? Number.NaN) - (st.before.boxTop ?? 0);
            if (st.where === 'inside') {
              expect(moved, `${st.where}: ${moved}px`).toBeGreaterThanOrEqual(-STILL_PX);
              expect(moved, `${st.where}: ${moved}px`).toBeLessThanOrEqual(INSIDE_GROWTH_PX);
            } else if (st.where === 'burst') {
              // The reader types during a burst, so the box may have grown by
              // their own words. Its placement is a function of the commented
              // words (held still, asserted above), the screen, and its own
              // height: the sheet at 430 grows up from its pinned bottom, and
              // the margin lifts a growing card so its footer stays on screen
              // (fit-to-fold, redline/markup-margin.ts). So a box that did not
              // grow stays put, and one that grew may only rise, by less than
              // it grew. An edit that moved the box does neither.
              const bottom = (st.landed.boxBottom ?? Number.NaN) - (st.before.boxBottom ?? 0);
              const grew = bottom - moved;
              const still =
                Math.abs(moved) <= STILL_PX || (grew > STILL_PX && moved < 0 && -moved <= grew);
              expect(still, `${st.where}: top ${moved}px, bottom ${bottom}px, grew ${grew}px`).toBe(
                true,
              );
            } else {
              expect(Math.abs(moved), `${st.where}: ${moved}px`).toBeLessThanOrEqual(STILL_PX);
            }
          }
        });
      });
    }
  }

  it('ran every edit in every scenario', () => {
    expect(run?.scenarios.map((s) => `${s.width} ${s.kind} ${s.steps.length}`)).toEqual([
      '1180 new 5',
      '1180 reply 5',
      '430 new 5',
      '430 reply 5',
    ]);
  });
});
