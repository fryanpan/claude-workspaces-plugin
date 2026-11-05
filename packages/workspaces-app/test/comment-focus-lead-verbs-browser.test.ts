/**
 * Typing a comment while a lead edits the doc keeps the caret, every word,
 * the reader's place and the diagram, through every edit verb a lead has
 * (`comment-focus-lead-verbs-edits.ts` lists them), at 1180x820 and 430x932,
 * for a new comment and for a reply. The first step is the outline read on a
 * doc whose blocks have no ids yet. The driver,
 * `comment-focus-lead-verbs-driver.ts`, runs them in headless Chromium
 * against a real server and the real doc bundle; these cases assert on the
 * JSON it prints.
 *
 * Positive control: with `thread-decorations.ts` and `md-composer-chunk.ts`
 * restored to 39c9398d0, the outline read fails all four scenarios. The
 * diagram is redrawn empty (312px to 0) in all four, and at 1180 the
 * commented words move 312px for a new comment. At 430 the reply loses focus
 * to `body`, and every later word goes into the doc. At 1180 the reply also
 * loses keys when its card is rebuilt, first at replace_block, so its text
 * is wrong from there to the end of the run.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
import { LEAD_EDIT_ORDER } from './comment-focus-lead-verbs-edits.ts';
import type { LeadVerbsRun, LeadVerbsScenario } from './comment-focus-lead-verbs-reading.ts';
import type { ComposerKind } from './comment-focus-remote-edit-reading.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

const DRIVER = join(import.meta.dirname, 'comment-focus-lead-verbs-driver.ts');
/** Two bundle builds, four launches, four page loads and sixty-four edits. */
const SUITE_MS = 490_000;
const SPAWN_MS = 480_000;

/** Sub-pixel layout and rounding: a line that moved by less has not moved. */
const STILL_PX = 2;

let run: LeadVerbsRun | null = null;
const scenario = (width: number, kind: ComposerKind): LeadVerbsScenario => {
  if (!run) throw new Error('the driver printed nothing');
  const s = run.scenarios.find((x) => x.width === width && x.kind === kind);
  if (!s) throw new Error(`no ${width} ${kind} scenario`);
  return s;
};

describe.skipIf(CHROME === null)('typing a comment while a lead edits the doc', () => {
  beforeAll(() => {
    const r = spawnSync('bun', [DRIVER], { encoding: 'utf8', timeout: SPAWN_MS });
    expect(r.status, r.stderr).toBe(0);
    run = JSON.parse(r.stdout.trim().split('\n').pop() ?? '') as LeadVerbsRun;
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

        it('keeps every word typed, in the box and not in the doc', () => {
          for (const st of scenario(width, kind).steps) {
            expect(st.after.text, st.where).toBe(st.typed);
            expect(st.after.leaked, st.where).toEqual([]);
          }
        });

        it('holds the commented words and the box on the pixel they were on', () => {
          for (const st of scenario(width, kind).steps) {
            // The whole reading on failure, so a CI red can be diagnosed from
            // its log alone.
            const seen = JSON.stringify({ before: st.before, landed: st.landed, after: st.after });
            expect(st.before.anchorTop, st.where).not.toBeNull();
            const anchor = (st.landed.anchorTop ?? Number.NaN) - (st.before.anchorTop ?? 0);
            expect(Math.abs(anchor), `${st.where}: words ${anchor}px ${seen}`).toBeLessThanOrEqual(
              STILL_PX,
            );
            // A box the reader typed into while the edit landed may have
            // grown by those keys; the words it is about may not move.
            if (st.typedThrough) continue;
            // A box scrolled wholly off the top is not where the reader is
            // looking; the margin may restack it (25px, measured offscreen).
            if ((st.before.boxBottom ?? 0) < 0) continue;
            const box = (st.landed.boxTop ?? Number.NaN) - (st.before.boxTop ?? 0);
            const bottom = (st.landed.boxBottom ?? Number.NaN) - (st.before.boxBottom ?? 0);
            // The margin lifts a reply box that the reader's own typing grew
            // past the fold, so its footer stays on screen (fit-to-fold,
            // redline/markup-margin.ts), and it does so at the next layout,
            // which the edit triggers. Measured at 4x CPU throttle: the box
            // rose 7 to 17px with its bottom ending at the fold (716px), never
            // lower. So a box may rise if its bottom did not move down. A box
            // that moved down did not make room for the reader's words.
            const lifted = box < 0 && bottom <= STILL_PX;
            expect(
              Math.abs(box) <= STILL_PX || lifted,
              `${st.where}: box top ${box}px, bottom ${bottom}px ${seen}`,
            ).toBe(true);
          }
        });

        it('keeps the diagram above the commented words drawn', () => {
          const s = scenario(width, kind);
          const drawn = s.opened.diagramHeight ?? 0;
          expect(drawn).toBeGreaterThan(50);
          for (const st of s.steps) {
            expect(Math.abs((st.after.diagramHeight ?? 0) - drawn), st.where).toBeLessThanOrEqual(
              STILL_PX,
            );
          }
        });
      });
    }
  }

  it('ran every edit in every scenario', () => {
    expect(run?.scenarios.map((s) => `${s.width} ${s.kind}`)).toEqual([
      '1180 new',
      '1180 reply',
      '430 new',
      '430 reply',
    ]);
    for (const s of run?.scenarios ?? []) {
      expect(s.steps.map((st) => st.where)).toEqual(LEAD_EDIT_ORDER);
    }
  });
});
