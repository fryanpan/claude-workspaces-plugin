/**
 * Two people drawing on one whiteboard with touch, one tab at 1180x820 and
 * one at 430 wide. `whiteboard-browser-driver.ts` does it in headless
 * Chromium against a real server and the real whiteboard bundle; these cases
 * assert on the JSON it prints.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
import type { WhiteboardRun } from './whiteboard-browser-reading.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

const DRIVER = join(import.meta.dirname, 'whiteboard-browser-driver.ts');
/** One bundle build, one launch, one server, two page loads. */
const SUITE_MS = 200_000;
const SPAWN_MS = 190_000;

let run: WhiteboardRun | null = null;
const result = (): WhiteboardRun => {
  if (!run) throw new Error('the driver printed nothing');
  return run;
};

describe.skipIf(CHROME === null)('two people drawing on one whiteboard with touch', () => {
  beforeAll(() => {
    const r = spawnSync('bun', [DRIVER], { encoding: 'utf8', timeout: SPAWN_MS });
    expect(r.status, r.stderr).toBe(0);
    run = JSON.parse(r.stdout.trim().split('\n').pop() ?? '') as WhiteboardRun;
    process.stderr.write(`[whiteboard-browser] ${JSON.stringify(run.tabs)}\n`);
  }, SUITE_MS);

  for (const width of [1180, 430]) {
    it(`a pen stroke at ${width} wide draws and reaches the other tab`, () => {
      const tab = result().tabs.find((t) => t.width === width);
      expect(tab).toBeDefined();
      expect(tab?.drewElements).toBe(1);
      expect(tab?.otherTabSaw).toBe(1);
    });

    it(`the page at ${width} wide neither scrolls nor zooms under the pen`, () => {
      const tab = result().tabs.find((t) => t.width === width);
      expect(tab?.scrollAfter).toEqual([0, 0]);
      expect(tab?.scrollBefore).toEqual([0, 0]);
      expect(tab?.scaleAfter).toBe(tab?.scaleBefore);
      expect(tab?.scaleAfter).toBe(1);
    });
  }

  it('the server keeps both strokes as freehand strokes', () => {
    expect(result().storedKinds.filter((k) => k === 'freedraw')).toHaveLength(2);
  });
});
