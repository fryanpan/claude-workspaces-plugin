/**
 * While a person speaks, the line of what voice has heard shows their newest
 * words and holds still. `lead-chat-heard-browser-driver.ts` feeds a growing
 * transcript at 1180x820 and 430x932, in the Voice first bar and the Chat
 * first status, and reads the line's layout; these cases assert on its JSON.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
import type { HeardRun } from './lead-chat-heard-browser-driver.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

const DRIVER = join(import.meta.dirname, 'lead-chat-heard-browser-driver.ts');
/** Two bundle builds, four launches, four page loads. */
const SUITE_MS = 180_000;
const SPAWN_MS = 175_000;

let runs: HeardRun[] = [];

describe.skipIf(CHROME === null)('the heard line in a browser', () => {
  beforeAll(() => {
    const r = spawnSync('bun', [DRIVER], { encoding: 'utf8', timeout: SPAWN_MS });
    expect(r.status, r.stderr).toBe(0);
    runs = JSON.parse(r.stdout.trim().split('\n').pop() ?? '') as HeardRun[];
  }, SUITE_MS);

  it('covers the bar and the status at both sizes', () => {
    expect(runs.map((r) => `${r.place}@${r.width}`)).toEqual([
      'bar@1180',
      'status@1180',
      'bar@430',
      'status@430',
    ]);
  }, 60_000);

  it('keeps the newest word inside the line at every step of the growth', () => {
    for (const r of runs) {
      for (const s of r.steps) {
        expect(s.lastVisible, `${r.place}@${r.width} ${s.word}`).toBe(true);
        expect(s.labelVisible, `${r.place}@${r.width} ${s.word}`).toBe(true);
      }
    }
  }, 60_000);

  it('lets the transcript outgrow the line, so the case above tests something', () => {
    for (const r of runs) {
      expect(r.steps.at(0)?.firstVisible, `${r.place}@${r.width}`).toBe(true);
      expect(r.steps.at(-1)?.firstVisible, `${r.place}@${r.width}`).toBe(false);
    }
  }, 60_000);

  it('keeps the line and the chat around it the same size and place as the text grows', () => {
    for (const r of runs) {
      for (const s of r.steps) {
        expect(s.line, `${r.place}@${r.width} ${s.word}`).toEqual(r.idle.line);
        expect(s.around, `${r.place}@${r.width} ${s.word}`).toEqual(r.idle.around);
      }
    }
  }, 60_000);

  it('starts a short transcript at the same place, and fades the left edge only once words are cut', () => {
    for (const r of runs) {
      const left = r.steps[0]?.firstLeft;
      for (const s of r.steps) {
        const at = `${r.place}@${r.width} ${s.word}`;
        if (s.firstVisible) {
          expect(s.firstLeft, at).toBe(left);
          expect(s.fade, at).toBe('none');
        } else {
          expect(s.fade, at).not.toBe('none');
        }
      }
    }
  }, 60_000);

  it('measures the fade again when the chat narrows between words', () => {
    const narrowed = runs.find((r) => r.narrowed)?.narrowed;
    expect(narrowed?.before.fade).toBe('none');
    expect(narrowed?.after.firstVisible).toBe(false);
    expect(narrowed?.after.lastVisible).toBe(true);
  }, 60_000);
});
