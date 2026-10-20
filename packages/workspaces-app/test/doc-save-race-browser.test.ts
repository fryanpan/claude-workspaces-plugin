/**
 * A slow device reloads an offline doc inside the 800ms the copy's full save
 * waits: the words typed just before survive the reload and reach the server
 * exactly once. `doc-save-race-browser-driver.ts` does it in headless
 * Chromium against a real server and the real doc bundle; these cases assert
 * on the JSON it prints.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
import { PERSIST_DELAY_MS } from '../src/doc-cache.ts';
import type { SaveRaceRun } from './doc-save-race-browser-reading.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

const DRIVER = join(import.meta.dirname, 'doc-save-race-browser-driver.ts');
/** Two bundle builds, one launch, and per try a cut, a slowed reload and a
 *  server boot, with room for each try to be run again once. */
const SUITE_MS = 470_000;
const SPAWN_MS = 460_000;
/** The tries the driver runs by default, each until one lands in the window. */
const TRIES = 5;

let run: SaveRaceRun | null = null;
const result = (): SaveRaceRun => {
  if (!run) throw new Error('the driver printed nothing');
  return run;
};

describe.skipIf(CHROME === null)('an offline doc reloaded right after typing on a slow CPU', () => {
  beforeAll(() => {
    const r = spawnSync('bun', [DRIVER], { encoding: 'utf8', timeout: SPAWN_MS });
    expect(r.status, r.stderr).toBe(0);
    run = JSON.parse(r.stdout.trim().split('\n').pop() ?? '') as SaveRaceRun;
  }, SUITE_MS);

  it('every cut was real: the probe that reached the server online failed offline', () => {
    const { probeOnline, probesOffline, tries } = result();
    expect(probeOnline).toBe('reached');
    expect(probesOffline.length).toBeGreaterThan(tries.length);
    expect(probesOffline.every((p) => p === 'failed')).toBe(true);
  });

  it('every try reloaded inside the save window at some slowdown, words on screen', () => {
    // The precondition of the race, not a speed claim: a reload after the
    // full save would pass with the bug still in place, so a try outside the
    // window is run again slowed less, and only tries inside it count.
    const { tries, cpuSlowdown } = result();
    expect(cpuSlowdown).toBe(25);
    const inside = tries.filter((t) => t.inWindow);
    expect(inside).toHaveLength(TRIES);
    for (const t of inside) {
      expect(t.onScreenBeforeReload, t.words).toBe(true);
      expect(t.typedToReloadMs, t.words).toBeLessThan(PERSIST_DELAY_MS);
    }
  });

  it('the words survive the offline reload, every try inside the window', () => {
    const lost = result().tries.filter((t) => t.inWindow && !t.shownAfterReload);
    expect(lost.map((t) => `${t.words} at ${t.cpuSlowdown}x`)).toEqual([]);
  });

  it('once online the words reach the file exactly once, and were not there while offline', () => {
    for (const t of result().tries) {
      expect(t.inFileWhileOffline, t.words).toBe(0);
      // Never twice, inside the window or not; once, for every try that counts.
      expect(t.inFileAfterOnline, t.words).toBeLessThanOrEqual(1);
      if (t.inWindow) expect(t.inFileAfterOnline, t.words).toBe(1);
    }
  });

  it('a session answering as somebody else clears the copy and its appended edits', () => {
    const {
      appendedBeforeIdentityChange,
      appendedAfterIdentityChange,
      oldCopyAfterIdentityChange,
    } = result();
    // The control: the edits were in the copy before the change.
    expect(appendedBeforeIdentityChange).toBeGreaterThan(0);
    expect(appendedAfterIdentityChange).toBe(0);
    expect(oldCopyAfterIdentityChange).toBe(false);
  });
});
