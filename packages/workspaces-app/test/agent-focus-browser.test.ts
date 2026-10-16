/**
 * The planning voice's cursor on open doc pages: when the voice asks about
 * some of a long plan's words, a page at 1180x820 and one at 430x932 each
 * scroll there and highlight them, for the first question and the next.
 * `agent-focus-browser-driver.ts` does it in headless Chromium against a real
 * server and the real doc bundle; these cases assert on the JSON it prints.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
import type { AgentFocusRun } from './agent-focus-browser-reading.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

const DRIVER = join(import.meta.dirname, 'agent-focus-browser-driver.ts');
/** Two bundle builds, two launches, four page loads, two questions. */
const SUITE_MS = 200_000;
const SPAWN_MS = 190_000;

let run: AgentFocusRun | null = null;
const result = (): AgentFocusRun => {
  if (!run) throw new Error('the driver printed nothing');
  return run;
};

describe.skipIf(CHROME === null)('the agent’s cursor on open doc pages', () => {
  beforeAll(() => {
    const r = spawnSync('bun', [DRIVER], { encoding: 'utf8', timeout: SPAWN_MS });
    expect(r.status, r.stderr).toBe(0);
    run = JSON.parse(r.stdout.trim().split('\n').pop() ?? '') as AgentFocusRun;
  }, SUITE_MS);

  it('starts with both pages at the top, booted from their own copy, nothing highlighted', () => {
    const { before, cached } = result();
    expect(cached).toBe(true);
    for (const width of ['1180', '430']) {
      expect(before[width]).toMatchObject({ highlighted: null, inView: false, editorScrollTop: 0 });
    }
  });

  it('each question scrolls both pages to its words and highlights them', () => {
    const { steps } = result();
    expect(steps.map((s) => s.serverQuote)).toEqual([
      'Saltmarsh pontoon',
      'Who signs off the berth design?',
    ]);
    for (const step of steps) {
      for (const width of ['1180', '430']) {
        expect(step.views[width], `${width}: ${step.serverQuote}`).toMatchObject({
          highlighted: step.serverQuote,
          caret: 'Claude',
          inView: true,
          windowScrollY: 0,
        });
        expect(step.views[width]?.editorScrollTop).toBeGreaterThan(0);
      }
    }
  });
});
