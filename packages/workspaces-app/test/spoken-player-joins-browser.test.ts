/**
 * A spoken reply's joins, rendered by a real browser's audio engine: the same
 * voice pushed whole and pushed in chunks must render to the same samples at
 * the context rates a phone runs at. `OfflineAudioContext` renders without a
 * speaker, so nothing is played.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
import type { JoinRun } from './spoken-player-joins-browser-driver.ts';

const CHROME = chromeForSuite();
const DRIVER = join(import.meta.dirname, 'spoken-player-joins-browser-driver.ts');
const SUITE_MS = 120_000;
const SPAWN_MS = 115_000;

let runs: JoinRun[] = [];

describe.skipIf(CHROME === null)('spoken reply joins in a real audio engine', () => {
  beforeAll(() => {
    const r = spawnSync('bun', [DRIVER], { encoding: 'utf8', timeout: SPAWN_MS });
    expect(r.status, r.stderr).toBe(0);
    runs = JSON.parse(r.stdout.trim().split('\n').pop() ?? '[]') as JoinRun[];
  }, SUITE_MS);

  it('renders chunked speech with no click at any join', () => {
    expect(runs.length).toBeGreaterThan(0);
    for (const run of runs) {
      expect(run.peakDifference, JSON.stringify(run)).toBeLessThan(0.001);
      // A control: the voice really was rendered.
      expect(run.peak, JSON.stringify(run)).toBeGreaterThan(0.3);
    }
  }, 60_000);
});
