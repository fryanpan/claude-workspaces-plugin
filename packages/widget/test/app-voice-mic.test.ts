/**
 * A voice-led mock on its board page, tapped to listen through the reader's
 * microphone: where the mock hears them, and what it is told where it cannot.
 *
 * `app-voice-mic-driver.ts` serves one mock from real board servers into
 * headless Chromium with the fake microphone and the fake permission prompt,
 * with a scripted listener that ends a turn after a few frames of audio.
 *
 * The board's own frame has an opaque origin, and Chrome refuses the
 * microphone there whatever the frame's `allow` says (`mock-mic.test.ts`
 * measures the bare call, with an unsandboxed CONTROL). The CONTROL here is
 * that the same frame's `connect()` succeeds, so the refusal is the
 * microphone and not the token, the socket or the relay. On the frame-only
 * hostname (`server/src/frame-host.ts`) the frame has an origin of its own,
 * never the board's, and the reader's audio reaches the server and the turn
 * comes back.
 *
 * audit: no-text — the driver reads a running server and page; nothing here
 * reads a source file, a bundle or a stylesheet.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
import { OPAQUE_MIC_REFUSAL } from '../src/voice/voice-audio.ts';
// Types only: importing a value would run the driver in this process.
import type { AppVoiceMicReading } from './app-voice-mic-driver.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

const DRIVER = join(import.meta.dirname, 'app-voice-mic-driver.ts');
/** Two widget builds, two servers, one launch and three pages. */
const SUITE_MS = 120_000;
const SPAWN_MS = 110_000;

/** The scripted listener's turn, as `app-voice-mic-driver.ts` says it. */
const HEARD = 'Riverbend first, then Saltmarsh.';

let reading: AppVoiceMicReading;

describe.skipIf(CHROME === null)('a voice-led mock listening on its board page', () => {
  beforeAll(() => {
    const r = spawnSync('bun', [DRIVER], { encoding: 'utf8', timeout: SPAWN_MS });
    expect(r.status, r.stderr).toBe(0);
    const last = r.stdout.trim().split('\n').at(-1) ?? '';
    reading = JSON.parse(last) as AppVoiceMicReading;
  }, SUITE_MS);

  it("CONTROL: connects in the board's opaque frame", () => {
    expect(reading.opaque.mock?.origin).toBe('null');
    expect(reading.opaque.mock?.error).toBeNull();
    expect(reading.opaque.mock?.connected).toBe(true);
  });

  it("is refused the microphone in the board's opaque frame, and told it is the frame", () => {
    expect(reading.opaque.mock?.listen).toBe(`refused:Error: ${OPAQUE_MIC_REFUSAL}`);
    expect(reading.opaque.heardFrames).toBe(0);
  });

  it("hears the reader on the frame-only hostname, which is not the board's origin", () => {
    expect(reading.frameHost.mock?.origin).toMatch(/^http:\/\/harborlight\.frames\.localhost:\d+$/);
    expect(reading.frameHost.mock?.listen).toBe('ok');
    expect(reading.frameHost.heardFrames).toBeGreaterThanOrEqual(3);
    expect(reading.frameHost.mock?.turnEnd).toBe(HEARD);
  });

  it("has no own tab on the board: the frame's address opened at the top goes back to the board's page", () => {
    expect(reading.ownTab?.landed).toMatch(/^\/workspaces\/[^/]+\/mockups\/[^/?]+$/);
    expect(reading.ownTab?.mock).toBeNull();
  });
});
