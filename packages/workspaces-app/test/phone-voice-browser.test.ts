/**
 * Voice to the lead from a phone: at 430x932 with touch input, a finger tap
 * on the agent button opens the chat listening and the microphone's audio
 * reaches the server. The page runs under a model of iOS Safari's rule that
 * an AudioContext starts only from `resume()` inside the tap
 * (`phone-voice-browser-driver.ts` explains the model and its limits).
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
import type { PhoneVoiceRun } from './phone-voice-browser-driver.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

const DRIVER = join(import.meta.dirname, 'phone-voice-browser-driver.ts');
/** Two bundle builds, one launch, one page load. */
const SUITE_MS = 180_000;
const SPAWN_MS = 175_000;

let run: PhoneVoiceRun | null = null;
const result = (): PhoneVoiceRun => {
  if (!run) throw new Error('the driver printed nothing');
  return run;
};

describe.skipIf(CHROME === null)('voice to the lead from a phone', () => {
  beforeAll(() => {
    const r = spawnSync('bun', [DRIVER], { encoding: 'utf8', timeout: SPAWN_MS });
    expect(r.status, r.stderr).toBe(0);
    run = JSON.parse(r.stdout.trim().split('\n').pop() ?? '') as PhoneVoiceRun;
  }, SUITE_MS);

  it('a finger tap starts the microphone context inside the tap', () => {
    const { audio } = result();
    expect(audio.made).toBeGreaterThanOrEqual(2);
    // Every context the page kept was started inside the tap. One made after
    // it, at the mic's rate, may be tried and let go (`graphContext`).
    expect(audio.discarded).toBeLessThanOrEqual(1);
    expect(audio.resumedInTap).toBe(audio.made - audio.discarded);
  }, 60_000);

  it('the microphone audio reaches the server and the chat is still listening', () => {
    const r = result();
    expect(r.framesHeard, r.status).toBeGreaterThan(0);
    expect(r.listening, r.status).toBe(true);
  }, 60_000);
});
