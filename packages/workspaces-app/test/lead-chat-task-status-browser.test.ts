/**
 * A task link in the lead's reply shows the task's status the way the
 * board's own row for that task does: the same element, the same class, the
 * same drawn ring (Bryan's board task: chat task links read their status in
 * the board's style). On the board at 1180x820 and 430x932.
 * `lead-chat-task-status-browser-driver.ts` drives the page against a real
 * server; these cases assert on its JSON.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
// Types only: importing a value would run the driver in this process.
import type { TaskStatusRun } from './lead-chat-task-status-browser-driver.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

const DRIVER = join(import.meta.dirname, 'lead-chat-task-status-browser-driver.ts');
/** One bundle build, two launches, two page loads. */
const SUITE_MS = 200_000;
const SPAWN_MS = 190_000;
const STATUSES = ['in-progress', 'todo'] as const;

let run: TaskStatusRun | null = null;
const result = (): TaskStatusRun => {
  if (!run) throw new Error('the driver printed nothing');
  return run;
};

describe.skipIf(CHROME === null)('a task link in the lead’s reply', () => {
  beforeAll(() => {
    const r = spawnSync('bun', [DRIVER], { encoding: 'utf8', timeout: SPAWN_MS });
    expect(r.status, r.stderr).toBe(0);
    run = JSON.parse(r.stdout.trim().split('\n').pop() ?? '') as TaskStatusRun;
  }, SUITE_MS);

  it('runs at both sizes', () => {
    expect(result().widths.map((w) => w.width)).toEqual([1180, 430]);
  }, 60_000);

  it('carries the board row’s status element, with the same class', () => {
    for (const w of result().widths) {
      for (const status of STATUSES) {
        const board = w.board[status];
        // Positive control: the board row draws the mark this test compares to.
        expect(board?.className, `${w.width} ${status} board`).toBe(
          `board-status-mark board-status-mark-${status}`,
        );
        expect(w.chat[status]?.className, `${w.width} ${status} chat`).toBe(board?.className);
      }
    }
  }, 60_000);

  it('draws the same ring the board row draws', () => {
    for (const w of result().widths) {
      for (const status of STATUSES) {
        expect(w.chat[status]?.style, `${w.width} ${status}`).toEqual(w.board[status]?.style);
      }
      // The two statuses must look different, or equal rings prove nothing.
      expect(w.board['in-progress']?.style).not.toEqual(w.board.todo?.style);
    }
  }, 60_000);
});
