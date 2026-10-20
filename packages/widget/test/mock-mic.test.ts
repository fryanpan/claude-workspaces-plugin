/**
 * A mock's own `getUserMedia`: where it gets a microphone, and where Chrome
 * refuses it.
 *
 * `mock-mic-driver.ts` serves one small mock that asks for the microphone on
 * load, from a real board server into headless Chromium with the fake
 * microphone and the fake permission prompt. The CONTROL is the same HTML
 * served unsandboxed on loopback, which must get a stream: a refusal in the
 * frame is then the frame, not the browser or its flags.
 *
 * The board's own frame has an opaque origin (no `allow-same-origin`, see
 * `server/src/mockup-frame.ts`), and Chrome refuses the call there with
 * "Invalid security origin" although the frame says `allow="microphone"` and
 * is a secure context. On the frame-only hostname (`server/src/frame-host.ts`)
 * the frame has an origin of its own, never the board's, and the call
 * succeeds.
 *
 * audit: no-text — the driver reads a running page; nothing here reads a
 * source file, a bundle or a stylesheet.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
// Types only: importing a value would run the driver in this process.
import type { MicReading } from './mock-mic-driver.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

const DRIVER = join(import.meta.dirname, 'mock-mic-driver.ts');
/** A widget build, three servers, one launch and three pages. */
const SUITE_MS = 120_000;
const SPAWN_MS = 110_000;

let reading: MicReading;

describe.skipIf(CHROME === null)("a served mock's own getUserMedia", () => {
  beforeAll(() => {
    const r = spawnSync('bun', [DRIVER], { encoding: 'utf8', timeout: SPAWN_MS });
    expect(r.status, r.stderr).toBe(0);
    const last = r.stdout.trim().split('\n').at(-1) ?? '';
    reading = JSON.parse(last) as MicReading;
  }, SUITE_MS);

  it('CONTROL: the same mock, unsandboxed in its own tab, gets a stream', () => {
    expect(reading.control?.result).toBe('ok:1');
  });

  it("is refused in the board's opaque frame, whatever its allow attribute says", () => {
    expect(reading.framed, 'the frame never reported').not.toBeNull();
    expect(reading.framed?.origin).toBe('null');
    expect(reading.framed?.secure).toBe(true);
    expect(reading.framed?.result).toBe('refused:SecurityError: Invalid security origin');
  });

  it("gets a stream in a frame on the frame-only hostname, which is not the board's origin", () => {
    expect(reading.frameHost?.result).toBe('ok:1');
    expect(reading.frameHost?.origin).toMatch(/^http:\/\/frames\.localhost:\d+$/);
  });
});
