/**
 * Dragging onto the composer outlines it without moving it, a drop attaches
 * chips, and a send shows thumbnails here and in a tab already open. At
 * 1180x820 and 430x932. `lead-chat-composer-browser-driver.ts` drives a real
 * server and the real bundles; these cases assert on its JSON.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
// Types only: importing a value would run the driver in this process.
import type { ComposerRun } from './lead-chat-composer-browser-driver.ts';

const CHROME = chromeForSuite();
const DRIVER = join(import.meta.dirname, 'lead-chat-composer-browser-driver.ts');
const SUITE_MS = 180_000;
const SPAWN_MS = 170_000;

let run: ComposerRun | null = null;
const cases = () => {
  if (!run) throw new Error('the driver printed nothing');
  return run.cases;
};

describe.skipIf(CHROME === null)('the composer, in a real browser', () => {
  beforeAll(() => {
    const r = spawnSync('bun', [DRIVER], { encoding: 'utf8', timeout: SPAWN_MS });
    expect(r.status, r.stderr).toBe(0);
    run = JSON.parse(r.stdout.trim().split('\n').pop() ?? '') as ComposerRun;
  }, SUITE_MS);

  it('runs at both sizes', () => {
    expect(cases().map((c) => c.width)).toEqual([1180, 430]);
  }, 60_000);

  it('outlines on a drag without moving or resizing the composer', () => {
    for (const c of cases()) {
      expect(c.dragged, String(c.width)).toEqual(c.rest);
      expect(c.outline, String(c.width)).toBe('dashed');
    }
  }, 60_000);

  it('attaches a drop as chips, and they can be sent with no words', () => {
    for (const c of cases()) {
      expect(c.chips, String(c.width)).toBe(2);
      expect(c.sendEnabledWithNoWords, String(c.width)).toBe(true);
    }
  }, 60_000);

  it('shows the sent photo and file, here and in a tab already open', () => {
    for (const c of cases()) {
      expect(c.sent, String(c.width)).toEqual({ thumbs: 1, loaded: true, files: 1 });
      expect(c.otherTab, String(c.width)).toMatchObject({ thumbs: 1, files: 1 });
    }
  }, 60_000);

  it('keeps the row in place and in bounds, whatever the chip says', () => {
    for (const c of cases()) {
      expect(c.row, String(c.width)).toEqual([
        'Add photos or files',
        expect.stringContaining('Lead model'),
        'Talk',
        'Send',
      ]);
      expect(c.rowOverflows, String(c.width)).toBe(false);
      expect(c.chipOpenedNothing, String(c.width)).toBe(true);
      expect(c.chipAfter, String(c.width)).toEqual(c.chipBefore);
      expect(c.chipText, String(c.width)).toContain('Sonnet 5.5');
    }
  }, 60_000);
});
