/**
 * A served mock speaks a line and hears a reply end its turn, through the app
 * voice socket, in a real browser: the opaque frame, the host page's relay
 * and the server's session, with a scripted voice and listener
 * (`app-voice-mock-driver.ts`).
 *
 * audit: no-text — the driver reads a running server and page; nothing here
 * reads a source file, a bundle or a stylesheet.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
// Types only: importing a value would run the driver in this process.
import type { AppVoiceMockReading } from './app-voice-mock-driver.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

const DRIVER = join(import.meta.dirname, 'app-voice-mock-driver.ts');
/** A widget build, a server, one launch and one page load. */
const SUITE_MS = 120_000;
const SPAWN_MS = 110_000;

let reading: AppVoiceMockReading;

describe.skipIf(CHROME === null)('a served mock that talks', () => {
  beforeAll(() => {
    const r = spawnSync('bun', [DRIVER], { encoding: 'utf8', timeout: SPAWN_MS });
    expect(r.status, r.stderr).toBe(0);
    const last = r.stdout.trim().split('\n').at(-1) ?? '';
    reading = JSON.parse(last) as AppVoiceMockReading;
  }, SUITE_MS);

  it('runs in a frame with an opaque origin, and opened the socket', () => {
    expect(reading.mock?.error).toBeNull();
    expect(reading.mock?.origin).toBe('null');
    expect(reading.mock?.abilities).toEqual({ voice: 'scripted', listen: true, say: false });
  });

  it('speaks a line with a tone and is sent its speech', () => {
    expect(reading.spoken).toEqual(['Welcome to Riverbend.']);
    expect(reading.mock?.spoken).toEqual({ stopped: false });
    expect(reading.mock?.audioBytes).toBe(960);
  });

  it("hears the reply end its turn from the mock's own audio", () => {
    expect(reading.heardFrames).toBe(2);
    expect(reading.mock?.turnEnd).toBe('I think so.');
  });
});
