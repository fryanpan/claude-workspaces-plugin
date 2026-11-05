/**
 * Listening may stay switched on in several tabs, and only one hears the
 * reader (Bryan, 4 Nov: "only the tab that I'm actively on should be
 * listening to me, or the last one that I was on").
 *
 * Two board tabs with listening on: while one is in front only it sends its
 * microphone up; with another tab in front, so that neither is focused, only
 * the one in front last sends. The other keeps listening switched on and
 * shows that it is paused. At 1180x820 and 430x932.
 * `lead-chat-voice-tabs-browser-driver.ts` drives a real server and the real
 * bundles; these cases assert on its JSON.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
// Types only: importing a value would run the driver in this process.
import type { VoiceTabsRun } from './lead-chat-voice-tabs-browser-driver.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

const DRIVER = join(import.meta.dirname, 'lead-chat-voice-tabs-browser-driver.ts');
/** One bundle build, two launches, four page loads. */
const SUITE_MS = 250_000;
const SPAWN_MS = 240_000;

let run: VoiceTabsRun | null = null;
const result = (): VoiceTabsRun => {
  if (!run) throw new Error('the driver printed nothing');
  return run;
};

describe.skipIf(CHROME === null)('listening on in two tabs', () => {
  beforeAll(() => {
    const r = spawnSync('bun', [DRIVER], { encoding: 'utf8', timeout: SPAWN_MS });
    expect(r.status, r.stderr).toBe(0);
    run = JSON.parse(r.stdout.trim().split('\n').pop() ?? '') as VoiceTabsRun;
  }, SUITE_MS);

  it('runs at both sizes, with each tab in front and then neither', () => {
    const r = result();
    expect(r.cases.map((c) => `${c.width} ${c.phases.map((p) => p.front).join(',')}`)).toEqual([
      '1180 A,B,none',
      '430 A,B,none',
    ]);
  });

  it('keeps listening switched on in both tabs throughout', () => {
    for (const c of result().cases)
      for (const p of c.phases) {
        expect(p.a.listening, `${c.width} ${p.front} A`).toBe(true);
        expect(p.b.listening, `${c.width} ${p.front} B`).toBe(true);
      }
  });

  it('sends speech only from the tab in front, or the one in front last', () => {
    for (const c of result().cases)
      for (const p of c.phases) {
        const at = `${c.width}, ${p.front} in front: A sent ${p.framesA}, B sent ${p.framesB}`;
        // With the blank tab in front, B was the board tab in front last.
        const hears = p.front === 'A' ? 'A' : 'B';
        expect(hears === 'A' ? p.framesA : p.framesB, at).toBeGreaterThan(0);
        expect(hears === 'A' ? p.framesB : p.framesA, at).toBe(0);
      }
  });

  it('shows the tab that does not hear as paused, and the one that hears as not', () => {
    for (const c of result().cases)
      for (const p of c.phases) {
        const hears = p.front === 'A' ? 'A' : 'B';
        const [on, off] = hears === 'A' ? [p.a, p.b] : [p.b, p.a];
        const at = `${c.width}, ${p.front} in front`;
        expect(on.paused, at).toBe(false);
        expect(off.paused, at).toBe(true);
        expect(`${off.bar} ${off.status}`, at).toMatch(/Paused/);
        expect(`${on.bar} ${on.status}`, at).not.toMatch(/Paused/);
      }
  });
});
