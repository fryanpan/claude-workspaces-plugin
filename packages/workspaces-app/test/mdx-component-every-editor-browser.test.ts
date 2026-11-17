/**
 * A component an agent saves runs in the real doc page: it draws on the
 * already-open page with no commit and no reload, takes the doc's type and
 * the board's colours, and a reader can select its words and comment on
 * them at 1180x820 and at 430 wide. The save-to-page time is printed.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
import type { EveryEditorReading } from './mdx-component-every-editor-driver.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

const SUITE_MS = 200_000;
const SPAWN_MS = 180_000;
const CASE_MS = 60_000;

let r: EveryEditorReading;

describe.skipIf(CHROME === null)('every editor’s component on the doc page', () => {
  beforeAll(() => {
    const run = spawnSync(
      'bun',
      [join(import.meta.dirname, 'mdx-component-every-editor-driver.ts')],
      { encoding: 'utf8', timeout: SPAWN_MS },
    );
    expect(run.status, run.stderr).toBe(0);
    r = JSON.parse(run.stdout.trim().split('\n').at(-1) ?? '') as EveryEditorReading;
    console.log(`[component agent save, browser] ${r.agentSaveToPageMs} ms`);
  }, SUITE_MS);

  it(
    'draws a component an agent saved on the already-open page',
    () => {
      expect(r.drawn).toBe('Riverbend high water at noon');
      expect(r.agentSaveToPageMs).toBeGreaterThan(0);
    },
    CASE_MS,
  );

  it(
    'takes the doc’s type and the board’s colours',
    () => {
      expect(r.theme.font).toBe(r.theme.docFont);
      expect(r.theme.color).toBe(r.theme.docColor);
      expect(r.theme.accent).toBe(r.theme.boardAccent);
      expect(r.theme.accent).not.toBe(r.theme.color);
    },
    CASE_MS,
  );

  it(
    'takes a comment on words the component drew, at both widths',
    () => {
      for (const [at, words] of [
        [r.wide, 'high water'],
        [r.narrow, 'at noon'],
      ] as const) {
        expect(at.pill).toBe(true);
        expect(at.quote).toBe(words);
        expect(at.snippet).toBe(words);
        expect(at.highlighted).toBe('<Tide label="Riverbend" />');
        expect(at.sourceOpen).toBe(true);
      }
      expect([r.wide.viewport, r.narrow.viewport]).toEqual([1180, 430]);
    },
    CASE_MS,
  );
});
