/**
 * An app speaking in its frame on a mock's page, and the page itself
 * speaking, while the lead chat listens: nothing it says reaches the lead as
 * a request, and the reader's own question afterwards does (9 Nov).
 *
 * `lead-chat-voice-app-speech-browser-driver.ts` drives a real server, the
 * real bundles and headless Chromium with a fake microphone; these cases
 * assert on the JSON it prints.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
// Types only: importing a value would run the driver in this process.
import type { AppSpeechRun } from './lead-chat-voice-app-speech-browser-driver.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

const DRIVER = join(import.meta.dirname, 'lead-chat-voice-app-speech-browser-driver.ts');
const SUITE_MS = 200_000;
const SPAWN_MS = 190_000;

let run: AppSpeechRun | null = null;
const result = (): AppSpeechRun => {
  if (!run) throw new Error('the driver printed nothing');
  return run;
};

describe.skipIf(CHROME === null)('the lead chat listening while an app speaks', () => {
  beforeAll(() => {
    const r = spawnSync('bun', [DRIVER], { encoding: 'utf8', timeout: SPAWN_MS });
    expect(r.status, r.stderr).toBe(0);
    run = JSON.parse(r.stdout.trim().split('\n').pop() ?? '') as AppSpeechRun;
  }, SUITE_MS);

  it('runs a line from the mock in its frame and one from the page', () => {
    expect(result().cases.map((c) => c.source)).toEqual(['frame', 'page']);
  });

  it('sends silence while the line plays, and keeps the question open', () => {
    for (const c of result().cases) {
      expect(c.framesDuring, c.source).toBeGreaterThan(0);
      expect(c.soundDuring, c.source).toBe(0);
    }
  });

  it('files nothing the app said', () => {
    for (const c of result().cases) expect(c.appFiled, c.source).toBe(false);
  });

  it("hears the reader again after the line, and files the reader's question", () => {
    for (const c of result().cases) {
      expect(c.soundAfter, c.source).toBeGreaterThanOrEqual(10);
      expect(c.readerFiled, c.source).toBe(true);
    }
  });
});
