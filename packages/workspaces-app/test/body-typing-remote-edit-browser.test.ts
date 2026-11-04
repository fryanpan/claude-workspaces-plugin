/**
 * Typing in the doc body while an agent edits the doc keeps the caret in the
 * same words, keeps focus in the editor and keeps the typed words on their
 * pixel. `body-typing-remote-edit-driver.ts` does it in headless Chromium
 * against a real server and the real doc bundle, at 1180x820 and at 430x932
 * with touch emulation, with the agent's edits going through the REST routes
 * the MCP tools call; these cases assert on the JSON it prints.
 *
 * Positive control: with the doc bundle built from b6139328e (main before
 * the fix), 6 of these 23 cases fail. The caret sits 60% down the pane. At
 * 1180 a block replaced between the pane's top edge and the caret moved the
 * typed words 77px, and a block deleted there moved them 136px up, because
 * the hold kept the topmost line still and nothing between it and the caret.
 * At 430 an insert above moved them 300px: the sync plugin scrolled the
 * pushed caret back to the pane's edge, and the hold took that as the reader
 * scrolling. A burst of four edits moved them 78px at 1180 and 280px at 430.
 * With only the scroll guard removed, the three 430 cases still fail.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
import {
  type BodyRun,
  type BodyScenario,
  CARET_AFTER,
  CARET_BEFORE,
} from './body-typing-remote-edit-page.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

const DRIVER = join(import.meta.dirname, 'body-typing-remote-edit-driver.ts');
/** Two bundle builds, four launches, four page loads and eighteen edits. */
const SUITE_MS = 260_000;
const SPAWN_MS = 250_000;

/** Sub-pixel layout and rounding: a line that moved by less has not moved. */
const STILL_PX = 2;

let run: BodyRun | null = null;
const scenario = (width: number, mode: BodyScenario['mode']): BodyScenario => {
  if (!run) throw new Error('the driver printed nothing');
  const s = run.scenarios.find((x) => x.width === width && x.mode === mode);
  if (!s) throw new Error(`no ${width} ${mode} scenario`);
  return s;
};

describe.skipIf(CHROME === null)('typing in the doc while an agent edits it', () => {
  beforeAll(() => {
    const r = spawnSync('bun', [DRIVER], { encoding: 'utf8', timeout: SPAWN_MS });
    expect(r.status, r.stderr).toBe(0);
    run = JSON.parse(r.stdout.trim().split('\n').pop() ?? '') as BodyRun;
  }, SUITE_MS);

  for (const width of [1180, 430]) {
    for (const mode of ['one-by-one', 'burst'] as const) {
      describe(`${width}px, edits ${mode === 'burst' ? 'in a burst under a second' : 'one by one'}`, () => {
        it('the editor held the caret before any edit', () => {
          const s = scenario(width, mode);
          expect(s.opened.focus).toBe('doc');
          expect(s.opened.beforeCaret?.endsWith(CARET_AFTER)).toBe(true);
        });

        it('keeps focus in the editor through every edit', () => {
          for (const st of scenario(width, mode).steps) {
            expect(st.landed.focus, st.where).toBe('doc');
            expect(st.after.focus, st.where).toBe('doc');
          }
          expect(scenario(width, mode).final.focus).toBe('doc');
        });

        it('keeps the caret right after the words typed', () => {
          for (const st of scenario(width, mode).steps) {
            const tail = (CARET_AFTER + st.typed).slice(-30);
            expect(
              st.after.beforeCaret?.endsWith(tail),
              `${st.where}: ${st.after.beforeCaret}`,
            ).toBe(true);
          }
        });

        it('keeps every typed character, in place', () => {
          const s = scenario(width, mode);
          for (const st of s.steps) {
            expect(st.after.para, st.where).toContain(`${CARET_AFTER}${st.typed}${CARET_BEFORE}`);
          }
          expect(s.final.para).toContain(`${CARET_AFTER}${s.typed}${CARET_BEFORE}`);
        });

        it('holds the typed words on the pixel they were on', () => {
          for (const st of scenario(width, mode).steps) {
            expect(st.before.wordsTop, st.where).not.toBeNull();
            const moved = (st.landed.wordsTop ?? Number.NaN) - (st.before.wordsTop ?? 0);
            expect(Math.abs(moved), `${st.where}: ${moved}px`).toBeLessThanOrEqual(STILL_PX);
          }
        });

        if (mode === 'one-by-one') {
          it('holds the caret on its pixel', () => {
            for (const st of scenario(width, mode).steps) {
              expect(st.before.caretTop, st.where).not.toBeNull();
              const moved = (st.landed.caretTop ?? Number.NaN) - (st.before.caretTop ?? 0);
              expect(Math.abs(moved), `${st.where}: ${moved}px`).toBeLessThanOrEqual(STILL_PX);
            }
          });
        }
      });
    }
  }

  it('ran every edit in every scenario', () => {
    expect(run?.scenarios.map((s) => `${s.width} ${s.mode} ${s.steps.length}`)).toEqual([
      '1180 one-by-one 7',
      '1180 burst 1',
      '430 one-by-one 7',
      '430 burst 1',
    ]);
  });
});
