/**
 * A link in a doc to something that waits on the reader carries one steady
 * mark after it, distinct from the task's status chip: a task with an open
 * review item, and a mock an open item is about. A plain task's link has
 * none. Following the marked task link lands on its review queue, and
 * answering the item elsewhere takes the mark off the open page within 1s
 * with the link left where it was. At 1180x820 and 430x932.
 * `doc-review-marks-browser-driver.ts` drives the page against a real server;
 * these cases assert on its JSON.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
// Types only: importing a value would run the driver in this process.
import type { LinkRead, ReviewMarksRun } from './doc-review-marks-browser-driver.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

const DRIVER = join(import.meta.dirname, 'doc-review-marks-browser-driver.ts');
/** One bundle build, two launches, five page loads. */
const SUITE_MS = 200_000;
const SPAWN_MS = 190_000;

let run: ReviewMarksRun | null = null;
const result = (): ReviewMarksRun => {
  if (!run) throw new Error('the driver printed nothing');
  return run;
};

/** The first class of each element drawn after a link. */
const drawn = (read: LinkRead | null): string[] =>
  (read ?? []).map((c) => c.split(' ')[0] ?? '').filter((c) => c.startsWith('ws-'));

describe.skipIf(CHROME === null)('the needs-review mark on links in a doc', () => {
  beforeAll(() => {
    const r = spawnSync('bun', [DRIVER], {
      encoding: 'utf8',
      timeout: SPAWN_MS,
      env: { ...process.env },
    });
    expect(r.status, r.stderr).toBe(0);
    run = JSON.parse(r.stdout.trim().split('\n').pop() ?? '') as ReviewMarksRun;
  }, SUITE_MS);

  it('runs at both sizes', () => {
    expect(result().widths.map((w) => w.width)).toEqual([1180, 430]);
  }, 60_000);

  it('marks the waiting task after its chip, the mock alone, and the plain task not at all', () => {
    for (const w of result().widths) {
      expect(drawn(w.links.waiting), `${w.width} waiting`).toEqual([
        'ws-status-chip',
        'ws-review-mark',
      ]);
      // Positive control for the chip: the plain task has one, and no mark.
      expect(drawn(w.links.plain), `${w.width} plain`).toEqual(['ws-status-chip']);
      expect(drawn(w.links.mock), `${w.width} mock`).toEqual(['ws-review-mark']);
    }
  }, 60_000);

  it('lands on the review queue when the task is opened from its link', () => {
    const landing = result().widths.at(-1)?.landing;
    const fromLink = landing?.fromLink;
    const plainOpen = landing?.plainOpen;
    expect(fromLink?.opened).toContain('focus=review');
    expect(plainOpen?.opened).not.toContain('focus=review');
    // Control: opened plainly, the queue sits below the fold, so landing on
    // it is something the reader would see.
    expect(plainOpen?.queueTop ?? 0).toBeGreaterThan(plainOpen?.viewport ?? 0);
    expect(fromLink?.queueTop ?? -1).toBeGreaterThanOrEqual(0);
    expect(fromLink?.queueTop ?? Number.POSITIVE_INFINITY).toBeLessThan(
      (fromLink?.viewport ?? 0) / 2,
    );
  }, 60_000);

  it('takes the mark off the open page within 1s of the answer, and nothing moves', () => {
    const live = result().widths.at(-1)?.live;
    expect(live?.droppedInTime).toBe(true);
    expect(drawn(live?.waiting ?? null)).toEqual(['ws-status-chip']);
    // The mock's item is still open: its mark stays.
    expect(drawn(live?.mock ?? null)).toEqual(['ws-review-mark']);
    expect(live?.boxBefore).not.toBeNull();
    expect(live?.boxAfter).toBe(live?.boxBefore);
  }, 60_000);
});
