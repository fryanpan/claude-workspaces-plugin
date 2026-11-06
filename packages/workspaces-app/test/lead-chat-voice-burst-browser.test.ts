/**
 * Four spoken answers back to back on one open doc page all play, in order,
 * whole (Bryan, 4 Nov: "your voice answers are not playing").
 *
 * `lead-chat-voice-burst-browser-driver.ts` drives a real server and the real
 * bundles; these cases assert on its JSON, which it reads from the page's own
 * audio graph.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
// Types only: importing a value would run the driver in this process.
import type { BurstCase, BurstRun } from './lead-chat-voice-burst-browser-driver.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

const DRIVER = join(import.meta.dirname, 'lead-chat-voice-burst-browser-driver.ts');
const SUITE_MS = 300_000;
const SPAWN_MS = 290_000;
/** The audio clock's rounding between one chunk's end and the next's start. */
const CLOCK_SLACK_S = 0.001;

let run: BurstRun | null = null;
const result = (): BurstRun => {
  if (!run) throw new Error('the driver printed nothing');
  return run;
};
const name = (c: BurstCase): string => `${c.way} at ${c.width}`;

describe.skipIf(CHROME === null)('four spoken answers back to back', () => {
  beforeAll(() => {
    const r = spawnSync('bun', [DRIVER], { encoding: 'utf8', timeout: SPAWN_MS });
    expect(r.status, r.stderr).toBe(0);
    run = JSON.parse(r.stdout.trim().split('\n').pop() ?? '') as BurstRun;
  }, SUITE_MS);

  it('runs each way at both sizes, with four delivered answers inside two seconds', () => {
    const r = result();
    expect(r.cases.map(name)).toEqual([
      'quiet at 1180',
      'slow at 1180',
      'talking at 1180',
      'quiet at 430',
      'slow at 430',
      'talking at 430',
    ]);
    for (const c of r.cases) {
      expect(c.delivered, name(c)).toEqual([true, true, true, true]);
      expect(c.sentWithinMs, name(c)).toBeLessThan(2000);
    }
  });

  it('plays every answer whole, in the order sent', () => {
    const r = result();
    for (const c of r.cases) {
      const order = [...c.chunks].sort((a, b) => a.at - b.at).map((x) => x.answer);
      expect(order, name(c)).toEqual([1, 2, 3, 4].flatMap((n) => Array(r.chunksPerAnswer).fill(n)));
      expect(
        c.chunks.filter((x) => !x.ended || x.stopped),
        name(c),
      ).toEqual([]);
    }
  });

  it('never plays two answers over each other', () => {
    for (const c of result().cases) {
      const rows = [...c.chunks].sort((a, b) => a.at - b.at);
      for (const [i, row] of rows.entries()) {
        const next = rows[i + 1];
        if (next) {
          expect(next.at, `${name(c)} chunk ${i}`).toBeGreaterThanOrEqual(
            row.at + row.seconds - CLOCK_SLACK_S,
          );
        }
      }
    }
  });

  it('listens again once the last answer has played', () => {
    for (const c of result().cases) expect(c.listensAgain, name(c)).toBe(true);
  });
});
