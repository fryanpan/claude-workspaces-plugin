/**
 * Typing a comment while a lead edits the doc with the verbs a lead sends
 * keeps the caret, every word and the reader's place, at 1180x820 and
 * 430x932, for a new comment and for a reply. The driver,
 * `comment-focus-lead-verbs-driver.ts`, runs them in headless Chromium
 * against a real server and the real doc bundle; these cases assert on the
 * JSON it prints.
 *
 * Positive control, measured on 39c9398d0 (before this fix): the lead's first
 * outline read gives every block its id in one update, and the page took that
 * as a change to the whole document. At 430 the reply card was dropped and
 * re-added, focus went to `body`, and the reader's next words were typed into
 * the doc. At 1180 the diagram was redrawn empty (312px to 0) and the
 * commented words moved 312px up. Separately, at 1180 a suggestion landing or
 * being accepted rebuilt the reply card, and a space or a whole phrase of the
 * reply was lost, so the next word ran on.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
import type { LeadVerbsRun, LeadVerbsScenario } from './comment-focus-lead-verbs-reading.ts';
import type { ComposerKind } from './comment-focus-remote-edit-reading.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

const DRIVER = join(import.meta.dirname, 'comment-focus-lead-verbs-driver.ts');
/** Two bundle builds, four launches, four page loads and twenty-eight edits. */
const SUITE_MS = 300_000;
const SPAWN_MS = 290_000;

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
            expect(st.before.anchorTop, st.where).not.toBeNull();
            const anchor = (st.landed.anchorTop ?? Number.NaN) - (st.before.anchorTop ?? 0);
            expect(Math.abs(anchor), `${st.where}: words ${anchor}px`).toBeLessThanOrEqual(
              STILL_PX,
            );
            const box = (st.landed.boxTop ?? Number.NaN) - (st.before.boxTop ?? 0);
            // The whole reading on failure: one run in six moved the reply
            // box 152px on set-content at 1180 (4 Nov) and five did not.
            const seen = JSON.stringify({ before: st.before, landed: st.landed, after: st.after });
            expect(Math.abs(box), `${st.where}: box ${box}px ${seen}`).toBeLessThanOrEqual(
              STILL_PX,
            );
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
    expect(run?.scenarios.map((s) => `${s.width} ${s.kind} ${s.steps.length}`)).toEqual([
      '1180 new 7',
      '1180 reply 7',
      '430 new 7',
      '430 reply 7',
    ]);
  });
});
