/**
 * Every page and tab of a board has its own address, so a reload and a shared
 * link land on what was on screen. `board-tabs-browser-driver.ts` walks them
 * in a real browser at 1180x820 and 430x932; these cases read its JSON.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
// Types only: importing a value would run the driver in this process.
import type { BoardTabsRun } from './board-tabs-browser-driver.ts';

const CHROME = chromeForSuite();
const DRIVER = join(import.meta.dirname, 'board-tabs-browser-driver.ts');

let run: BoardTabsRun | null = null;
const result = (): BoardTabsRun => {
  if (!run) throw new Error('the driver printed nothing');
  return run;
};

describe.skipIf(CHROME === null)('every tab has its own address', () => {
  beforeAll(() => {
    const r = spawnSync('bun', [DRIVER], { encoding: 'utf8', timeout: 180_000 });
    expect(r.status, r.stderr).toBe(0);
    run = JSON.parse(r.stdout.trim().split('\n').pop() ?? '') as BoardTabsRun;
  }, 190_000);

  it('gives each tab the address that names it', () => {
    const { workspaceId, taskId, goalId, steps } = result();
    const B = `/workspaces/${workspaceId}`;
    for (const width of [1180, 430]) {
      const at = Object.fromEntries(
        steps.filter((s) => s.width === width).map((s) => [s.name, s.address]),
      );
      expect(at).toEqual({
        home: `${B}/home`,
        tasks: B,
        library: `${B}/library`,
        'library files': `${B}/library?list=files`,
        activity: `${B}/activity`,
        'task comments': `${B}?task=${taskId}`,
        'task activity': `${B}?task=${taskId}&tab=activity`,
        goal: `${B}?goal=${goalId}`,
        settings: `${B}?settings=${width > 1100 ? 'board' : 'list'}`,
        'settings notifications': `${B}?settings=notifications`,
        'settings prompts': `${B}?settings=prompts`,
      });
    }
  }, 60_000);

  it('shows the tab, and shows it again after a reload at the same address', () => {
    for (const s of result().steps) {
      const name = `${s.width} ${s.name}`;
      expect(s.shown, name).toBe(true);
      expect(s.reloaded, name).toBe(s.address);
      expect(s.shownAfterReload, name).toBe(true);
    }
  }, 60_000);
});
