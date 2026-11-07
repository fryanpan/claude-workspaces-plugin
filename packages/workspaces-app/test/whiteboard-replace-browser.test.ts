/**
 * An agent replaces a whiteboard while a person is dragging everything on it.
 * `whiteboard-replace-browser-driver.ts` does it in headless Chromium with the
 * real canvas; these cases assert on the JSON it prints.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
import type { ReplaceRun } from './whiteboard-replace-browser-driver.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

const DRIVER = join(import.meta.dirname, 'whiteboard-replace-browser-driver.ts');
/** One bundle build, one launch, one server, one page load. */
const SUITE_MS = 200_000;
const SPAWN_MS = 190_000;

let run: ReplaceRun | null = null;
const result = (): ReplaceRun => {
  if (!run) throw new Error('the driver printed nothing');
  return run;
};

describe.skipIf(CHROME === null)('replacing a whiteboard during a drag', () => {
  beforeAll(() => {
    const r = spawnSync('bun', [DRIVER], { encoding: 'utf8', timeout: SPAWN_MS });
    expect(r.status, r.stderr).toBe(0);
    run = JSON.parse(r.stdout.trim().split('\n').pop() ?? '') as ReplaceRun;
    process.stderr.write(`[whiteboard-replace-browser] ${JSON.stringify(run)}\n`);
  }, SUITE_MS);

  it('the board holds exactly what the agent drew after the person lets go', () => {
    expect(result().ids).toEqual(['fresh', 'heading', 'kept']);
    expect(result().kept).toMatchObject({ x: 40, y: 300, text: 'Harborlight' });
    expect(result().count).toBe(5);
  });

  it('the words of a kept box stay in that box', () => {
    expect(result().labelInBox).toBe(true);
    expect(result().tabLabelInk).toBeGreaterThan(0);
  });

  it('a heading drawn with a width keeps it on a real canvas, and its words fit', () => {
    expect(result().headingWidth).toBe(640);
    expect(result().headingInk).toBeLessThan(640);
  });

  it('the tab shows the same board, not the drag it was holding', () => {
    expect(result().tabElements).toBe(result().count);
  });
});
